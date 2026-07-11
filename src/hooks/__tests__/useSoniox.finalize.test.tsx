/**
 * useSoniox.finalizeRemoteDraft 负向测试。
 *
 * 覆盖：
 *  - P0-5 契约2：完整性用「集合包含 [0..maxSeq]」而非数量比较。local=[0,1]/remote=[0,9]
 *    数量相等但缺 seq 1 → 不完整：**绝不** seal、**绝不** POST finalize、返回 false（保留草稿）。
 *    旧的数量判断会误判完整并 POST finalize，随后清库丢尾块。
 *  - P1-7 契约3：完整时先 SEAL（?phase=seal）再 finalize；finalize 返回 409（服务端检出缺口/
 *    终态）视为需重试，返回 false，不吞数据。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const make = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: make(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: make(),
    configurable: true,
    writable: true,
  });
});

vi.mock('@/lib/soniox/client', () => ({
  buildSonioxConfig: vi.fn(() => ({})),
  startSonioxRecording: vi.fn(async () => ({
    recording: { stop: vi.fn(), pause: vi.fn(), resume: vi.fn() },
    client: {},
  })),
}));

vi.mock('@/lib/audio/recordingArchiveManager', () => ({
  RecordingArchiveManager: class {
    setChunkStoredHandler() {}
    setCaptureEndedHandler() {}
    async ensureArchive() {}
    async getSenderStream() {
      return {} as MediaStream;
    }
    async resume() {}
    async pause() {}
    async stop() {}
    ensureSeqAbove() {}
    hasLiveCapture() {
      return false;
    }
  },
}));

// 本地 IDB：由每个用例通过 setLocalEntries 注入 seq 列表。
const localEntriesRef: { entries: Array<{ seq: number; blob: Blob }> } = {
  entries: [],
};
vi.mock('@/lib/audio/audioChunkStore', () => ({
  getAllAudioChunks: vi.fn(async () => []),
  getArchiveMimeType: vi.fn(async () => 'audio/webm'),
  getAudioChunkEntries: vi.fn(async () => localEntriesRef.entries),
  hasAudioChunks: vi.fn(async () => localEntriesRef.entries.length > 0),
}));

import { useSoniox } from '@/hooks/useSoniox';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useAuthStore } from '@/stores/authStore';

function setLocalEntries(seqs: number[]) {
  localEntriesRef.entries = seqs.map((seq) => ({
    seq,
    blob: new Blob(['x']),
  }));
}

type FetchCall = { url: string; method: string };
const fetchCalls: FetchCall[] = [];

/** 按 URL/方法/查询参数路由的 fetch 桩。 */
function installFetch(opts: {
  draftSeqs: number[]; // GET /audio/draft 返回的远端 seq
  chunkUploadOk: boolean; // POST /audio/draft/chunks 是否成功（补传）
  sealStatus: number; // POST finalize?phase=seal 状态码
  finalizeStatus: number; // POST finalize 状态码
}) {
  const mock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchCalls.push({ url, method });

    const json = (body: unknown, status = 200) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        headers: { get: () => null },
      }) as unknown as Response;

    if (url.includes('/audio/draft/finalize')) {
      if (url.includes('phase=seal')) {
        return json({ success: true }, opts.sealStatus);
      }
      return json(
        opts.finalizeStatus === 409 ? { hasGap: true } : { success: true },
        opts.finalizeStatus
      );
    }
    if (url.includes('/audio/draft/chunks')) {
      // negotiateStartSeq 的 GET（本测试不触发 start）/ 补传 POST
      return json({ success: true }, opts.chunkUploadOk ? 200 : 500);
    }
    if (url.includes('/audio/draft')) {
      // GET 远端已收 seq 清单
      return json({ seqs: opts.draftSeqs }, 200);
    }
    return json({}, 200);
  });
  vi.stubGlobal('fetch', mock);
}

beforeEach(() => {
  fetchCalls.length = 0;
  useAuthStore.setState({ token: 'test-token' } as never);
  useTranscriptStore.setState({
    recordingState: 'recording',
    backupMeta: {
      syncState: 'idle',
      localChunkCount: 0,
      remoteChunkCount: 0,
      updatedAt: 0,
      lastError: null,
    },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('P0-5：数量相等但集合缺片 → 不完整，绝不 finalize', () => {
  it('local=[0,1] / remote=[0,9]，seq1 补传失败：finalizeRemoteDraft 返回 false 且从不 seal/finalize', async () => {
    setLocalEntries([0, 1]);
    installFetch({
      draftSeqs: [0, 9],
      chunkUploadOk: false, // 补传 seq1 失败（持续 429/断网）→ 远端仍缺 1
      sealStatus: 200,
      finalizeStatus: 200,
    });

    const { result } = renderHook(() => useSoniox('sess-incomplete'));

    let complete: boolean | undefined;
    await act(async () => {
      complete = await result.current.finalizeRemoteDraft();
    });

    expect(complete).toBe(false);
    // 关键：绝不能调用任何 finalize（含 seal 与正式 finalize）—— 否则会把部分音频定稿 + 清库。
    const finalizeCalls = fetchCalls.filter((c) =>
      c.url.includes('/audio/draft/finalize')
    );
    expect(finalizeCalls).toHaveLength(0);
  });
});

describe('P1-7：完整时先 seal 再 finalize；finalize 409 视为需重试', () => {
  it('local=[0,1] / remote=[0,1] 完整：seal 在 finalize 之前，且 finalize 409 → 返回 false 不吞数据', async () => {
    setLocalEntries([0, 1]);
    installFetch({
      draftSeqs: [0, 1],
      chunkUploadOk: true,
      sealStatus: 200,
      finalizeStatus: 409, // 服务端合并阶段检出缺口/终态
    });

    const { result } = renderHook(() => useSoniox('sess-seal-409'));

    let complete: boolean | undefined;
    await act(async () => {
      complete = await result.current.finalizeRemoteDraft();
    });

    expect(complete).toBe(false);

    const finalizeSeq = fetchCalls
      .filter((c) => c.url.includes('/audio/draft/finalize'))
      .map((c) => (c.url.includes('phase=seal') ? 'seal' : 'finalize'));
    // seal 必须存在且排在 finalize 之前（两阶段收尾栅栏）。
    expect(finalizeSeq[0]).toBe('seal');
    expect(finalizeSeq).toContain('finalize');
    expect(finalizeSeq.indexOf('seal')).toBeLessThan(finalizeSeq.indexOf('finalize'));
  });

  it('完整且 finalize 200：返回 true（happy path，seal→finalize 顺序）', async () => {
    setLocalEntries([0, 1]);
    installFetch({
      draftSeqs: [0, 1],
      chunkUploadOk: true,
      sealStatus: 200,
      finalizeStatus: 200,
    });

    const { result } = renderHook(() => useSoniox('sess-seal-ok'));

    let complete: boolean | undefined;
    await act(async () => {
      complete = await result.current.finalizeRemoteDraft();
    });

    expect(complete).toBe(true);
    const finalizeSeq = fetchCalls
      .filter((c) => c.url.includes('/audio/draft/finalize'))
      .map((c) => (c.url.includes('phase=seal') ? 'seal' : 'finalize'));
    expect(finalizeSeq).toEqual(['seal', 'finalize']);
  });
});
