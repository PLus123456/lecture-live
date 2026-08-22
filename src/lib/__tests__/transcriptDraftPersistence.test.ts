/**
 * transcriptDraftPersistence 单调守卫回归测试（阶段6 转录 draft 防覆盖）。
 *
 * 锁住:更短/重置的 payload 绝不覆盖盘上更完整的草稿(与音频 chunk seq 续号防覆盖对称),
 * 缩水写入落 .conflict 备份、主草稿保持更完整那份。防止「刷新后僵尸录音从 0 段重新 PUT
 * 把整份转录盖成只剩重启后那段」再次发生。
 *
 * 用内存桩替换 fs/promises,避免真写盘。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFiles, mockOpen } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const open = vi.fn(async (p: string) => {
    if (!files.has(p)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    const source = Buffer.from(files.get(p)!, 'utf8');
    let cursor = 0;
    return {
      read: vi.fn(
        async (
          target: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => {
          const start = position ?? cursor;
          const bytesRead = Math.max(
            0,
            Math.min(length, source.byteLength - start)
          );
          if (bytesRead > 0) {
            source.copy(target, offset, start, start + bytesRead);
          }
          if (position === null) {
            cursor += bytesRead;
          }
          return { bytesRead, buffer: target };
        }
      ),
      close: vi.fn(async () => undefined),
    };
  });
  return { mockFiles: files, mockOpen: open };
});

const ledgerHarness = vi.hoisted(() => {
  class OutcomeUnknownError extends Error {}
  type ArtifactRow = Record<string, unknown> & {
    id: string;
    logicalKey: string;
    state: string;
    identityKey: string | null;
    ownerType: string;
    ownerId: string;
    chargedBytes: bigint;
  };
  const rows = new Map<string, ArtifactRow>();
  const active = new Map<string, ArtifactRow>();
  let sequence = 0;
  return {
    rows,
    active,
    reset() {
      rows.clear();
      active.clear();
      sequence = 0;
    },
    nextId() {
      sequence += 1;
      return `artifact-${sequence}`;
    },
    OutcomeUnknownError,
  };
});

vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: {
    RESERVED: 'RESERVED',
    ACTIVE: 'ACTIVE',
    DELETE_PENDING: 'DELETE_PENDING',
  },
  STORED_ARTIFACT_TYPE: { TRANSCRIPT_DRAFT: 'transcript_draft' },
  StoredArtifactPublishOutcomeUnknownError: ledgerHarness.OutcomeUnknownError,
  buildStoredArtifactLogicalKey: vi.fn(
    (ownerType: string, ownerId: string, artifactType: string) =>
      `${ownerType}:${ownerId}:${artifactType}`
  ),
  reserveStoredArtifact: vi.fn(async (input: Record<string, unknown> & {
    logicalKey: string;
    expectedBytes: number;
    ownerType: string;
    ownerId: string;
  }) => {
    const id = ledgerHarness.nextId();
    const previous = ledgerHarness.active.get(input.logicalKey) ?? null;
    const row = {
      ...input,
      id,
      state: 'RESERVED',
      storage: 'pending',
      reference: null,
      bytes: BigInt(input.expectedBytes),
      chargedBytes: BigInt(input.expectedBytes),
      identityKey: null,
      replacesArtifactId: previous?.id ?? null,
      reservationKey: `reservation-${id}`,
    };
    ledgerHarness.rows.set(id, row);
    return row;
  }),
  recordReservedStoredArtifactLocation: vi.fn(
    async (id: string, publication: Record<string, unknown>) => {
      Object.assign(ledgerHarness.rows.get(id)!, publication);
    }
  ),
  settleStoredArtifactsAtomically: vi.fn(
    async (
      inputs: Array<{
        artifactId: string;
        publication: Record<string, unknown>;
      }>
    ) => {
      const planned = inputs.map(({ artifactId, publication }) => {
        const row = ledgerHarness.rows.get(artifactId)!;
        const previous = ledgerHarness.active.get(row.logicalKey) ?? null;
        if (
          Object.hasOwn(publication, 'expectedPreviousArtifactId') &&
          (previous?.id ?? null) !== publication.expectedPreviousArtifactId
        ) {
          throw new Error('publish conflict');
        }
        return { row, previous, publication };
      });
      return planned.map(({ row, previous, publication }) => {
        if (previous) {
          previous.state = 'ORPHANED';
          previous.identityKey = null;
        }
        Object.assign(row, publication, {
          state: 'ACTIVE',
          identityKey: row.logicalKey,
        });
        ledgerHarness.active.set(row.logicalKey, row);
        return { artifact: row, previous };
      });
    }
  ),
  getActiveStoredArtifactByLogicalKey: vi.fn(
    async (logicalKey: string) => ledgerHarness.active.get(logicalKey) ?? null
  ),
  getStoredArtifactById: vi.fn(
    async (id: string) => ledgerHarness.rows.get(id) ?? null
  ),
  rollbackStoredArtifact: vi.fn(async (id: string) => {
    const row = ledgerHarness.rows.get(id);
    if (row) {
      row.state = 'DELETED';
      row.chargedBytes = BigInt(0);
    }
    return true;
  }),
  releaseStoredArtifact: vi.fn(async (id: string) => {
    const row = ledgerHarness.rows.get(id);
    if (row) {
      row.state = 'DELETED';
      row.chargedBytes = BigInt(0);
    }
    return true;
  }),
  findBillableStoredArtifactsByOwner: vi.fn(
    async (ownerType: string, ownerId: string) =>
      Array.from(ledgerHarness.rows.values()).filter(
        (row) =>
          row.ownerType === ownerType &&
          row.ownerId === ownerId &&
          row.chargedBytes > BigInt(0)
      )
  ),
  markStoredArtifactsDeletePending: vi.fn(async (ids: string[]) => {
    for (const id of ids) {
      const row = ledgerHarness.rows.get(id);
      if (row) row.state = 'DELETE_PENDING';
    }
    return ids.map((id) => ledgerHarness.rows.get(id)).filter(Boolean);
  }),
}));

vi.mock('fs/promises', () => {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    default: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (p: string, data: string) => {
        mockFiles.set(p, data);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        if (!mockFiles.has(from)) throw enoent();
        mockFiles.set(to, mockFiles.get(from)!);
        mockFiles.delete(from);
      }),
      readFile: vi.fn(async (p: string) => {
        if (!mockFiles.has(p)) throw enoent();
        return mockFiles.get(p)!;
      }),
      access: vi.fn(async (p: string) => {
        if (!mockFiles.has(p)) throw enoent();
      }),
      stat: vi.fn(async (p: string) => {
        if (!mockFiles.has(p)) throw enoent();
        return {
          size: Buffer.byteLength(mockFiles.get(p)!, 'utf8'),
          isFile: () => true,
        };
      }),
      open: mockOpen,
      rm: vi.fn(async (p: string) => {
        for (const k of Array.from(mockFiles.keys())) {
          if (k.startsWith(p)) mockFiles.delete(k);
        }
      }),
      readdir: vi.fn(async (dir: string) => {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const names = new Set<string>();
        for (const key of mockFiles.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
        return Array.from(names);
      }),
    },
  };
});

import {
  persistTranscriptDraft,
  loadTranscriptDraft,
  loadTranscriptDraftManifest,
  type TranscriptDraftPayload,
} from '@/lib/transcriptDraftPersistence';
import { SESSION_TRANSCRIPT_LIMITS } from '@/lib/sessionApi';

const session = { id: 'sess-1', userId: 'user-1' };

function mkPayload(n: number): TranscriptDraftPayload {
  return {
    segments: Array.from({ length: n }, (_, i) => ({ id: `seg-${i + 1}`, text: `t${i + 1}` })),
    summaries: [],
    translations: {},
    clientTs: 1000 + n,
  };
}

beforeEach(() => {
  mockFiles.clear();
  ledgerHarness.reset();
  vi.clearAllMocks();
});

describe('persistTranscriptDraft 单调守卫（转录 draft 防覆盖）', () => {
  it('更长/等长 payload 正常覆盖主草稿', async () => {
    await persistTranscriptDraft(session, mkPayload(3));
    expect((await loadTranscriptDraftManifest(session))?.segmentCount).toBe(3);

    await persistTranscriptDraft(session, mkPayload(5)); // 更长
    expect((await loadTranscriptDraftManifest(session))?.segmentCount).toBe(5);
    expect((await loadTranscriptDraft(session))?.segments.length).toBe(5);

    await persistTranscriptDraft(session, mkPayload(5)); // 等长也放行
    expect((await loadTranscriptDraftManifest(session))?.segmentCount).toBe(5);
  });

  it('更短/重置 payload 被拒，主草稿保持更完整那份，缩水写入落 .conflict 备份', async () => {
    await persistTranscriptDraft(session, mkPayload(5));

    const result = await persistTranscriptDraft(session, mkPayload(1)); // 僵尸录音式缩水
    // 返回的是现有(更完整)的 manifest，而非缩水的
    expect(result.segmentCount).toBe(5);
    // 主草稿未被覆盖
    expect((await loadTranscriptDraft(session))?.segments.length).toBe(5);
    // 缩水 payload 落到了 .conflict 备份文件
    const conflictKeys = Array.from(mockFiles.keys()).filter((k) =>
      k.includes('transcript.conflict-')
    );
    expect(conflictKeys.length).toBe(1);
  });

  it('首次写入(无现有草稿)不受守卫影响', async () => {
    const result = await persistTranscriptDraft(session, mkPayload(2));
    expect(result.segmentCount).toBe(2);
    expect((await loadTranscriptDraft(session))?.segments.length).toBe(2);
  });

  it('历史超大草稿在打开/读取前即拒绝', async () => {
    await persistTranscriptDraft(session, mkPayload(2));
    const transcriptPath = Array.from(mockFiles.keys()).find(
      (key) => key.includes('/transcript-') && key.endsWith('.json')
    );
    expect(transcriptPath).toBeDefined();
    mockFiles.set(
      transcriptPath!,
      'x'.repeat(SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes + 1)
    );
    mockOpen.mockClear();

    await expect(loadTranscriptDraft(session)).resolves.toBeNull();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  // P4-5：冲突分支每次都写一份**全量**备份且从不清理。构造：顶满 segmentCount 之后，
  // 之后每次少一段的 PUT 必命中冲突分支 → 备份文件无上限增长，而 CREATED 会话永不回收。
  it('P4-5 冲突备份只保留最近 3 份（不再无上限堆积）', async () => {
    // 让每次写入拿到递增的时间戳，避免同毫秒备份重名。
    let clock = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));

    await persistTranscriptDraft(session, mkPayload(10));
    for (let i = 0; i < 8; i += 1) {
      await persistTranscriptDraft(session, mkPayload(9));
    }

    const conflictKeys = Array.from(mockFiles.keys()).filter((k) =>
      k.includes('transcript.conflict-')
    );
    expect(conflictKeys.length).toBe(3);

    // 保留的必须是最近的三份（时间戳最大）。
    const kept = conflictKeys
      .map((k) => Number(k.match(/transcript\.conflict-(\d+)-/)?.[1]))
      .sort((a, b) => a - b);
    expect(kept[0]).toBeGreaterThan(1_700_000_000_000);

    // 主草稿仍是更完整的那份，清理不得伤及正稿。
    expect((await loadTranscriptDraft(session))?.segments.length).toBe(10);
    nowSpy.mockRestore();
  });
});
