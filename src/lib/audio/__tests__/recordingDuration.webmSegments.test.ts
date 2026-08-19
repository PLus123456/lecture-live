import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * audio-recording#150：WebM 时长修复按每个伪造 EBML 标记切片并逐段调用解析器。
 *
 * findWebmDocumentOffsets 逐字节扫描，只要命中 4 字节 EBML 魔数且其后 128 字节内出现 ASCII
 * 'webm' 就 push 一个 offset —— 没有数量上限、没有最小段长、不去重。攻击者用 8 字节模式
 * `1A 45 DF A3 'webm'` 重复填充即可让每 8 字节产生一个边界，随后逐段 new Blob + arrayBuffer +
 * Buffer.from。实测（复现脚本，本机 Node 25）：
 *
 *   输入      段数         耗时     RSS
 *   1 MiB     131,072      0.9s     298 MiB
 *   4 MiB     524,288      4.1s     571 MiB
 *   16 MiB    2,097,152    16.5s    1.47 GB   ← 1GB 堆上限下已贴着 OOM 线
 *   32 MiB    4,194,304    ~33s     ~2.9 GB（线性外推；32MiB 正是 middleware 的单请求上限）
 *
 * 注意与原始判定的一处出入：await 每轮都让出事件循环，故它**不**冻结事件循环（实测 worst
 * lag = 0ms）。真正致命的是内存 —— 数百万个小对象把常规容量的容器直接推过 OOM 线。
 */

const fixWebmDurationMock = vi.hoisted(() => vi.fn());

vi.mock('fix-webm-duration', () => ({ default: fixWebmDurationMock }));
vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  probeDurationSec: vi.fn(async () => 0),
}));
vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionTranscriptBundle: vi.fn(async () => null),
}));

import {
  MAX_DURATION_FIX_BYTES,
  normalizeRecordedAudioDuration,
} from '@/lib/audio/recordingDuration';

/** 攻击载荷：8 字节的 `1A 45 DF A3 'webm'` 重复填充 —— 每 8 字节一个「文档边界」。 */
function forgedMarkerPayload(totalBytes: number): Buffer {
  const unit = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]);
  return Buffer.concat(Array(Math.floor(totalBytes / 8)).fill(unit));
}

/** 合法形态：每段都是「魔数 + DocType + 足量负载」，段长远大于最小段长。 */
function webmDocument(payloadBytes: number): Buffer {
  const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]);
  return Buffer.concat([head, Buffer.alloc(payloadBytes, 0x11)]);
}

describe('normalizeRecordedAudioDuration —— WebM 分段上限 (audio-recording#150)', () => {
  beforeEach(() => {
    fixWebmDurationMock.mockReset();
    // 真实实现返回修正后的 Blob；这里原样回传，只统计调用次数。
    fixWebmDurationMock.mockImplementation(async (blob: Blob) => blob);
  });

  it('密集伪造的 EBML 标记 → 原样返回，绝不进入切段循环', async () => {
    // 1 MiB 载荷在旧实现下切出 131,072 段。
    const buffer = forgedMarkerPayload(1024 * 1024);

    const startedAt = Date.now();
    const result = await normalizeRecordedAudioDuration({
      buffer,
      mimeType: 'audio/webm',
      durationMs: 3_600_000,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(fixWebmDurationMock).not.toHaveBeenCalled();
    expect(result).toBe(buffer);
    // 旧实现同样的输入要 0.9s+ 并把堆推到数百 MB；放弃分段后只剩一次线性扫描。
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('合法多段 WebM 仍然逐段修正（修复没有误伤正常录音）', async () => {
    const buffer = Buffer.concat([webmDocument(4096), webmDocument(4096)]);

    await normalizeRecordedAudioDuration({
      buffer,
      mimeType: 'audio/webm',
      durationMs: 120_000,
    });

    expect(fixWebmDurationMock).toHaveBeenCalledTimes(2);
  });

  it('相邻边界间隔不足最小段长 → 折叠成单段（噪声不再被当成文档头）', async () => {
    // 两个魔数只隔 8 字节：真实 webm 文档头后必然跟着 Segment/Tracks/Cluster，不可能这么密。
    const buffer = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]),
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]),
      Buffer.alloc(4096, 0x22),
    ]);

    await normalizeRecordedAudioDuration({
      buffer,
      mimeType: 'audio/webm',
      durationMs: 60_000,
    });

    // 单段路径：整段一次修正，而不是切成两段。
    expect(fixWebmDurationMock).toHaveBeenCalledTimes(1);
  });

  it('总字节超过上限 → 直接跳过修正（直传口与草稿定稿口共用同一条短路）', async () => {
    const buffer = Buffer.allocUnsafe(MAX_DURATION_FIX_BYTES + 1);
    // 让头部像个合法 webm，确保拦截发生在字节闸而不是「认不出 webm」。
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]).copy(buffer);

    const result = await normalizeRecordedAudioDuration({
      buffer,
      mimeType: 'audio/webm',
      durationMs: 3_600_000,
    });

    expect(result).toBe(buffer);
    expect(fixWebmDurationMock).not.toHaveBeenCalled();
  });
});
