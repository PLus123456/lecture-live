import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type WorkerSecurityModule = {
  MEDIA_PROTOCOL_WHITELIST: string;
  sniffMediaContainerMagic(head: Buffer): boolean;
  classifyMediaContainerFormat(formatName: string): {
    allowed: boolean;
    reason?: string;
  };
  unregisterRunningProcess(
    registry: Map<string, object>,
    jobId: string,
    child: object
  ): void;
};

async function loadWorkerSecurity(): Promise<WorkerSecurityModule> {
  const workerUrl = pathToFileURL(
    path.join(process.cwd(), 'worker', 'audio-enhance-worker.mjs')
  ).href;
  return (await import(/* @vite-ignore */ workerUrl)) as WorkerSecurityModule;
}

describe('audio enhance worker media boundary (SEC-020)', () => {
  it('只允许 file/pipe 协议，网络协议不在白名单', async () => {
    const worker = await loadWorkerSecurity();
    expect(worker.MEDIA_PROTOCOL_WHITELIST).toBe('file,pipe');
  });

  it('纯文本 playlist/concat 没有合法容器魔数，常见自包含容器保持兼容', async () => {
    const { sniffMediaContainerMagic } = await loadWorkerSecurity();

    expect(sniffMediaContainerMagic(Buffer.from('#EXTM3U\nhttp://127.0.0.1/'))).toBe(false);
    expect(sniffMediaContainerMagic(Buffer.from('ffconcat version 1.0'))).toBe(false);
    expect(sniffMediaContainerMagic(Buffer.from('RIFF....WAVE'))).toBe(true);
    expect(sniffMediaContainerMagic(Buffer.from('OggS....'))).toBe(true);
    expect(
      sniffMediaContainerMagic(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))
    ).toBe(true);
    expect(sniffMediaContainerMagic(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe(true);
  });

  it('容器 allowlist 中的非通用文件头也能通过魔数层', async () => {
    const { sniffMediaContainerMagic } = await loadWorkerSecurity();
    const wave64 = Buffer.from([
      0x72, 0x69, 0x66, 0x66, 0x2e, 0x91, 0xcf, 0x11,
      0xa5, 0xd6, 0x28, 0xdb, 0x04, 0xc1, 0x00, 0x00,
    ]);
    const transportStream = Buffer.alloc(377);
    transportStream[0] = 0x47;
    transportStream[188] = 0x47;

    for (const head of [
      Buffer.from('caff....'),
      wave64,
      Buffer.from([0x0b, 0x77, 0, 0]),
      Buffer.from('#!AMR\n'),
      Buffer.from([0x00, 0x00, 0x01, 0xb3]),
      Buffer.from([0x00, 0x00, 0x01, 0xb6]),
      transportStream,
    ]) {
      expect(sniffMediaContainerMagic(head)).toBe(true);
    }
  });

  it('demuxer allowlist 显式拒绝外部引用格式，即使候选中混有合法容器', async () => {
    const { classifyMediaContainerFormat } = await loadWorkerSecurity();

    for (const format of ['hls', 'concat', 'dash', 'rtsp', 'sdp', 'matroska,hls']) {
      expect(classifyMediaContainerFormat(format)).toMatchObject({ allowed: false });
    }
    expect(classifyMediaContainerFormat('mov,mp4,m4a,3gp,3g2,mj2')).toEqual({
      allowed: true,
    });
    expect(classifyMediaContainerFormat('matroska,webm')).toEqual({ allowed: true });
    expect(classifyMediaContainerFormat('made_up_container')).toMatchObject({
      allowed: false,
    });
  });

  it('旧世代子进程延迟 close 不能清掉同 jobId 的新句柄', async () => {
    const { unregisterRunningProcess } = await loadWorkerSecurity();
    const oldChild = {};
    const newChild = {};
    const registry = new Map<string, object>([['same-job', newChild]]);

    unregisterRunningProcess(registry, 'same-job', oldChild);
    expect(registry.get('same-job')).toBe(newChild);
    unregisterRunningProcess(registry, 'same-job', newChild);
    expect(registry.has('same-job')).toBe(false);
  });
});
