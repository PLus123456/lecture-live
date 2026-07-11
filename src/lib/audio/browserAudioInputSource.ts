'use client';

import type { AudioSource, AudioSourceHandlers } from '@soniox/client';
import type { AudioSourceType } from '@/types/transcript';
import {
  acquireMicrophoneStream,
  acquireSystemAudioStream,
  mapStartError,
  pickRecorderOptions,
} from './audioCapture';
import { AudioLevelMonitor } from '@/lib/audioLevelMonitor';

const DEFAULT_TIMESLICE_MS = 60;

export class BrowserAudioInputSource implements AudioSource {
  private readonly sourceType: AudioSourceType;
  private readonly deviceId?: string | null;
  private readonly timesliceMs: number;
  private preAcquiredStream: MediaStream | null;
  private managedStream: MediaStream | null;

  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private levelMonitor: AudioLevelMonitor | null = null;
  private boundOnData: ((event: BlobEvent) => void) | null = null;
  private boundOnError: ((event: Event) => void) | null = null;
  private boundOnMute: (() => void) | null = null;
  private boundOnUnmute: (() => void) | null = null;
  private startGeneration = 0;
  private readonly onAudioLevel: ((level: number) => void) | null;

  constructor(options: {
    sourceType: AudioSourceType;
    deviceId?: string | null;
    timesliceMs?: number;
    preAcquiredStream?: MediaStream | null;
    managedStream?: MediaStream | null;
    onAudioLevel?: ((level: number) => void) | null;
  }) {
    this.sourceType = options.sourceType;
    this.deviceId = options.deviceId;
    this.timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this.preAcquiredStream = options.preAcquiredStream ?? null;
    this.managedStream = options.managedStream ?? null;
    this.onAudioLevel = options.onAudioLevel ?? null;
  }

  async start(handlers: AudioSourceHandlers): Promise<void> {
    // 先把待消费的预取流快照到局部，再 stop()——stop() 会清理未消费的预取流，
    // 若不先快照，start() 自己调用的 stop() 会把本次要用的流也停掉（P0-1）。
    const managed = this.managedStream;
    this.managedStream = null;
    const preAcquired = this.preAcquiredStream;
    this.preAcquiredStream = null;

    this.stop();

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      if (managed) managed.getTracks().forEach((track) => track.stop());
      if (preAcquired) preAcquired.getTracks().forEach((track) => track.stop());
      throw new Error('当前环境不支持音频采集。');
    }

    if (typeof MediaRecorder === 'undefined') {
      if (managed) managed.getTracks().forEach((track) => track.stop());
      if (preAcquired) preAcquired.getTracks().forEach((track) => track.stop());
      throw new Error('当前浏览器不支持 MediaRecorder。');
    }

    const generation = ++this.startGeneration;

    try {
      let stream: MediaStream;
      if (managed) {
        stream = managed;
      } else if (preAcquired) {
        stream = preAcquired;
      } else {
        stream =
          this.sourceType === 'system'
            ? await acquireSystemAudioStream()
            : await acquireMicrophoneStream(this.deviceId);
      }

      // stop()/再次 start() 会递增 startGeneration；授权在此期间返回则本次已过期，
      // 立即停掉刚拿到的 track，绝不发布 stream/启动 recorder，杜绝孤儿录音（P0-1）。
      if (generation !== this.startGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      this.startLevelMonitor(stream);

      const track = stream.getAudioTracks()[0];
      if (track) {
        this.boundOnMute = handlers.onMuted ? () => handlers.onMuted?.() : null;
        this.boundOnUnmute = handlers.onUnmuted
          ? () => handlers.onUnmuted?.()
          : null;

        if (this.boundOnMute) {
          track.addEventListener('mute', this.boundOnMute);
        }

        if (this.boundOnUnmute) {
          track.addEventListener('unmute', this.boundOnUnmute);
        }
      }

      const recorder = new MediaRecorder(stream, pickRecorderOptions());
      this.mediaRecorder = recorder;

      this.boundOnData = (event: BlobEvent) => {
        if (event.data.size === 0) {
          return;
        }

        void event.data.arrayBuffer().then(
          (buffer) => handlers.onData(buffer),
          (reason) => handlers.onError(mapStartError(reason, this.sourceType))
        );
      };

      this.boundOnError = (event: Event) => {
        const recorderEvent = event as Event & {
          error?: Error;
          message?: string;
        };

        handlers.onError(
          recorderEvent.error ||
            new Error(recorderEvent.message || 'MediaRecorder error')
        );
      };

      recorder.addEventListener('dataavailable', this.boundOnData);
      recorder.addEventListener('error', this.boundOnError);
      recorder.start(this.timesliceMs);
    } catch (error) {
      this.stop();
      throw mapStartError(error, this.sourceType);
    }
  }

  stop() {
    // 递增代际：任何在途 start()（正等待 getUserMedia 授权）在授权返回后校验代际即失效，
    // 立即停掉刚拿到的 track。这是「stop 后授权返回复活孤儿录音」的根治点（P0-1）。
    this.startGeneration += 1;

    this.stopLevelMonitor();

    // 停掉尚未被 start() 消费的预取流，避免换页/取消时残留常亮的孤儿轨。
    if (this.managedStream) {
      this.managedStream.getTracks().forEach((track) => track.stop());
      this.managedStream = null;
    }
    if (this.preAcquiredStream) {
      this.preAcquiredStream.getTracks().forEach((track) => track.stop());
      this.preAcquiredStream = null;
    }

    if (this.mediaRecorder) {
      if (this.mediaRecorder.state !== 'inactive') {
        const recorder = this.mediaRecorder;
        const onData = this.boundOnData;
        const onError = this.boundOnError;

        recorder.addEventListener(
          'stop',
          () => {
            if (onData) {
              recorder.removeEventListener('dataavailable', onData);
            }
            if (onError) {
              recorder.removeEventListener('error', onError);
            }
          },
          { once: true }
        );

        recorder.stop();
      } else {
        if (this.boundOnData) {
          this.mediaRecorder.removeEventListener(
            'dataavailable',
            this.boundOnData
          );
        }
        if (this.boundOnError) {
          this.mediaRecorder.removeEventListener('error', this.boundOnError);
        }
      }

      this.boundOnData = null;
      this.boundOnError = null;
      this.mediaRecorder = null;
    }

    if (this.stream) {
      const track = this.stream.getAudioTracks()[0];

      if (track) {
        if (this.boundOnMute) {
          track.removeEventListener('mute', this.boundOnMute);
        }
        if (this.boundOnUnmute) {
          track.removeEventListener('unmute', this.boundOnUnmute);
        }
      }

      this.boundOnMute = null;
      this.boundOnUnmute = null;
      this.stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      this.stream = null;
    }
  }

  pause() {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.pause();
    }
  }

  resume() {
    if (this.mediaRecorder?.state === 'paused') {
      this.mediaRecorder.resume();
    }
  }

  private startLevelMonitor(stream: MediaStream) {
    if (!this.onAudioLevel) {
      return;
    }

    try {
      this.levelMonitor = new AudioLevelMonitor(this.onAudioLevel);
      this.levelMonitor.start(stream);
    } catch (error) {
      this.levelMonitor = null;
      console.warn('Audio level monitor unavailable:', error);
    }
  }

  private stopLevelMonitor() {
    this.levelMonitor?.stop();
    this.levelMonitor = null;
  }
}
