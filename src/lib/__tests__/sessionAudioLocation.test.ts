import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 每个测试指向独立临时 cwd，使 DATA_ROOT (process.cwd()/data) 互不干扰。
async function loadModule(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return import('@/lib/sessionPersistence');
}

async function writeRecording(cwd: string, fileName: string, bytes: Buffer) {
  const dir = path.join(cwd, 'data', 'recordings');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), bytes);
}

describe('sessionPersistence P2-2/P2-3 音频定位与流式 Range', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-audio-loc-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('P2-3：mp3 录音的 MIME 推断为 audio/mpeg（旧分享分支一律 audio/webm）', async () => {
    const mod = await loadModule(tmpDir);
    expect(mod.inferRecordingMimeTypeFromReference('local:recordings/s.mp3')).toBe(
      'audio/mpeg'
    );
    expect(mod.inferRecordingMimeTypeFromReference('local:recordings/s.wav')).toBe(
      'audio/wav'
    );
    expect(mod.inferRecordingMimeTypeFromReference('local:recordings/s.ogg')).toBe(
      'audio/ogg'
    );
    expect(mod.inferRecordingMimeTypeFromReference('/user/recordings/s.mp4')).toBe(
      'audio/mp4'
    );
  });

  it('P2-3：resolveSessionAudioLocation 对 mp3 本地录音返回 audio/mpeg 与真实大小', async () => {
    const mod = await loadModule(tmpDir);
    const bytes = Buffer.from('ID3-mp3-body-0123456789');
    await writeRecording(tmpDir, 'sess-1.mp3', bytes);

    const location = await mod.resolveSessionAudioLocation({
      id: 'sess-1',
      userId: 'user-1',
      recordingPath: 'local:recordings/sess-1.mp3',
    });
    expect(location).not.toBeNull();
    expect(location!.kind).toBe('local');
    if (location!.kind === 'local') {
      expect(location!.contentType).toBe('audio/mpeg');
      expect(location!.size).toBe(bytes.length);
    }
  });

  it('P2-2：openLocalAudioRangeStream 只流式读取请求区间（不整包入内存）', async () => {
    const mod = await loadModule(tmpDir);
    // 100 字节，字节值 == 下标，便于校验切片。
    const full = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    await writeRecording(tmpDir, 'sess-2.webm', full);

    const location = await mod.resolveSessionAudioLocation({
      id: 'sess-2',
      userId: 'user-1',
      recordingPath: 'local:recordings/sess-2.webm',
    });
    expect(location).not.toBeNull();
    if (!location || location.kind !== 'local') return;

    // 请求 [10,19]（含端点，共 10 字节）—— createReadStream 只读该区间。
    const stream = mod.openLocalAudioRangeStream(location.filePath, {
      start: 10,
      end: 19,
    });
    const slice = Buffer.from(await new Response(stream).arrayBuffer());
    expect(slice.length).toBe(10);
    expect([...slice]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    // 不带 range 时整文件流式读取。
    const fullStream = mod.openLocalAudioRangeStream(location.filePath);
    const fullOut = Buffer.from(await new Response(fullStream).arrayBuffer());
    expect(fullOut.length).toBe(100);
    expect(fullOut.equals(full)).toBe(true);
  });

  it('recordingPath 为 Cloudreve 远程路径（/ 开头）时返回 cloudreve 定位与 MIME', async () => {
    const mod = await loadModule(tmpDir);
    const location = await mod.resolveSessionAudioLocation({
      id: 'sess-3',
      userId: 'user-9',
      recordingPath: '/user-9/recordings/sess-3.mp3',
    });
    expect(location).not.toBeNull();
    expect(location!.kind).toBe('cloudreve');
    if (location!.kind === 'cloudreve') {
      expect(location!.remotePath).toBe('/user-9/recordings/sess-3.mp3');
      expect(location!.userId).toBe('user-9');
      expect(location!.contentType).toBe('audio/mpeg');
    }
  });
});
