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
import {
  appendAudioChunk,
  getAudioSession,
  persistAudioArchiveSnapshot,
  upsertAudioSession,
} from '../audioChunkStore';
import { teardownActiveRecordingArchivesForAccountBoundary } from '../recordingArchiveRegistry';

const appendAudioChunkMock = vi.mocked(appendAudioChunk);
const getAudioSessionMock = vi.mocked(getAudioSession);
const persistAudioArchiveSnapshotMock = vi.mocked(
  persistAudioArchiveSnapshot
);
const upsertAudioSessionMock = vi.mocked(upsertAudioSession);

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
  deferStopEvent = false;
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
    if (!this.deferStopEvent) {
      this.emitStop();
    }
  }
  requestData() {}
  addEventListener(type: string, cb: (e?: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  emitStop() {
    (this.listeners['stop'] ?? []).forEach((cb) => cb());
  }
  emitData(data: Blob) {
    (this.listeners['dataavailable'] ?? []).forEach((cb) =>
      cb({ data } as BlobEvent)
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeMediaRecorder.instances = [];
  acquireMicrophoneStream.mockReset();
  acquireSystemAudioStream.mockReset();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('MediaStream', FakeMediaStream);
});

afterEach(async () => {
  await teardownActiveRecordingArchivesForAccountBoundary();
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

describe('RecordingArchiveManager account boundary persistence fence', () => {
  it('abort synchronously invalidates, teardown awaits old writes, and late final data cannot resurrect storage', async () => {
    const owner = new AbortController();
    acquireMicrophoneStream.mockResolvedValue(
      new FakeMediaStream([new FakeTrack()])
    );
    const mgr = new RecordingArchiveManager('sess-old-account', {
      ownerSignal: owner.signal,
    });
    await mgr.ensureArchive({ sourceType: 'mic' });
    const uploadChunk = vi.fn(() => true);
    mgr.setChunkStoredHandler(uploadChunk);

    const recorder = FakeMediaRecorder.instances.at(-1)!;
    recorder.deferStopEvent = true;
    appendAudioChunkMock.mockClear();
    getAudioSessionMock.mockClear();
    persistAudioArchiveSnapshotMock.mockClear();
    upsertAudioSessionMock.mockClear();

    let releaseOldAppend!: () => void;
    appendAudioChunkMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseOldAppend = resolve;
        })
    );

    // A chunk entered IndexedDB just before logout and remains in flight.
    recorder.emitData(new Blob(['old-account-chunk']));
    await vi.waitFor(() => expect(releaseOldAppend).toBeTypeOf('function'));
    expect(appendAudioChunkMock).toHaveBeenCalledTimes(1);
    expect(uploadChunk).toHaveBeenCalledTimes(1);

    // authStore rotates/aborts synchronously, before the queued account cleanup.
    owner.abort();
    recorder.emitData(new Blob(['same-stack-final-after-abort']));
    expect(appendAudioChunkMock).toHaveBeenCalledTimes(1);
    expect(uploadChunk).toHaveBeenCalledTimes(1);

    let teardownSettled = false;
    const teardown = teardownActiveRecordingArchivesForAccountBoundary().then(
      () => {
        teardownSettled = true;
      }
    );
    await Promise.resolve();
    expect(teardownSettled).toBe(false);

    // Even after MediaRecorder reports stop, cleanup still waits for the IDB
    // transaction that began while A was current.
    recorder.emitStop();
    await Promise.resolve();
    expect(teardownSettled).toBe(false);

    releaseOldAppend();
    await teardown;
    expect(getAudioSessionMock).not.toHaveBeenCalled();
    expect(upsertAudioSessionMock).not.toHaveBeenCalled();

    // Model both account-cleanup passes having cleared IDB/sessionStorage. A
    // non-conforming recorder delivers one more final event afterwards; its
    // captured generation is stale and must not recreate either store.
    appendAudioChunkMock.mockClear();
    getAudioSessionMock.mockClear();
    persistAudioArchiveSnapshotMock.mockClear();
    upsertAudioSessionMock.mockClear();
    recorder.emitData(new Blob(['very-late-final']));
    await Promise.resolve();
    await Promise.resolve();

    expect(appendAudioChunkMock).not.toHaveBeenCalled();
    expect(getAudioSessionMock).not.toHaveBeenCalled();
    expect(persistAudioArchiveSnapshotMock).not.toHaveBeenCalled();
    expect(upsertAudioSessionMock).not.toHaveBeenCalled();
    expect(uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('does not hang account cleanup when MediaRecorder never emits stop', async () => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      const track = new FakeTrack();
      acquireMicrophoneStream.mockResolvedValue(
        new FakeMediaStream([track])
      );
      const mgr = new RecordingArchiveManager('sess-missing-stop', {
        ownerSignal: owner.signal,
      });
      await mgr.ensureArchive({ sourceType: 'mic' });

      FakeMediaRecorder.instances.at(-1)!.deferStopEvent = true;
      owner.abort();
      const teardown = teardownActiveRecordingArchivesForAccountBoundary();

      await vi.advanceTimersByTimeAsync(1_500);
      await expect(teardown).resolves.toBeUndefined();
      expect(track.readyState).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });
});
