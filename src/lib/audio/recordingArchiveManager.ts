'use client';

import type { AudioSourceType } from '@/types/transcript';
import {
  appendAudioChunk,
  clearAudioChunks,
  getAllAudioChunks,
  getArchiveMimeType,
  getAudioArchiveSnapshot,
  getAudioSession,
  getMaxAudioChunkSeq,
  hasAudioChunks,
  patchAudioSession,
  persistAudioArchiveSnapshot,
  upsertAudioSession,
  type AudioArchiveStatus,
} from './audioChunkStore';
import {
  acquireMicrophoneStream,
  acquireSystemAudioStream,
  mapStartError,
  pickRecorderOptions,
} from './audioCapture';

interface EnsureArchiveOptions {
  sourceType: AudioSourceType;
  deviceId?: string | null;
  preAcquiredStream?: MediaStream | null;
  preserveData?: boolean;
  startedAt?: number;
  // P0-4 契约1：冷启动/续录时由客户端先 GET 服务端草稿清单，把起始 seq 设为 nextSeq
  // （= 服务端 maxSeq+1）再启动 recorder，避免新分片从 0 起覆盖服务端已有录音开头。
  // 仅前进不后退：与本地 IDB 推导出的 nextSeq 取较大值。
  initialSeq?: number;
}

// P1-6 契约5：归档分片时长 250ms→3000ms。归档 recorder 与实时 Soniox 流互不相干，加大
// 分片粒度不影响实时转录延迟；4h 录音由 ~57.6 万片降到 4800 片，远低于服务端 5 万分片上限，
// 也大幅缓解每片一次目录扫描/上传带来的 O(n²) 与限流压力（审计 P1-6）。
const ARCHIVE_TIMESLICE_MS = 3000;
type ChunkStoredHandler = (
  payload: { seq: number; blob: Blob; mimeType: string }
) => Promise<boolean | void> | boolean | void;

export class RecordingArchiveManager {
  private readonly sessionId: string;
  private sourceType: AudioSourceType;
  private deviceId: string | null;
  private sourceStream: MediaStream | null = null;
  private archiveRecorder: MediaRecorder | null = null;
  private nextSeq = 0;
  private mimeType = 'audio/webm';
  private startedAt = Date.now();
  private readonly pendingWrites = new Set<Promise<void>>();
  private onChunkStored: ChunkStoredHandler | null = null;
  // 硬件掉线（麦克风拔出 / 系统共享停止，track 触发 'ended'）回调。上层据此把 UI 从
  // recording 切走，而不是继续显示在录直到 WS/idle 超时（P1-10）。
  private onCaptureEnded: (() => void) | null = null;
  // 采集代际：每次 stop() 同步 +1，使在途 acquire（replaceCapture 里等 getUserMedia/
  // getDisplayMedia 授权）在授权返回后校验代际即失效，立即停掉刚拿到的 track，杜绝
  // 「先 stop 再授权返回复活孤儿录音」（P0-1 critical）。
  private captureGeneration = 0;
  // 期望采集状态：暂停中切麦/重建，新 recorder 必须继承 paused，绝不静默恢复采集（P1-1）。
  private desiredCaptureState: 'recording' | 'paused' = 'recording';
  // 串行化闸：ensureArchive/switchInput/stop 全部经此排队，杜绝并发 replaceCapture/stop
  // 交叉执行导致的孤儿 recorder / 竞态（P0-1）。private replaceCapture 不入队（避免自锁）。
  private opChain: Promise<void> = Promise.resolve();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.sourceType = 'mic';
    this.deviceId = null;
  }

  /**
   * 把公开的采集操作串行化到单一队列，保证任意时刻只有一个 ensureArchive/switchInput/
   * stop 在跑。单次失败不中断后续排队，但把原始错误透传给调用方。
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(task, task);
    this.opChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async ensureArchive(options: EnsureArchiveOptions): Promise<void> {
    return this.enqueue(() => this.ensureArchiveInternal(options));
  }

  private async ensureArchiveInternal(
    options: EnsureArchiveOptions
  ): Promise<void> {
    const previousSourceType = this.sourceType;
    const previousDeviceId = this.deviceId;

    this.sourceType = options.sourceType;
    this.deviceId = options.deviceId ?? null;

    // P0-4：客户端协商出的服务端 nextSeq（= maxSeq+1）。作为起始 seq 的下界，仅前进不后退。
    const negotiatedSeq =
      Number.isFinite(options.initialSeq) && (options.initialSeq ?? -1) >= 0
        ? Math.floor(options.initialSeq as number)
        : 0;

    if (!options.preserveData) {
      // 全新采集：清除历史暂停意图，避免复用同一 manager 时残留 paused 抑制新录音。
      this.desiredCaptureState = 'recording';
      await clearAudioChunks(this.sessionId);
      // 冷启动即便清空本地 IDB，也要从服务端 nextSeq 起步：换设备/清缓存后服务端草稿仍在，
      // 从 0 起会覆盖服务端 seq 0（P0-4 critical）。全新会话 negotiatedSeq=0，从 0 开始。
      this.nextSeq = negotiatedSeq;
      this.startedAt = options.startedAt ?? Date.now();
    } else {
      const session = await getAudioSession(this.sessionId);
      const snapshot = getAudioArchiveSnapshot(this.sessionId);
      // 从 IDB 中查询实际存在的最大 chunk seq，避免因 chunkCount 元数据
      // 落后（浏览器被强制关闭时最后几次写入可能未提交）而导致新 chunk
      // 覆盖旧 chunk。同时并入服务端协商 nextSeq，取三者较大值防跨设备撞号。
      const maxSeqInDb = await getMaxAudioChunkSeq(this.sessionId);
      const metadataCount = Math.max(
        session?.chunkCount ?? 0,
        snapshot?.chunkCount ?? 0
      );
      this.nextSeq = Math.max(metadataCount, maxSeqInDb + 1, negotiatedSeq);
      this.mimeType = session?.mimeType || snapshot?.mimeType || this.mimeType;
      this.startedAt =
        session?.startedAt ??
        snapshot?.startedAt ??
        options.startedAt ??
        this.startedAt;
    }

    const needsReplacement =
      !this.sourceStream ||
      (!options.preserveData && this.archiveRecorder !== null) ||
      options.preAcquiredStream !== undefined ||
      previousSourceType !== options.sourceType ||
      previousDeviceId !== (options.deviceId ?? null);

    if (needsReplacement) {
      await this.replaceCapture(options.preAcquiredStream ?? null);
    } else {
      await this.ensureSessionRecord('recording');
    }
  }

  async getSenderStream(): Promise<MediaStream> {
    if (!this.sourceStream) {
      throw new Error('Archive source stream is not available');
    }

    return new MediaStream(
      this.sourceStream.getAudioTracks().map((track) => track.clone())
    );
  }

  async pause(): Promise<void> {
    // 同步记录暂停意图（即使当前 recorder 不在 recording 态，如正在切麦），供后续
    // replaceCapture 的新 recorder 继承（P1-1）。
    this.desiredCaptureState = 'paused';
    if (this.archiveRecorder?.state === 'recording') {
      this.archiveRecorder.pause();
      await this.ensureSessionRecord('paused');
    }
  }

  async resume(): Promise<void> {
    this.desiredCaptureState = 'recording';
    if (this.archiveRecorder?.state === 'paused') {
      this.archiveRecorder.resume();
      await this.ensureSessionRecord('recording');
    }
  }

  checkpoint() {
    if (!this.archiveRecorder || this.archiveRecorder.state === 'inactive') {
      return;
    }

    try {
      this.archiveRecorder.requestData();
    } catch {
      // Best effort only.
    }
  }

  flushForPageUnload() {
    if (!this.archiveRecorder || this.archiveRecorder.state === 'inactive') {
      return;
    }

    this.checkpoint();

    try {
      this.archiveRecorder.stop();
    } catch {
      // Best effort only.
    }
  }

  async switchInput(options: {
    sourceType: AudioSourceType;
    deviceId?: string | null;
    preAcquiredStream?: MediaStream | null;
  }): Promise<void> {
    return this.enqueue(async () => {
      this.sourceType = options.sourceType;
      this.deviceId = options.deviceId ?? null;
      await this.replaceCapture(options.preAcquiredStream ?? null);
    });
  }

  hasLiveCapture(): boolean {
    if (
      !this.sourceStream ||
      !this.archiveRecorder ||
      this.archiveRecorder.state === 'inactive'
    ) {
      return false;
    }
    // 硬件掉线后 track.readyState 变 'ended'：即便 recorder 尚未 inactive，也不再算「有实时
    // 采集」，否则 UI 会继续显示 recording（P1-10）。至少一条 audio track 仍 'live' 才算活。
    const audioTracks = this.sourceStream.getAudioTracks();
    if (audioTracks.length === 0) {
      return false;
    }
    return audioTracks.some((track) => track.readyState === 'live');
  }

  setCaptureEndedHandler(handler: (() => void) | null) {
    this.onCaptureEnded = handler;
  }

  async hasRecoverableAudio(): Promise<boolean> {
    if (this.nextSeq > 0) {
      return true;
    }
    return hasAudioChunks(this.sessionId);
  }

  setChunkStoredHandler(handler: ChunkStoredHandler | null) {
    this.onChunkStored = handler;
  }

  /**
   * 把下一个分片序号推进到至少 minSeq，防止跨设备/清缓存续录时本地 seq 从 0 重启、
   * 与服务端残留旧 draft 的 seq 撞号（撞号会被 uploadDraftChunk 误判「已上传」而跳过补传，
   * 收尾合并出旧音频、新音频被丢）。仅前进不后退，保证 seq 单调。审计 high。
   */
  ensureSeqAbove(minSeq: number): void {
    if (Number.isFinite(minSeq) && minSeq > this.nextSeq) {
      this.nextSeq = minSeq;
    }
  }

  async stop(): Promise<void> {
    // 同步递增采集代际：即使 stop 排在某个在途 ensureArchive/switchInput 之后才真正执行，
    // 该在途操作的 replaceCapture 在 await 授权返回后会看到代际已变，立即停掉刚拿到的
    // track 并放弃发布——这是「stop 后授权返回复活孤儿录音」的根治点（P0-1）。
    this.captureGeneration += 1;
    return this.enqueue(() => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    await this.ensureSessionRecord('finalizing');

    if (this.archiveRecorder) {
      const recorder = this.archiveRecorder;
      const stopPromise = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener(
          'error',
          (event) => {
            const recorderEvent = event as Event & {
              error?: Error;
              message?: string;
            };
            reject(
              recorderEvent.error ||
                new Error(recorderEvent.message || 'Archive recorder error')
            );
          },
          { once: true }
        );
      });

      if (recorder.state !== 'inactive') {
        try {
          recorder.requestData();
        } catch {
          // requestData is best-effort; stop() still flushes the final chunk.
        }
        recorder.stop();
        await stopPromise;
      }

      await this.flushPendingWrites();
      this.archiveRecorder = null;
    }

    this.stopSourceStream();
    await this.ensureSessionRecord('stopped');
  }

  async buildBlob(): Promise<Blob | null> {
    const chunks = await getAllAudioChunks(this.sessionId);
    if (chunks.length === 0) {
      return null;
    }

    const mimeType = await getArchiveMimeType(this.sessionId);
    return new Blob(chunks, { type: mimeType });
  }

  private async replaceCapture(
    preAcquiredStream: MediaStream | null
  ): Promise<void> {
    await this.stopRecorderOnly();
    this.stopSourceStream();

    // 记录进入 acquire 前的代际；授权期间若发生 stop()（代际 +1），返回后立即作废（P0-1）。
    const generation = this.captureGeneration;

    try {
      const stream = preAcquiredStream
        ? preAcquiredStream
        : this.sourceType === 'system'
          ? await acquireSystemAudioStream()
          : await acquireMicrophoneStream(this.deviceId);

      if (generation !== this.captureGeneration) {
        // acquire 期间已 stop：绝不发布 sourceStream、绝不启动 recorder，直接停掉孤儿轨。
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.sourceStream = stream;
      await this.startRecorder();
    } catch (error) {
      this.stopSourceStream();
      throw mapStartError(error, this.sourceType);
    }
  }

  private async startRecorder(): Promise<void> {
    if (!this.sourceStream) {
      throw new Error('Audio source stream is not available');
    }

    // 监听源 track 的 'ended'：麦克风被拔出 / 系统共享被停止时通知上层反映到状态（P1-10）。
    const capturedStream = this.sourceStream;
    const generationAtStart = this.captureGeneration;
    capturedStream.getAudioTracks().forEach((track) => {
      track.addEventListener(
        'ended',
        () => {
          // 仅当仍是当前这条采集流、且未被 stop（代际未变）时才上报，避免切麦/停止后
          // 旧 track 的 ended 晚到误触发。
          if (
            this.sourceStream === capturedStream &&
            this.captureGeneration === generationAtStart
          ) {
            this.onCaptureEnded?.();
          }
        },
        { once: true }
      );
    });

    const recorderOptions = pickRecorderOptions();
    const recorder = new MediaRecorder(this.sourceStream, recorderOptions);
    this.mimeType = recorder.mimeType || recorderOptions.mimeType || 'audio/webm';
    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size === 0) {
        return;
      }

      const seq = this.nextSeq;
      this.nextSeq += 1;
      const archiveStatus = recorder.state === 'paused' ? 'paused' : 'recording';
      this.syncArchiveSnapshot(archiveStatus);

      const persistChunk = appendAudioChunk(this.sessionId, seq, event.data)
        .then(() => true)
        .catch(() => false);
      const notifyChunk = this.onChunkStored
        ? Promise.resolve(
            this.onChunkStored({
              seq,
              blob: event.data,
              mimeType: this.mimeType,
            })
          )
            .then((result) => result !== false)
            .catch(() => false)
        : Promise.resolve(false);

      const write = Promise.all([persistChunk, notifyChunk])
        .then(async ([didPersist, didNotify]) => {
          if (!didPersist && !didNotify) {
            // 本地 IndexedDB 写入与服务端上传双双失败：该分片既没落本地也没传服务端，
            // nextSeq 已递增 → 归档将出现无法恢复的 seq 空洞。不再静默吞（旧行为直接 return），
            // 至少告警使问题可诊断/上层可感知（审计 medium：IDB 写失败静默出洞）。
            console.error(
              `[archive] chunk seq=${seq} 本地写入与上传均失败，归档出现空洞，` +
                `session=${this.sessionId}`
            );
            return;
          }
          await this.ensureSessionRecord(archiveStatus);
        })
        .catch(() => undefined)
        .finally(() => {
          this.pendingWrites.delete(write);
        });

      this.pendingWrites.add(write);
    });

    recorder.start(ARCHIVE_TIMESLICE_MS);
    this.archiveRecorder = recorder;

    if (this.desiredCaptureState === 'paused') {
      // 暂停态下切麦/重建：新 recorder 立即暂停，UI 显示 paused 而实际却继续采集的
      // 假暂停就此杜绝（P1-1）。等用户明确 resume() 才恢复。
      try {
        recorder.pause();
      } catch {
        // pause 尽力而为；即便失败也以 paused 记账，避免状态错配。
      }
      await this.ensureSessionRecord('paused');
      return;
    }

    await this.ensureSessionRecord('recording');
  }

  private async stopRecorderOnly(): Promise<void> {
    if (!this.archiveRecorder) {
      return;
    }

    const recorder = this.archiveRecorder;
    if (recorder.state !== 'inactive') {
      const stopPromise = new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
      });
      try {
        recorder.requestData();
      } catch {
        // requestData is best-effort.
      }
      recorder.stop();
      await stopPromise;
    }

    await this.flushPendingWrites();
    this.archiveRecorder = null;
  }

  private stopSourceStream() {
    if (!this.sourceStream) {
      return;
    }

    this.sourceStream.getTracks().forEach((track) => track.stop());
    this.sourceStream = null;
  }

  private async flushPendingWrites() {
    if (this.pendingWrites.size === 0) {
      return;
    }

    await Promise.allSettled(Array.from(this.pendingWrites));
  }

  private syncArchiveSnapshot(status: AudioArchiveStatus) {
    persistAudioArchiveSnapshot({
      sessionId: this.sessionId,
      sourceType: this.sourceType,
      deviceId: this.deviceId,
      mimeType: this.mimeType,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      chunkCount: this.nextSeq,
      status,
    });
  }

  private async ensureSessionRecord(status: 'recording' | 'paused' | 'finalizing' | 'stopped') {
    this.syncArchiveSnapshot(status);
    const current = await getAudioSession(this.sessionId);
    const nextRecord = {
      sessionId: this.sessionId,
      sourceType: this.sourceType,
      deviceId: this.deviceId,
      mimeType: this.mimeType,
      startedAt: current?.startedAt ?? this.startedAt,
      updatedAt: Date.now(),
      chunkCount: Math.max(current?.chunkCount ?? 0, this.nextSeq),
      status,
    } as const;

    if (current) {
      await patchAudioSession(this.sessionId, {
        sourceType: nextRecord.sourceType,
        deviceId: nextRecord.deviceId,
        mimeType: nextRecord.mimeType,
        startedAt: nextRecord.startedAt,
        updatedAt: nextRecord.updatedAt,
        chunkCount: nextRecord.chunkCount,
        status: nextRecord.status,
      });
      return;
    }

    await upsertAudioSession(nextRecord);
  }
}
