import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-11：ffprobe/ffmpeg 安全加固负向测试。
 *  - 魔数白名单拒纯文本 playlist（#EXTM3U），接受已知二进制容器；
 *  - demuxer 白名单拒 hls/concat/dash/rtsp，接受 mov,mp4 / matroska,webm；
 *  - transcodeToMp3 派生 ffmpeg 必带 `-protocol_whitelist file,pipe` 与 `-nostdin`；
 *  - validateMediaContainer 对 playlist 输入抛 MediaValidationError。
 * 以上校验在旧代码里全不存在（无魔数/demuxer 校验、ffmpeg 无协议白名单），故均在旧代码上失败。
 */

// ── child_process spawn 桩：捕获参数并按需喂 stdout，再 close(0) ──
const spawnState = vi.hoisted(() => ({
  lastArgs: [] as string[],
  allArgs: [] as string[][],
  nextProbeStdout: '',
}));

vi.mock('child_process', () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    spawnState.lastArgs = args;
    spawnState.allArgs.push(args);
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    setImmediate(() => {
      if (args.includes('format=format_name') || args.includes('format=duration')) {
        if (spawnState.nextProbeStdout) {
          proc.stdout.emit('data', Buffer.from(spawnState.nextProbeStdout));
        }
      }
      proc.emit('close', 0);
    });
    return proc;
  }),
}));

// ── fs/promises 桩：stat（转码产物）+ open（魔数读头）──
const fsState = vi.hoisted(() => ({ head: Buffer.alloc(0) }));
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(async () => ({ size: 4242 })),
    open: vi.fn(async () => ({
      read: async (buf: Buffer, off: number, len: number) => {
        const n = Math.min(len, fsState.head.length);
        fsState.head.copy(buf, off, 0, n);
        return { bytesRead: n };
      },
      close: async () => undefined,
    })),
  },
}));

import {
  sniffContainerMagic,
  classifyContainerFormat,
  transcodeToMp3,
  validateMediaContainer,
  MediaValidationError,
} from '../ffmpegTranscode';

beforeEach(() => {
  spawnState.lastArgs = [];
  spawnState.allArgs = [];
  spawnState.nextProbeStdout = '';
  fsState.head = Buffer.alloc(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sniffContainerMagic（魔数白名单）', () => {
  it('拒纯文本 HLS playlist（#EXTM3U，无二进制容器魔数）', () => {
    expect(sniffContainerMagic(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n'))).toBe(false);
  });
  it('拒 ffconcat 脚本文本', () => {
    expect(sniffContainerMagic(Buffer.from('ffconcat version 1.0\nfile /etc/passwd'))).toBe(false);
  });
  it('接受 WebM/MKV（EBML 1A45DFA3）', () => {
    expect(sniffContainerMagic(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe(true);
  });
  it('接受 MP4（offset4=ftyp）', () => {
    const buf = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]);
    expect(sniffContainerMagic(buf)).toBe(true);
  });
  it('接受 RIFF/WAV', () => {
    expect(sniffContainerMagic(Buffer.from('RIFF....WAVE'))).toBe(true);
  });
});

describe('classifyContainerFormat（demuxer 白名单）', () => {
  it('拒 hls', () => {
    expect(classifyContainerFormat('hls').allowed).toBe(false);
  });
  it('拒 concat', () => {
    expect(classifyContainerFormat('concat').allowed).toBe(false);
  });
  it('拒 rtsp/dash', () => {
    expect(classifyContainerFormat('rtsp').allowed).toBe(false);
    expect(classifyContainerFormat('dash').allowed).toBe(false);
  });
  it('接受 mov,mp4,m4a', () => {
    expect(classifyContainerFormat('mov,mp4,m4a,3gp,3g2,mj2').allowed).toBe(true);
  });
  it('接受 matroska,webm', () => {
    expect(classifyContainerFormat('matroska,webm').allowed).toBe(true);
  });
  it('拒未知 demuxer', () => {
    expect(classifyContainerFormat('totally_unknown_fmt').allowed).toBe(false);
  });
});

describe('transcodeToMp3 ffmpeg 参数硬化', () => {
  it('必带 -nostdin 与 -protocol_whitelist file,pipe，且在 -i 之前', async () => {
    await transcodeToMp3({ inputPath: '/tmp/in.webm', outputPath: '/tmp/out.mp3', durationSec: 60 });
    const args = spawnState.lastArgs;
    expect(args).toContain('-nostdin');
    const pwIdx = args.indexOf('-protocol_whitelist');
    expect(pwIdx).toBeGreaterThanOrEqual(0);
    expect(args[pwIdx + 1]).toBe('file,pipe');
    // 协议白名单必须在输入 -i 之前生效
    expect(pwIdx).toBeLessThan(args.indexOf('-i'));
  });
});

describe('runProbe ffprobe 参数（回归：-nostdin 破坏 ffprobe 8.x）', () => {
  it('ffprobe 调用带 -protocol_whitelist file,pipe 但绝不带 -nostdin', async () => {
    fsState.head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    spawnState.nextProbeStdout = 'matroska,webm\n';
    await validateMediaContainer('/tmp/ok.webm');
    // validateMediaContainer 会派生 ffprobe（-show_entries format=format_name）。
    const probeCalls = spawnState.allArgs.filter((a) => a.includes('-show_entries'));
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const args of probeCalls) {
      // 回归防护：`-nostdin` 是 ffmpeg 的全局选项，ffprobe 不认识——ffmpeg 7+/8.x 会把它
      // 当成需要取值的未知选项、吞掉下一个参数并 rc=1 stdout 全空，导致 probeFormatName
      // 返回空 →「ffprobe could not determine container format」。绝不能再出现在 probe 参数里。
      expect(args).not.toContain('-nostdin');
      const pwIdx = args.indexOf('-protocol_whitelist');
      expect(pwIdx).toBeGreaterThanOrEqual(0);
      expect(args[pwIdx + 1]).toBe('file,pipe');
    }
  });
});

describe('validateMediaContainer', () => {
  it('playlist 文本输入（魔数不过）→ 抛 MediaValidationError', async () => {
    fsState.head = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF');
    await expect(validateMediaContainer('/tmp/evil.m3u8')).rejects.toBeInstanceOf(
      MediaValidationError
    );
  });
  it('魔数过但 ffprobe 报 hls demuxer → 抛 MediaValidationError', async () => {
    // 伪装成 EBML 魔数骗过第一道闸，但 ffprobe 解析出 hls → 第二道闸拒。
    fsState.head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    spawnState.nextProbeStdout = 'hls\n';
    await expect(validateMediaContainer('/tmp/fake.mkv')).rejects.toBeInstanceOf(
      MediaValidationError
    );
  });
  it('合法 webm（魔数 + matroska,webm demuxer）→ 通过', async () => {
    fsState.head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    spawnState.nextProbeStdout = 'matroska,webm\n';
    await expect(validateMediaContainer('/tmp/ok.webm')).resolves.toBeUndefined();
  });
});
