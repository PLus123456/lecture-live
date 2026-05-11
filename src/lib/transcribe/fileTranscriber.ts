'use client';

/**
 * 文件转录器：把上传的音频/视频文件作为 MediaStream 喂给 Soniox 实时 ASR。
 *
 * 实现思路：
 * 1. 用 <audio> 元素加载 file URL（HTMLMediaElement 自带音视频解码，比 decodeAudioData 更省内存）。
 * 2. AudioContext.createMediaElementSource → MediaStreamAudioDestinationNode 把回放音频转为 MediaStream。
 * 3. 把这个 MediaStream 作为 BrowserAudioInputSource 的 preAcquiredStream，启动 Soniox 实时转录。
 * 4. audio.playbackRate 设大点（例如 4x）做加速转录，缩短等待时间。
 *    Soniox 文档说服务端按音频时长计费，但客户端处理速率可以加速；只要 ws 不被服务端断开就行。
 * 5. 监听 audio 'ended'，等 Soniox 处理完最后一批 token 后停止 recording。
 */

import type { TranscriptSegment } from '@/types/transcript';
import type { RealtimeToken } from '@/types/soniox';
import { TokenProcessor } from '@/lib/soniox/tokenProcessor';
import { startSonioxRecording, buildSonioxConfig } from '@/lib/soniox/client';
import { BrowserAudioInputSource } from '@/lib/audio/browserAudioInputSource';
import type { SessionConfig } from '@/types/transcript';

export interface FileTranscribeOptions {
  file: File;
  authToken: string;
  config: SessionConfig;
  /** 加速倍率，默认 3。Soniox 目前能稳定处理 3x；4x 偶尔丢字。 */
  playbackRate?: number;
  onProgress?: (progress: number) => void;       // 0~1
  onSegment?: (segment: TranscriptSegment) => void;
  onError?: (error: Error) => void;
}

export interface FileTranscribeResult {
  segments: TranscriptSegment[];
  durationMs: number;
}

/**
 * 解析音频/视频文件时长（用 <audio> 的 metadata 加载）。
 */
export async function probeAudioDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    audio.muted = true;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.remove();
    };
    audio.addEventListener('loadedmetadata', () => {
      const ms = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
      cleanup();
      resolve(ms);
    });
    audio.addEventListener('error', () => {
      cleanup();
      reject(new Error('无法读取音频文件元数据'));
    });
  });
}

/**
 * 估算转录耗时（毫秒）。基于文件时长 + 加速倍率。
 */
export function estimateTranscribeDurationMs(audioDurationMs: number, playbackRate = 3): number {
  // 加速 + 网络/启动开销
  return Math.round(audioDurationMs / playbackRate + 4000);
}

/**
 * 启动文件转录。返回一个可被取消的 handle。
 */
export function startFileTranscribe(opts: FileTranscribeOptions): {
  promise: Promise<FileTranscribeResult>;
  cancel: () => void;
} {
  let canceled = false;
  let recordingHandle: Awaited<ReturnType<typeof startSonioxRecording>> | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let audioCtx: AudioContext | null = null;
  let blobUrl: string | null = null;

  const cleanup = () => {
    try { recordingHandle?.recording.stop(); } catch { /* ignore */ }
    try { audioEl?.pause(); } catch { /* ignore */ }
    if (audioEl) { audioEl.src = ''; audioEl.remove(); audioEl = null; }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if (audioCtx && audioCtx.state !== 'closed') { void audioCtx.close(); }
    audioCtx = null;
  };

  const promise = (async (): Promise<FileTranscribeResult> => {
    const playbackRate = opts.playbackRate ?? 3;

    // 1. 准备 audio 元素
    blobUrl = URL.createObjectURL(opts.file);
    audioEl = document.createElement('audio');
    audioEl.src = blobUrl;
    audioEl.preload = 'auto';
    audioEl.muted = true;        // 不在用户耳朵里播放
    audioEl.crossOrigin = 'anonymous';
    audioEl.playbackRate = playbackRate;

    // 等元数据
    await new Promise<void>((resolve, reject) => {
      audioEl!.addEventListener('loadedmetadata', () => resolve(), { once: true });
      audioEl!.addEventListener('error', () => reject(new Error('音频加载失败')), { once: true });
    });

    if (canceled) throw new Error('已取消');

    const durationMs = Math.round(audioEl.duration * 1000);

    // 2. AudioContext 桥接 → MediaStream
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) throw new Error('当前浏览器不支持 Web Audio API');

    audioCtx = new AudioCtor();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => undefined);
    }
    const sourceNode = audioCtx.createMediaElementSource(audioEl);
    const destNode = audioCtx.createMediaStreamDestination();
    sourceNode.connect(destNode);
    // 注意：故意不 connect 到 audioCtx.destination，避免在用户耳朵里播放

    const mediaStream = destNode.stream;

    // 3. 启动 Soniox 实时转录，把 mediaStream 作为 preAcquiredStream
    const collectedSegments: TranscriptSegment[] = [];
    const tokenProcessor = new TokenProcessor({
      onSegmentFinalized: (seg: TranscriptSegment) => {
        collectedSegments.push(seg);
        opts.onSegment?.(seg);
      },
    });
    tokenProcessor.setTargetLang(opts.config.targetLang || '');

    const sonioxConfig = buildSonioxConfig(opts.config);

    recordingHandle = await startSonioxRecording(
      sonioxConfig,
      opts.authToken,
      {
        onPartialResult: (tokens: unknown[]) => {
          tokenProcessor.processTokens(tokens as RealtimeToken[]);
        },
        onEndpoint: () => {
          tokenProcessor.onEndpoint();
        },
        onError: (err: Error) => {
          opts.onError?.(err);
        },
        onConnectionChange: () => { /* ignore */ },
      },
      {
        sourceType: 'mic',
        preAcquiredStream: mediaStream,
        regionPreference: opts.config.sonioxRegionPreference,
      }
    );

    if (canceled) { cleanup(); throw new Error('已取消'); }

    // 4. 开始播放（即开始向 Soniox 推送音频）
    await audioEl.play();

    // 进度上报
    const progressInterval = setInterval(() => {
      if (!audioEl) return;
      const p = Math.min(1, audioEl.currentTime / Math.max(0.01, audioEl.duration));
      opts.onProgress?.(p);
    }, 250);

    // 5. 等播放结束 + Soniox 处理尾部 token
    await new Promise<void>((resolve, reject) => {
      audioEl!.addEventListener('ended', () => resolve(), { once: true });
      audioEl!.addEventListener('error', () => reject(new Error('音频播放出错')), { once: true });
    });

    clearInterval(progressInterval);
    opts.onProgress?.(1);

    // 留点时间给 Soniox 处理最后一批 token
    await new Promise((r) => setTimeout(r, 1500));

    // 强制 flush 当前未结算的非 final token
    tokenProcessor.onEndpoint();

    // 优先使用流式 onSegmentFinalized 收到的 segments；如果为空，回退到 buildAllSegments()
    const finalSegments =
      collectedSegments.length > 0 ? collectedSegments : tokenProcessor.buildAllSegments();

    cleanup();

    return {
      segments: finalSegments,
      durationMs,
    };
  })().catch((err) => {
    cleanup();
    throw err;
  });

  return {
    promise,
    cancel: () => {
      canceled = true;
      cleanup();
    },
  };
}
