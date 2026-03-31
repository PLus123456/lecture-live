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
}

const ARCHIVE_TIMESLICE_MS = 250;
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

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.sourceType = 'mic';
    this.deviceId = null;
  }

  async ensureArchive(options: EnsureArchiveOptions): Promise<void> {
    const previousSourceType = this.sourceType;
    const previousDeviceId = this.deviceId;

    this.sourceType = options.sourceType;
    this.deviceId = options.deviceId ?? null;

    if (!options.preserveData) {
      await clearAudioChunks(this.sessionId);
      this.nextSeq = 0;
      this.startedAt = options.startedAt ?? Date.now();
    } else {
      const session = await getAudioSession(this.sessionId);
      const snapshot = getAudioArchiveSnapshot(this.sessionId);
      // 从 IDB 中查询实际存在的最大 chunk seq，避免因 chunkCount 元数据
      // 落后（浏览器被强制关闭时最后几次写入可能未提交）而导致新 chunk
      // 覆盖旧 chunk。
      const maxSeqInDb = await getMaxAudioChunkSeq(this.sessionId);
      const metadataCount = Math.max(
        session?.chunkCount ?? 0,
        snapshot?.chunkCount ?? 0
      );
      this.nextSeq = Math.max(metadataCount, maxSeqInDb + 1);
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
    if (this.archiveRecorder?.state === 'recording') {
      this.archiveRecorder.pause();
      await this.ensureSessionRecord('paused');
    }
  }

  async resume(): Promise<void> {
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
    this.sourceType = options.sourceType;
    this.deviceId = options.deviceId ?? null;
    await this.replaceCapture(options.preAcquiredStream ?? null);
  }

  hasLiveCapture(): boolean {
    return Boolean(
      this.sourceStream &&
        this.archiveRecorder &&
        this.archiveRecorder.state !== 'inactive'
    );
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

  async stop(): Promise<void> {
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

    try {
      const stream = preAcquiredStream
        ? preAcquiredStream
        : this.sourceType === 'system'
          ? await acquireSystemAudioStream()
          : await acquireMicrophoneStream(this.deviceId);

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
