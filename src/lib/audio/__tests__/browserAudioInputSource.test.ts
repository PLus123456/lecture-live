/**
 * BrowserAudioInputSource 负向测试（审计 P0-1）。
 *
 * start() 正在等待 getUserMedia 授权时调用 stop()，授权返回后不得发布 stream / 启动
 * MediaRecorder，且必须停掉刚拿到的孤儿轨。旧代码 stop() 不递增 startGeneration，
 * 授权返回后会继续建立录音 → 孤儿常亮麦克风。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acquireMicrophoneStream = vi.fn();
const acquireSystemAudioStream = vi.fn();
vi.mock('../audioCapture', () => ({
  acquireMicrophoneStream: (...a: unknown[]) => acquireMicrophoneStream(...a),
  acquireSystemAudioStream: (...a: unknown[]) => acquireSystemAudioStream(...a),
  mapStartError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  pickRecorderOptions: () => ({ mimeType: 'audio/webm' }),
}));

vi.mock('@/lib/audioLevelMonitor', () => ({
  AudioLevelMonitor: class {
    start() {}
    stop() {}
  },
}));

import { BrowserAudioInputSource } from '../browserAudioInputSource';

class FakeTrack {
  kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  stop() {
    this.readyState = 'ended';
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeMediaStream {
  constructor(private tracks: FakeTrack[] = [new FakeTrack()]) {}
  getAudioTracks() {
    return this.tracks;
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
  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  acquireMicrophoneStream.mockReset();
  acquireSystemAudioStream.mockReset();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserAudioInputSource P0-1', () => {
  it('start 等待授权中 stop → 授权返回后不建 recorder、停掉孤儿轨', async () => {
    const pendingStream = new FakeMediaStream([new FakeTrack()]);
    let resolveAcquire!: (s: FakeMediaStream) => void;
    let onCalled!: () => void;
    const called = new Promise<void>((r) => (onCalled = r));
    acquireMicrophoneStream.mockImplementation(() => {
      onCalled();
      return new Promise((r) => (resolveAcquire = r));
    });

    const source = new BrowserAudioInputSource({ sourceType: 'mic' });
    const handlers = {
      onData: vi.fn(),
      onError: vi.fn(),
      onMuted: vi.fn(),
      onUnmuted: vi.fn(),
    };
    const startP = source.start(handlers);

    await called; // 已进入 getUserMedia 等待

    source.stop(); // 递增 startGeneration，作废本次 start

    resolveAcquire(pendingStream);
    await startP;

    // 旧行为：resolve 后发布 stream、new MediaRecorder + start() → 孤儿录音。
    // 修复后：无活跃 recorder，孤儿轨被停。
    const active = FakeMediaRecorder.instances.filter((r) => r.state !== 'inactive');
    expect(active).toHaveLength(0);
    expect(pendingStream.getAudioTracks()[0].readyState).toBe('ended');
  });

  it('未消费的 preAcquiredStream 在 stop() 时被停掉，不残留孤儿轨', () => {
    const pre = new FakeMediaStream([new FakeTrack()]);
    const source = new BrowserAudioInputSource({
      sourceType: 'mic',
      preAcquiredStream: pre as unknown as MediaStream,
    });
    source.stop();
    expect(pre.getAudioTracks()[0].readyState).toBe('ended');
  });
});
