import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-20 回归：统一 ffmpeg 并发信号量下沉到 transcodeToMp3 本身。
 *
 * 旧代码信号量只在 asyncUploadProcessor 内，完整版补全转录（fullTranscribeProcessor）直接调
 * transcodeToMp3 绕过它，两条路径叠加超并发。本测试锁死：**任何** transcodeToMp3 调用都受同一把
 * 全局信号量约束——超过上限的调用排队，不会同时派生 ffmpeg 进程。
 */

// 上限设 2（须在 import 前设置，const 在模块加载时读取）。
process.env.MAX_CONCURRENT_TRANSCODES = '2';

const { spawnMock, statMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  statMock: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('fs/promises', () => ({
  default: { stat: statMock, open: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  transcodeToMp3,
  getActiveFfmpegCount,
  getMaxConcurrentFfmpeg,
} from '@/lib/audio/ffmpegTranscode';

interface FakeProc {
  closeCb?: (code: number) => void;
  errorCb?: (err: Error) => void;
  triggerClose: (code: number) => void;
}

function makeFakeProc(): FakeProc {
  const proc: FakeProc = {
    triggerClose(code: number) {
      this.closeCb?.(code);
    },
  };
  const handle = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: (event: string, cb: (arg: never) => void) => {
      if (event === 'close') proc.closeCb = cb as (code: number) => void;
      if (event === 'error') proc.errorCb = cb as (err: Error) => void;
    },
    kill: vi.fn(),
  };
  spawnMock.mockImplementationOnce(() => handle);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  statMock.mockResolvedValue({ size: 1000 });
});

describe('transcodeToMp3 统一并发信号量 (P1-20)', () => {
  it('上限=2：第 3 个并发调用被排队，同时占用不超过上限', async () => {
    expect(getMaxConcurrentFfmpeg()).toBe(2);

    const p1 = makeFakeProc();
    const p2 = makeFakeProc();
    const p3 = makeFakeProc();

    const opts = (n: number) => ({
      inputPath: `/in${n}`,
      outputPath: `/out${n}`,
      durationSec: 10, // 传入避免额外 probe spawn
    });

    const t1 = transcodeToMp3(opts(1));
    const t2 = transcodeToMp3(opts(2));
    const t3 = transcodeToMp3(opts(3));

    // 让微任务跑一轮，前两个应已获名额并 spawn，第三个排队。
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledTimes(2); // 只有 2 个真正启动 ffmpeg
    expect(getActiveFfmpegCount()).toBe(2); // 占用达上限，未超

    // 完成第一个 → 名额转交第三个，第三个才 spawn。
    p1.triggerClose(0);
    await t1;
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(getActiveFfmpegCount()).toBe(2); // 仍是 2（p2 + p3 在跑）

    p2.triggerClose(0);
    p3.triggerClose(0);
    await Promise.all([t2, t3]);

    expect(getActiveFfmpegCount()).toBe(0); // 全部释放
  });
});
