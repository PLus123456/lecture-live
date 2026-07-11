/**
 * RecordingArchiveManager 生命周期负向测试。
 *
 * 覆盖审计 P0-1（stop 后授权返回复活孤儿录音）、P1-1（暂停态切麦新 recorder 继承 paused）、
 * P1-10（源 track ended → hasLiveCapture 转 false + 上报）。
 * 这些用例在修复前的旧行为下会失败（孤儿轨未停 / 新 recorder 进入 recording / 掉线仍算在录）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 可控的 audioChunkStore 桩：全部内存化，避免依赖 IndexedDB ──
vi.mock('../audioChunkStore', () => ({
  clearAudioChunks: vi.fn(async () => {}),
  appendAudioChunk: vi.fn(async () => {}),
  getAllAudioChunks: vi.fn(async () => []),
  getArchiveMimeType: vi.fn(async () => 'audio/webm'),
  getAudioArchiveSnapshot: vi.fn(() => null),
  getAudioSession: vi.fn(async () => null),
  getMaxAudioChunkSeq: vi.fn(async () => -1),
  hasAudioChunks: vi.fn(async () => false),
  patchAudioSession: vi.fn(async () => {}),
  persistAudioArchiveSnapshot: vi.fn(() => {}),
  upsertAudioSession: vi.fn(async () => {}),
}));

// ── 可控的 audioCapture 桩：getUserMedia/getDisplayMedia 由测试注入 ──
const acquireMicrophoneStream = vi.fn();
const acquireSystemAudioStream = vi.fn();
vi.mock('../audioCapture', () => ({
  acquireMicrophoneStream: (...args: unknown[]) => acquireMicrophoneStream(...args),
  acquireSystemAudioStream: (...args: unknown[]) => acquireSystemAudioStream(...args),
  mapStartError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  pickRecorderOptions: () => ({ mimeType: 'audio/webm' }),
}));

import { RecordingArchiveManager } from '../recordingArchiveManager';

// ── 极简 fake 媒体对象 ──
class FakeTrack {
  kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  private listeners: Record<string, Array<() => void>> = {};
  stop() {
    this.readyState = 'ended';
  }
  clone() {
    return new FakeTrack();
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  emit(type: string) {
    (this.listeners[type] ?? []).forEach((cb) => cb());
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks?: FakeTrack[]) {
    this.tracks = tracks ?? [new FakeTrack()];
  }
  getAudioTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return [];
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported() {
    return true;
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm';
  private listeners: Record<string, Array<(e?: unknown) => void>> = {};
  constructor(public stream: unknown, options?: { mimeType?: string }) {
    if (options?.mimeType) this.mimeType = options.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    (this.listeners['stop'] ?? []).forEach((cb) => cb());
  }
  requestData() {}
  addEventListener(type: string, cb: (e?: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  acquireMicrophoneStream.mockReset();
  acquireSystemAudioStream.mockReset();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('MediaStream', FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 让一个 acquire 处于「授权等待中」，并在被调用时通知测试。 */
function deferredAcquire() {
  let resolve!: (s: FakeMediaStream) => void;
  let onCalled!: () => void;
  const called = new Promise<void>((r) => (onCalled = r));
  const impl = vi.fn(() => {
    onCalled();
    return new Promise<FakeMediaStream>((r) => (resolve = r));
  });
  return { impl, resolve: (s: FakeMediaStream) => resolve(s), called };
}

describe('RecordingArchiveManager P0-1 取消在途授权', () => {
  it('acquire 等待授权中 stop → 授权返回后立即停掉孤儿轨、不启动 recorder', async () => {
    const pendingStream = new FakeMediaStream([new FakeTrack()]);
    const deferred = deferredAcquire();
    acquireMicrophoneStream.mockImplementation(deferred.impl);

    const mgr = new RecordingArchiveManager('sess-p01');
    const ensureP = mgr.ensureArchive({ sourceType: 'mic' });

    // 等 replaceCapture 读取代际并进入 getUserMedia 等待
    await deferred.called;

    // 用户此刻点停止：captureGeneration 同步 +1
    const stopP = mgr.stop();

    // 授权现在才返回
    deferred.resolve(pendingStream);
    await Promise.allSettled([ensureP, stopP]);

    // 旧行为：代际未变，replaceCapture 发布 sourceStream 并 new MediaRecorder + start()
    // → 孤儿常亮麦克风。修复后：代际已变，在 new MediaRecorder 之前就 bail，压根不构造
    // recorder，并停掉孤儿轨。断言「没有任何 recorder 被构造」以精确锁定代际守卫。
    expect(pendingStream.getAudioTracks()[0].readyState).toBe('ended');
    expect(mgr.hasLiveCapture()).toBe(false);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('system audio：acquire 等待中 stop 同样不复活孤儿录音', async () => {
    const pendingStream = new FakeMediaStream([new FakeTrack()]);
    const deferred = deferredAcquire();
    acquireSystemAudioStream.mockImplementation(deferred.impl);

    const mgr = new RecordingArchiveManager('sess-p01-sys');
    const ensureP = mgr.ensureArchive({ sourceType: 'system' });
    await deferred.called;
    const stopP = mgr.stop();
    deferred.resolve(pendingStream);
    await Promise.allSettled([ensureP, stopP]);

    expect(pendingStream.getAudioTracks()[0].readyState).toBe('ended');
    expect(mgr.hasLiveCapture()).toBe(false);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});

describe('RecordingArchiveManager P1-1 暂停态切麦继承 paused', () => {
  it('pause 后 switchInput：新 recorder 立即处于 paused，不静默恢复采集', async () => {
    acquireMicrophoneStream.mockResolvedValue(new FakeMediaStream([new FakeTrack()]));

    const mgr = new RecordingArchiveManager('sess-p11');
    await mgr.ensureArchive({ sourceType: 'mic' });
    expect(mgr.hasLiveCapture()).toBe(true);

    // 用户暂停
    await mgr.pause();

    // 暂停中切麦克风
    acquireMicrophoneStream.mockResolvedValue(new FakeMediaStream([new FakeTrack()]));
    await mgr.switchInput({ sourceType: 'mic', deviceId: 'mic-b' });

    // 旧行为：新 recorder.start() → state==='recording'（UI 暂停但实际采集）。
    // 修复后：新 recorder 继承 paused。
    const last = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    expect(last.state).toBe('paused');
  });
});

describe('RecordingArchiveManager P1-10 硬件掉线', () => {
  it('源 track ended → hasLiveCapture 转 false 且触发 onCaptureEnded', async () => {
    const track = new FakeTrack();
    acquireMicrophoneStream.mockResolvedValue(new FakeMediaStream([track]));

    const mgr = new RecordingArchiveManager('sess-p110');
    const endedSpy = vi.fn();
    mgr.setCaptureEndedHandler(endedSpy);
    await mgr.ensureArchive({ sourceType: 'mic' });
    expect(mgr.hasLiveCapture()).toBe(true);

    // 麦克风被拔出：track 触发 ended（readyState 同步转 ended 后再派发事件）
    track.readyState = 'ended';
    track.emit('ended');

    // 旧行为：recorder 仍非 inactive → hasLiveCapture 仍 true，UI 继续显示 recording。
    // 修复后：readyState 检查使其为 false，并回调上报。
    expect(mgr.hasLiveCapture()).toBe(false);
    expect(endedSpy).toHaveBeenCalledTimes(1);
  });
});
