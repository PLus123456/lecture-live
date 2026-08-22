// H1：sync_snapshot 体积闸的纯函数层。
//
// 被守护的事故：server/websocket.ts 的 maxHttpBufferSize=100KB 被 engine.io 原样
// 传给 ws 的 maxPayload，超限的帧直接以 close 1009 销毁连接；broadcaster 每次
// 'connect' 都补发整份 lastSnapshot → 补发被杀 → 自动重连 → 再补发 → 死循环。
// 所以这里断言的核心不变式是「**发出去的每一块都不可能超限**」，外加分块必须能
// 无损还原原快照（否则修好了死循环却丢了历史，等于换了个 bug）。

import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_MESSAGE_BYTES,
  MAX_SYNC_SNAPSHOT_CHUNKS,
  buildSnapshotChunks,
  jsonByteLength,
  readSnapshotChunkMeta,
  trimSnapshotToByteBudget,
  utf8ByteLength,
  type ChunkableSnapshot,
} from '../snapshotChunking';

function makeSegment(index: number, text: string) {
  return {
    id: `seg-${index}`,
    index,
    text,
    translatedText: text,
    startMs: index * 5_000,
    endMs: index * 5_000 + 4_800,
    globalStartMs: index * 5_000,
    globalEndMs: index * 5_000 + 4_800,
  };
}

function makeSnapshot(segmentCount: number, textLength: number): ChunkableSnapshot {
  const segments: unknown[] = [];
  const translations: Record<string, string> = {};
  for (let i = 0; i < segmentCount; i += 1) {
    segments.push(makeSegment(i, 'x'.repeat(textLength)));
    translations[`seg-${i}`] = 'y'.repeat(textLength);
  }
  return {
    segments,
    translations,
    summaryBlocks: [{ id: 'sum-1', blockIndex: 0, summary: 'hello' }],
    status: 'RECORDING',
    previewText: { finalText: '', nonFinalText: '' },
    previewTranslation: {
      finalText: '',
      nonFinalText: '',
      state: 'idle',
      sourceLanguage: null,
    },
  };
}

/** 把一批块按服务端语义还原（首块覆盖、后续块追加），用于无损性断言。 */
function replayChunks(chunks: ReturnType<typeof buildSnapshotChunks>['chunks']) {
  const segments: unknown[] = [];
  const summaryBlocks: unknown[] = [];
  const translations: Record<string, string> = {};
  for (const chunk of chunks) {
    segments.push(...chunk.segments);
    summaryBlocks.push(...chunk.summaryBlocks);
    Object.assign(translations, chunk.translations);
  }
  return { segments, summaryBlocks, translations };
}

describe('utf8ByteLength', () => {
  it('按 UTF-8 字节计，中文一字三字节（用 String.length 会低估三倍，闸门直接失效）', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect('中文'.length).toBe(2); // 对照：长度口径与字节口径差 3 倍
    expect(utf8ByteLength('😀')).toBe(4);
  });
});

describe('buildSnapshotChunks（H1 发送前体积闸）', () => {
  it('小快照仍是一块，内容原样', () => {
    const snapshot = makeSnapshot(5, 40);
    const { chunks, truncated } = buildSnapshotChunks(snapshot);

    expect(chunks).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].chunkCount).toBe(1);
    expect(chunks[0].segments).toEqual(snapshot.segments);
    expect(chunks[0].translations).toEqual(snapshot.translations);
    // 头部字段只随首块
    expect(chunks[0].status).toBe('RECORDING');
  });

  it('超 100KB 的快照被切成多块，且**每一块**都在传输层硬上限之下', () => {
    // ~1200 条 × (250B 正文 + 250B 译文) ≈ 700KB，远超 100KB 的 maxHttpBufferSize
    const snapshot = makeSnapshot(1_200, 250);
    expect(jsonByteLength(snapshot)).toBeGreaterThan(100 * 1024);

    const { chunks, truncated } = buildSnapshotChunks(snapshot);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(MAX_SYNC_SNAPSHOT_CHUNKS);
    for (const chunk of chunks) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES);
    }
    // 未触发截断：本量级应当完整送达
    expect(truncated).toBe(false);
  });

  it('分块无损：按服务端语义回放后 segment 顺序与内容完全一致', () => {
    const snapshot = makeSnapshot(1_200, 250);
    const { chunks } = buildSnapshotChunks(snapshot);
    const replayed = replayChunks(chunks);

    expect(replayed.segments).toEqual(snapshot.segments);
    expect(replayed.summaryBlocks).toEqual(snapshot.summaryBlocks);
    expect(replayed.translations).toEqual(snapshot.translations);
  });

  it('同一批次的所有块共享 chunkId、index 连续、count 一致', () => {
    const { chunks } = buildSnapshotChunks(makeSnapshot(1_200, 250));
    const ids = new Set(chunks.map((chunk) => chunk.chunkId));
    expect(ids.size).toBe(1);
    chunks.forEach((chunk, index) => {
      expect(chunk.chunkIndex).toBe(index);
      expect(chunk.chunkCount).toBe(chunks.length);
    });
  });

  it('中文快照按字节切（若按 String.length 切，块数会少 3 倍且每块必然超限）', () => {
    const segments: unknown[] = [];
    for (let i = 0; i < 800; i += 1) {
      segments.push(makeSegment(i, '课'.repeat(120)));
    }
    const snapshot: ChunkableSnapshot = {
      segments,
      translations: {},
      summaryBlocks: [],
    };

    const { chunks } = buildSnapshotChunks(snapshot);
    for (const chunk of chunks) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES);
    }
  });

  it('远超总预算时截断：保留**最近**的内容并置 truncated', () => {
    // ~1.9MB，超过 (MAX_SYNC_SNAPSHOT_CHUNKS-1) × 每块容量的总预算
    const snapshot = makeSnapshot(4_000, 250);
    const { chunks, truncated, droppedSegments } = buildSnapshotChunks(snapshot);

    expect(truncated).toBe(true);
    expect(droppedSegments).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(MAX_SYNC_SNAPSHOT_CHUNKS);
    expect(chunks[0].truncated).toBe(true);
    for (const chunk of chunks) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES);
    }

    const replayed = replayChunks(chunks);
    // 丢的是最早的，最后一条必须还在
    expect((replayed.segments.at(-1) as { id: string }).id).toBe('seg-3999');
    expect(
      replayed.segments.some((segment) => (segment as { id: string }).id === 'seg-0')
    ).toBe(false);
  });

  it('单条本身就超过硬上限时丢弃该条，而不是发一个必被 1009 杀掉的包', () => {
    const snapshot: ChunkableSnapshot = {
      segments: [
        makeSegment(0, 'a'.repeat(MAX_LIVE_MESSAGE_BYTES)),
        makeSegment(1, 'ok'),
      ],
      translations: {},
      summaryBlocks: [],
    };

    const { chunks, droppedOversized, truncated } = buildSnapshotChunks(snapshot);
    expect(droppedOversized).toBe(1);
    expect(truncated).toBe(true);
    for (const chunk of chunks) {
      expect(jsonByteLength(chunk)).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES);
    }
    expect(replayChunks(chunks).segments).toHaveLength(1);
  });

  it('空快照仍产出一块（空也是一次全量覆盖的表达）', () => {
    const { chunks } = buildSnapshotChunks({
      segments: [],
      translations: {},
      summaryBlocks: [],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkCount).toBe(1);
  });
});

describe('trimSnapshotToByteBudget（L3：磁盘快照的出站字节闸）', () => {
  it('预算内原样返回', () => {
    const snapshot = makeSnapshot(5, 40);
    const trimmed = trimSnapshotToByteBudget(snapshot, 1024 * 1024);
    expect(trimmed.truncated).toBe(false);
    expect(trimmed.segments).toEqual(snapshot.segments);
    expect(trimmed.translations).toEqual(snapshot.translations);
  });

  it('超预算时丢最早的 segment，并连带丢掉它们的译文', () => {
    const snapshot = makeSnapshot(400, 250);
    const trimmed = trimSnapshotToByteBudget(snapshot, 40 * 1024);

    expect(trimmed.truncated).toBe(true);
    expect(trimmed.segments.length).toBeLessThan(400);
    expect(jsonByteLength(trimmed.segments)).toBeLessThanOrEqual(40 * 1024);
    expect((trimmed.segments.at(-1) as { id: string }).id).toBe('seg-399');
    expect(trimmed.translations['seg-0']).toBeUndefined();
    expect(
      trimmed.translations[(trimmed.segments.at(-1) as { id: string }).id]
    ).toBeDefined();
  });

  it('不属于任何 segment 的孤儿译文条目原样保留（它们可能来自 translation_delta）', () => {
    const snapshot = makeSnapshot(400, 250);
    snapshot.translations['orphan-key'] = 'kept';
    const trimmed = trimSnapshotToByteBudget(snapshot, 40 * 1024);
    expect(trimmed.translations['orphan-key']).toBe('kept');
  });
});

describe('readSnapshotChunkMeta（服务端解析）', () => {
  it('无分块字段 = 旧式单块全量', () => {
    expect(readSnapshotChunkMeta({ segments: [] })).toEqual({ kind: 'single' });
  });

  it('合法分块字段被解析出来', () => {
    expect(
      readSnapshotChunkMeta({ chunkId: 'batch-1', chunkIndex: 2, chunkCount: 5 })
    ).toEqual({
      kind: 'chunk',
      meta: { chunkId: 'batch-1', chunkIndex: 2, chunkCount: 5 },
    });
  });

  it.each([
    ['缺 chunkId', { chunkIndex: 0, chunkCount: 2 }],
    ['chunkIndex 越界', { chunkId: 'b', chunkIndex: 2, chunkCount: 2 }],
    ['chunkCount 为 0', { chunkId: 'b', chunkIndex: 0, chunkCount: 0 }],
    ['chunkCount 超上限', { chunkId: 'b', chunkIndex: 0, chunkCount: 9_999 }],
    ['chunkIndex 非整数', { chunkId: 'b', chunkIndex: 1.5, chunkCount: 3 }],
    ['chunkId 非字符串', { chunkId: 7, chunkIndex: 0, chunkCount: 2 }],
  ])('%s → invalid（绝不降级成全量覆盖，否则残片会抹掉服务端历史）', (_label, payload) => {
    expect(readSnapshotChunkMeta(payload)).toEqual({ kind: 'invalid' });
  });
});
