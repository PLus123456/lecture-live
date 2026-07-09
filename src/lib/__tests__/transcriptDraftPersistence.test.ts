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

const { mockFiles } = vi.hoisted(() => ({ mockFiles: new Map<string, string>() }));

vi.mock('fs/promises', () => {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    default: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (p: string, data: string) => {
        mockFiles.set(p, data);
      }),
      readFile: vi.fn(async (p: string) => {
        if (!mockFiles.has(p)) throw enoent();
        return mockFiles.get(p)!;
      }),
      access: vi.fn(async (p: string) => {
        if (!mockFiles.has(p)) throw enoent();
      }),
      rm: vi.fn(async (p: string) => {
        for (const k of Array.from(mockFiles.keys())) {
          if (k.startsWith(p)) mockFiles.delete(k);
        }
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
});
