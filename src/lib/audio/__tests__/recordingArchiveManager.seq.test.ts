/**
 * RecordingArchiveManager 分片粒度与起始 seq 协商负向测试。
 *
 * 覆盖：
 *  - P1-6 契约5：归档分片时长 ARCHIVE_TIMESLICE_MS 从 250ms 提到 3000ms
 *    （旧值 250 会让 4h 录音超服务端 5 万分片上限）。
 *  - P0-4 契约1：冷启动/续录 recorder.start() 之前由客户端传入 initialSeq（= 服务端 nextSeq），
 *    据此设定归档起始 seq。旧行为全新采集固定 nextSeq=0，冷设备续录会从 0 覆盖服务端录音开头。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 内存化 audioChunkStore：冷设备场景 IDB 为空（maxSeq=-1、无 session/snapshot） ──
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

class FakeTrack {
  kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  stop() {
    this.readyState = 'ended';
  }
  clone() {
    return new FakeTrack();
  }
  addEventListener() {}
  removeEventListener() {}
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
  startTimeslice: number | undefined;
  private listeners: Record<string, Array<(e?: unknown) => void>> = {};
  constructor(public stream: unknown, options?: { mimeType?: string }) {
    if (options?.mimeType) this.mimeType = options.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.state = 'recording';
    this.startTimeslice = timeslice;
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
  /** 测试驱动：模拟浏览器周期性 flush 出一个非空分片。 */
  emitData(size = 1024) {
    (this.listeners['dataavailable'] ?? []).forEach((cb) =>
      cb({ data: { size } } as unknown)
    );
  }
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  acquireMicrophoneStream.mockReset();
  acquireSystemAudioStream.mockReset();
  acquireMicrophoneStream.mockResolvedValue(new FakeMediaStream([new FakeTrack()]));
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('MediaStream', FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P1-6 归档分片粒度 3000ms', () => {
  it('recorder.start() 以 3000ms 的 timeslice 启动（旧值 250 会致 4h 录音超 5 万分片上限）', async () => {
    const mgr = new RecordingArchiveManager('sess-timeslice');
    await mgr.ensureArchive({ sourceType: 'mic' });

    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    expect(recorder.startTimeslice).toBe(3000);
  });
});

describe('P0-4 起始 seq 协商', () => {
  it('冷启动全新采集：传入 initialSeq=12（服务端 nextSeq）后首片 seq=12，而非从 0 覆盖服务端开头', async () => {
    const mgr = new RecordingArchiveManager('sess-cold-seq');
    const storedSeqs: number[] = [];
    mgr.setChunkStoredHandler(({ seq }) => {
      storedSeqs.push(seq);
      return true;
    });

    // preserveData 缺省(false)=全新采集：旧行为固定 nextSeq=0，首片会是 0。
    await mgr.ensureArchive({ sourceType: 'mic', initialSeq: 12 });

    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    recorder.emitData();
    recorder.emitData();
    await Promise.resolve();

    // 修复后：起始 seq = initialSeq = 12（服务端 maxSeq+1），不覆盖服务端已有 seq 0..11。
    expect(storedSeqs[0]).toBe(12);
    expect(storedSeqs[1]).toBe(13);
  });

  it('续录(preserveData) 时 initialSeq 作为下界与本地推导取较大值', async () => {
    // 本地 IDB 为空(maxSeq=-1)，服务端 nextSeq=20 → 起始必须 ≥ 20，防跨设备撞号。
    const mgr = new RecordingArchiveManager('sess-resume-seq');
    const storedSeqs: number[] = [];
    mgr.setChunkStoredHandler(({ seq }) => {
      storedSeqs.push(seq);
      return true;
    });

    await mgr.ensureArchive({
      sourceType: 'mic',
      preserveData: true,
      initialSeq: 20,
    });

    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    recorder.emitData();
    await Promise.resolve();

    expect(storedSeqs[0]).toBe(20);
  });

  it('全新会话无 initialSeq → 仍从 0 开始（不回归）', async () => {
    const mgr = new RecordingArchiveManager('sess-fresh-seq');
    const storedSeqs: number[] = [];
    mgr.setChunkStoredHandler(({ seq }) => {
      storedSeqs.push(seq);
      return true;
    });

    await mgr.ensureArchive({ sourceType: 'mic' });

    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    recorder.emitData();
    await Promise.resolve();

    expect(storedSeqs[0]).toBe(0);
  });
});
