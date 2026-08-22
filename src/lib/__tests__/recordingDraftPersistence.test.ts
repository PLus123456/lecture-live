import fs from 'fs/promises';
import type { PathLike } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerHarness = vi.hoisted(() => {
  class PublishConflictError extends Error {}
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
    PublishConflictError,
    OutcomeUnknownError,
  };
});

vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: {
    RESERVED: 'RESERVED',
    ACTIVE: 'ACTIVE',
    DELETE_PENDING: 'DELETE_PENDING',
  },
  STORED_ARTIFACT_TYPE: { RECORDING_DRAFT: 'recording_draft' },
  StoredArtifactPublishConflictError: ledgerHarness.PublishConflictError,
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
  settleStoredArtifact: vi.fn(
    async (id: string, publication: Record<string, unknown>) => {
      const row = ledgerHarness.rows.get(id)!;
      const previous = ledgerHarness.active.get(row.logicalKey) ?? null;
      if (
        Object.hasOwn(publication, 'expectedPreviousArtifactId') &&
        (previous?.id ?? null) !== publication.expectedPreviousArtifactId
      ) {
        throw new ledgerHarness.PublishConflictError();
      }
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

// 每个测试前重新解析模块，并将 cwd 指向独立的临时目录，
// 确保 DRAFTS_ROOT (process.cwd()/data/recording-drafts) 互不干扰。
async function loadModule(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return import('@/lib/recordingDraftPersistence');
}

describe('recordingDraftPersistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    ledgerHarness.reset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-draft-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const session = { id: 'sess-1', userId: 'user-1' };
  const mkChunk = (seq: number) =>
    Buffer.from(`chunk-${String(seq).padStart(4, '0')}`);

  it('顺序写入的 seq 都能被 manifest 保留', async () => {
    const mod = await loadModule(tmpDir);
    for (const seq of [0, 1, 2, 3, 4]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('并发写入不会因为 manifest 竞态丢失 seq', async () => {
    const mod = await loadModule(tmpDir);
    const seqs = Array.from({ length: 50 }, (_, i) => i);
    await Promise.all(
      seqs.map((seq) =>
        mod.persistRecordingDraftChunk(session, {
          seq,
          mimeType: 'audio/webm',
          data: mkChunk(seq),
        })
      )
    );
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual(seqs);
    const scanned = await mod.listRecordingDraftSeqs(session);
    expect(scanned).toEqual(seqs);
  });

  it('即使 manifest.json 丢失了部分 seq 记录，也能从磁盘恢复', async () => {
    const mod = await loadModule(tmpDir);
    for (const seq of [0, 1, 2, 3]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    // 模拟历史版本写入的陈旧 manifest（receivedSeqs 只记录了部分 seq）
    const manifestPath = path.join(
      tmpDir,
      'data',
      'recording-drafts',
      'sess-1',
      'manifest.json'
    );
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        sessionId: 'sess-1',
        userId: 'user-1',
        mimeType: 'audio/webm',
        createdAt: 1,
        updatedAt: 2,
        receivedSeqs: [0, 2],
      }),
      'utf-8'
    );
    const manifest = await mod.loadRecordingDraftManifest(session);
    // scanChunkSeqsOnDisk 应忽略 manifest 里陈旧的 receivedSeqs，用磁盘扫描结果
    expect(manifest?.receivedSeqs).toEqual([0, 1, 2, 3]);
  });

  it('mergeRecordingDraftChunks 按 seq 升序拼接全部 chunk', async () => {
    const mod = await loadModule(tmpDir);
    const seqs = [2, 0, 4, 1, 3];
    for (const seq of seqs) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged).not.toBeNull();
    expect(merged!.buffer.toString('utf-8')).toBe(
      'chunk-0000chunk-0001chunk-0002chunk-0003chunk-0004'
    );
    expect(merged!.manifest.receivedSeqs).toEqual([0, 1, 2, 3, 4]);
    expect(merged!.hasGap).toBe(false);
  });

  it('seq 空洞时只合并连续前缀并标记 hasGap（不静默拼出损坏音频）', async () => {
    const mod = await loadModule(tmpDir);
    // 写入 0,1,3,4，缺中间的 seq 2
    for (const seq of [0, 1, 3, 4]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged).not.toBeNull();
    // 只拼接连续前缀 0,1（遇 seq 2 空洞即停），丢弃空洞后的 3,4
    expect(merged!.buffer.toString('utf-8')).toBe('chunk-0000chunk-0001');
    expect(merged!.hasGap).toBe(true);
  });

  it('P0-4 append-only：同一 seq 内容不同 → 抛冲突且绝不覆盖已有分片', async () => {
    const mod = await loadModule(tmpDir);
    const first = await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: Buffer.from('original-header'),
    });
    expect(first.idempotent).toBe(false);

    await expect(
      mod.persistRecordingDraftChunk(session, {
        seq: 0,
        mimeType: 'audio/webm',
        data: Buffer.from('DIFFERENT-header-overwrite'),
      })
    ).rejects.toBeInstanceOf(mod.RecordingDraftChunkConflictError);

    // 磁盘上的 seq 0 仍是最初内容（旧代码会被无条件覆盖 → 冷设备续录毁掉录音开头）。
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged!.buffer.toString('utf-8')).toBe('original-header');
  });

  it('P0-4 append-only：同一 seq 内容相同 → 幂等成功（网络重试）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 3,
      mimeType: 'audio/webm',
      data: mkChunk(3),
    });
    const retry = await mod.persistRecordingDraftChunk(session, {
      seq: 3,
      mimeType: 'audio/webm',
      data: mkChunk(3),
    });
    expect(retry.idempotent).toBe(true);
    // P1-6：幂等重传不重复计数；权威 seq 集合仍以磁盘为准。
    expect(retry.chunkCount).toBe(1);
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual([3]);
  });

  it('P0-4 清单摘要 nextSeq = maxSeq+1；无草稿时 maxSeq=-1/nextSeq=0', async () => {
    const mod = await loadModule(tmpDir);
    const empty = await mod.getRecordingDraftManifestSummary(session);
    expect(empty).toMatchObject({ maxSeq: -1, nextSeq: 0, sealed: false });

    for (const seq of [0, 1, 2]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const summary = await mod.getRecordingDraftManifestSummary(session);
    expect(summary.maxSeq).toBe(2);
    expect(summary.nextSeq).toBe(3);
    expect(summary.sealed).toBe(false);
    expect(summary.revision).toBeGreaterThan(0);
  });

  it('P0-5 leading gap：缺首块 seq 0（seqs[0]!==0）必须 hasGap=true', async () => {
    const mod = await loadModule(tmpDir);
    // 只有 seq 1,2（缺 seq 0）——旧代码 expected=seqs[0]=1，会误判 hasGap=false。
    for (const seq of [1, 2]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged).not.toBeNull();
    expect(merged!.hasGap).toBe(true);
    // 从 seq 0 起无连续前缀 → 合并结果为空，不得当作完整录音。
    expect(merged!.buffer.length).toBe(0);
  });

  it('P1-7 seal 后拒绝任何新分片写入（迟到写 → 抛 sealed）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });
    const summary = await mod.sealRecordingDraft(session);
    expect(summary.sealed).toBe(true);
    expect(await mod.isRecordingDraftSealed(session)).toBe(true);

    await expect(
      mod.persistRecordingDraftChunk(session, {
        seq: 1,
        mimeType: 'audio/webm',
        data: mkChunk(1),
      })
    ).rejects.toBeInstanceOf(mod.RecordingDraftSealedError);

    // 迟到写未落盘：磁盘仍只有 seq 0。
    expect(await mod.listRecordingDraftSeqs(session)).toEqual([0]);
  });

  it('P1-7 unseal 释放封存：seal 后 unseal 可再次写入（补传缺片重试收尾）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });
    await mod.sealRecordingDraft(session);
    expect(await mod.isRecordingDraftSealed(session)).toBe(true);

    await mod.unsealRecordingDraft(session);
    expect(await mod.isRecordingDraftSealed(session)).toBe(false);

    // 解封后可补传之前缺失的分片。
    const after = await mod.persistRecordingDraftChunk(session, {
      seq: 1,
      mimeType: 'audio/webm',
      data: mkChunk(1),
    });
    expect(after.chunkCount).toBe(2);
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual([0, 1]);
  });

  it('P1-6 写入热路径不再每片 readdir 全目录（维护式计数，O(1)）', async () => {
    const mod = await loadModule(tmpDir);
    const readdirSpy = vi.spyOn(fs, 'readdir');
    for (const seq of [0, 1, 2, 3, 4]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    // 旧实现每片都 scanChunkSeqsOnDisk → 5 次 readdir（4h 录音累计 O(n²)）；
    // 新实现仅首片元数据缺计数时播种一次，其余写入零 readdir。
    expect(readdirSpy.mock.calls.length).toBeLessThanOrEqual(1);
    readdirSpy.mockRestore();
  });

  it('P1-6 流式合并顺序读取分片（不再一次性打开全部 FD）', async () => {
    const mod = await loadModule(tmpDir);
    for (let seq = 0; seq < 30; seq += 1) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }

    let active = 0;
    let maxActive = 0;
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi
      .spyOn(fs, 'readFile')
      .mockImplementation((...args: Parameters<typeof fs.readFile>) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return (originalReadFile as (...a: unknown[]) => Promise<unknown>)(
          ...(args as unknown[])
        ).finally(() => {
          active -= 1;
        }) as ReturnType<typeof fs.readFile>;
      });

    const merged = await mod.mergeRecordingDraftChunks(session);
    readFileSpy.mockRestore();

    expect(merged).not.toBeNull();
    expect(merged!.buffer.length).toBeGreaterThan(0);
    // 旧实现 Promise.all(seqs.map(readFile)) 会让 30 个读并发在飞（maxActive=30，数万分片时 EMFILE）；
    // 新实现逐片顺序读，任一时刻最多 1 个读在飞。
    expect(maxActive).toBe(1);
  });

  // ---------------------------------------------------------------------
  // P7-5：seal TOCTOU —— 分片回写抹掉并发落地的 sealedAt（lost update）
  // ---------------------------------------------------------------------
  it('P7-5 并发 seal 不会被分片回写抹掉（读快照→回写的 lost update）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });

    // 把「分片写回 manifest」这一步拖慢，制造 读快照 → (seal 落地) → 回写 的窗口。
    // 旧实现：回写用的是陈旧快照（无 sealedAt），seal 被整份覆盖抹掉。
    const originalRename = fs.rename.bind(fs);
    let delayedOnce = false;
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockImplementation((async (from: PathLike, to: PathLike) => {
        if (!delayedOnce && String(to).endsWith('manifest.json')) {
          delayedOnce = true;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return originalRename(from, to);
      }) as typeof fs.rename);

    const writing = mod.persistRecordingDraftChunk(session, {
      seq: 1,
      mimeType: 'audio/webm',
      data: mkChunk(1),
    });
    // 让分片写入先进入临界区，再发起 seal（模拟 cron auto-reclaim 与客户端补传撞车）。
    await new Promise((resolve) => setTimeout(resolve, 15));
    const sealing = mod.sealRecordingDraft(session);

    await Promise.allSettled([writing, sealing]);
    renameSpy.mockRestore();

    // seal 必须留存：否则 finalize 之后到达的分片继续落盘，再被 deleteRecordingDraft 连锅端。
    expect(await mod.isRecordingDraftSealed(session)).toBe(true);
    const summary = await mod.getRecordingDraftManifestSummary(session);
    expect(summary.sealed).toBe(true);
    // 栅栏仍然有效：seal 之后的写入被拒。
    await expect(
      mod.persistRecordingDraftChunk(session, {
        seq: 2,
        mimeType: 'audio/webm',
        data: mkChunk(2),
      })
    ).rejects.toBeInstanceOf(mod.RecordingDraftSealedError);
  });

  it('P7-5 seal 不清空维护式计数（chunkCount/maxSeq/totalBytes 原样保留）', async () => {
    const mod = await loadModule(tmpDir);
    for (const seq of [0, 1, 2]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    await mod.sealRecordingDraft(session);
    const usage = await mod.getRecordingDraftUsage(session);
    expect(usage.exists).toBe(true);
    expect(usage.chunkCount).toBe(3);
    expect(usage.totalBytes).toBe(mkChunk(0).length * 3);
  });

  // ---------------------------------------------------------------------
  // P4-1：总字节闸 + 用量读数 + 过期草稿清扫
  // ---------------------------------------------------------------------
  describe('P4-1 草稿总量闸', () => {
    const originalLimit = process.env.RECORDING_DRAFT_MAX_TOTAL_BYTES;

    beforeEach(() => {
      process.env.RECORDING_DRAFT_MAX_TOTAL_BYTES = '2048';
    });

    afterEach(() => {
      if (originalLimit === undefined) {
        delete process.env.RECORDING_DRAFT_MAX_TOTAL_BYTES;
      } else {
        process.env.RECORDING_DRAFT_MAX_TOTAL_BYTES = originalLimit;
      }
    });

    it('写入超过总字节上限时抛 RecordingDraftTooLargeError 且该片不落盘', async () => {
      const mod = await loadModule(tmpDir);
      const big = Buffer.alloc(1024, 1);
      await mod.persistRecordingDraftChunk(session, {
        seq: 0,
        mimeType: 'audio/webm',
        data: big,
      });
      await mod.persistRecordingDraftChunk(session, {
        seq: 1,
        mimeType: 'audio/webm',
        data: big,
      });

      // 第三片会把总量顶到 3072 > 2048：旧代码只有片数闸（50000 片），这里必须直接拒。
      await expect(
        mod.persistRecordingDraftChunk(session, {
          seq: 2,
          mimeType: 'audio/webm',
          data: big,
        })
      ).rejects.toBeInstanceOf(mod.RecordingDraftTooLargeError);

      expect(await mod.listRecordingDraftSeqs(session)).toEqual([0, 1]);
      const usage = await mod.getRecordingDraftUsage(session);
      expect(usage.totalBytes).toBe(2048);
    });

    it('merge 在整份分配前判总量（超限抛错，绝不 allocUnsafe 打爆内存）', async () => {
      const mod = await loadModule(tmpDir);
      // 绕过写入闸直接把超量分片摆到盘上（模拟上调过上限、或旧版本留下的大草稿）。
      const chunksDir = path.join(
        tmpDir,
        'data',
        'recording-drafts',
        'sess-1',
        'chunks'
      );
      await fs.mkdir(chunksDir, { recursive: true });
      for (let seq = 0; seq < 4; seq += 1) {
        await fs.writeFile(
          path.join(chunksDir, `${String(seq).padStart(8, '0')}.chunk`),
          Buffer.alloc(1024, 2)
        );
      }
      await fs.writeFile(
        path.join(tmpDir, 'data', 'recording-drafts', 'sess-1', 'manifest.json'),
        JSON.stringify({
          sessionId: 'sess-1',
          userId: 'user-1',
          mimeType: 'audio/webm',
          createdAt: 1,
          updatedAt: 2,
        }),
        'utf-8'
      );

      await expect(mod.mergeRecordingDraftChunks(session)).rejects.toBeInstanceOf(
        mod.RecordingDraftTooLargeError
      );
    });

    it('getRecordingDraftUsage：无草稿时 exists=false（供路由识别「本会话第一片」）', async () => {
      const mod = await loadModule(tmpDir);
      expect(await mod.getRecordingDraftUsage(session)).toEqual({
        exists: false,
        chunkCount: 0,
        totalBytes: 0,
      });
      await mod.persistRecordingDraftChunk(session, {
        seq: 7,
        mimeType: 'audio/webm',
        data: mkChunk(7),
      });
      const usage = await mod.getRecordingDraftUsage(session);
      expect(usage.exists).toBe(true);
      expect(usage.chunkCount).toBe(1);
    });
  });

  it('P4-1 sweepStaleRecordingDrafts 删掉超龄草稿、保留仍在写的', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(
      { id: 'stale-sess', userId: 'user-1' },
      { seq: 0, mimeType: 'audio/webm', data: mkChunk(0) }
    );
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });

    // 把 stale 会话的 manifest 与目录时间都推到 72 小时前。
    const staleDir = path.join(tmpDir, 'data', 'recording-drafts', 'stale-sess');
    const staleManifestName = (await fs.readdir(staleDir)).find(
      (name) => name.startsWith('manifest-') && name.endsWith('.json')
    );
    expect(staleManifestName).toBeDefined();
    const staleManifest = path.join(staleDir, staleManifestName!);
    const old = Date.now() - 72 * 60 * 60_000;
    const parsed = JSON.parse(await fs.readFile(staleManifest, 'utf-8'));
    await fs.writeFile(
      staleManifest,
      JSON.stringify({ ...parsed, updatedAt: old }),
      'utf-8'
    );
    await fs.utimes(staleDir, new Date(old), new Date(old));

    const result = await mod.sweepStaleRecordingDrafts({ maxAgeMs: 48 * 60 * 60_000 });
    expect(result.removed).toBe(1);
    // 仍在写的会话（CREATED 也算）绝不能被误删。
    expect(await mod.listRecordingDraftSeqs(session)).toEqual([0]);
    expect(
      await mod.listRecordingDraftSeqs({ id: 'stale-sess', userId: 'user-1' })
    ).toEqual([]);
  });

  it('deleteRecordingDraft 同时清掉 manifest 和全部 chunks', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });
    await mod.deleteRecordingDraft(session);
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest).toBeNull();
    const seqs = await mod.listRecordingDraftSeqs(session);
    expect(seqs).toEqual([]);
  });
});
