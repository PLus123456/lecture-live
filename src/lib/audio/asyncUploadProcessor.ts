/**
 * Async 上传的后台处理 pipeline：合并 chunks → ffmpeg 转码 → 存盘 → 上传 Soniox
 * → 创建 transcription。
 *
 * 设计成 fire-and-forget：finalize 路由立即返回，调用方通过 status 路由轮询进度。
 * 每个阶段更新 session.asyncTranscribeStatus 推动前端进度条。
 *
 * 失败处理：任何环节出错都把 session 标为 failed + 写入 error message，
 * 并清理本地临时文件。Soniox 上的文件如果已经上传，留给 cron 兜底（这里
 * 简单删一次）。
 */
import path from 'path';
import fs from 'fs/promises';
import type { Session } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { logger } from '@/lib/logger';
import {
  deleteAsyncUpload,
  loadAsyncUploadManifest,
  mergeAsyncUploadChunks,
} from '@/lib/audio/asyncUploadChunkPersistence';
import { probeDurationSec, transcodeToMp3 } from '@/lib/audio/ffmpegTranscode';
import { persistSessionAudioArtifact } from '@/lib/sessionPersistence';
import { resolveSonioxRuntimeConfigAsync } from '@/lib/soniox/env';
import {
  createSonioxTranscription,
  deleteSonioxFile,
  deleteSonioxTranscription,
  uploadSonioxFile,
  type SonioxTranslationConfig,
} from '@/lib/soniox/asyncFile';

export type AsyncTranscribeStatus =
  | 'uploading_chunks'
  | 'transcoding'
  | 'uploading_to_soniox'
  | 'transcribing'
  | 'finalizing'  // status route 抢锁后的瞬时状态：拉 transcript + 写盘
  | 'completed'
  | 'failed'
  | 'canceled';

interface ProcessOptions {
  sessionId: string;
}

/**
 * transcoding 阶段的 ffmpeg 实时进度。status route 读取并返回给前端做进度条。
 * 内存 map 在 dev 和 prod（单 Next 进程）都够用；多进程部署需要换成 Redis。
 */
const transcodingProgressMap = new Map<string, number>();

export function getTranscodingProgress(sessionId: string): number {
  return transcodingProgressMap.get(sessionId) ?? 0;
}

/**
 * 更新 session 状态。
 *
 * 用 updateMany WHERE asyncTranscribeStatus NOT IN ('canceled', 'failed', 'completed')
 * 而不是裸 update —— 一旦 session 已经被用户取消（cancelAsyncUpload 设了 canceled）
 * 或前序步骤标失败，后续 setStatus 不应再把状态打回去。
 */
async function setStatus(
  sessionId: string,
  status: AsyncTranscribeStatus,
  extra: Partial<{
    sonioxFileId: string | null;
    sonioxTranscriptionId: string | null;
    recordingPath: string | null;
    durationMs: number;
    asyncTranscribeError: string | null;
  }> = {}
): Promise<boolean> {
  const result = await prisma.session.updateMany({
    where: {
      id: sessionId,
      asyncTranscribeStatus: { notIn: ['canceled', 'failed', 'completed'] },
    },
    data: {
      asyncTranscribeStatus: status,
      ...extra,
    },
  });
  return result.count === 1;
}

/**
 * 启动后台 pipeline。不返回 Promise（fire-and-forget），错误自己处理。
 *
 * Session.asyncTranscribeStatus 本身就是任务状态机，无需另开 JobQueue 行重复跟踪。
 */
export function startAsyncUploadProcessing(opts: ProcessOptions): void {
  // 不 await。Next.js standalone Node 进程长期存活，promise 会跑完。
  void processAsyncUpload(opts).catch((err) => {
    logger.error(
      { err, sessionId: opts.sessionId },
      'async upload background processing crashed'
    );
  });
}

/**
 * 如果 setStatus 返回 false（被取消/已失败/已完成），抛 PipelineHaltError 让
 * 外层捕获后**不再覆盖**最终状态，也不当错误上报。
 */
class PipelineHaltError extends Error {
  constructor() {
    super('Pipeline halted: session no longer in active state');
    this.name = 'PipelineHaltError';
  }
}

async function processAsyncUpload(opts: ProcessOptions): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: opts.sessionId } });
  if (!session) throw new Error('Session not found');

  try {
    // ── 1. merge chunks ──
    if (!(await setStatus(session.id, 'transcoding'))) throw new PipelineHaltError();
    const manifest = await loadAsyncUploadManifest(session);
    if (!manifest) throw new Error('Upload manifest missing');
    if (manifest.receivedSeqs.length !== manifest.totalChunks) {
      throw new Error(
        `Missing chunks: ${manifest.receivedSeqs.length} of ${manifest.totalChunks}`
      );
    }
    const merged = await mergeAsyncUploadChunks(session);
    const mergedPath = merged.filePath;

    // ── 2. probe duration ──
    const durationSec = await probeDurationSec(mergedPath);
    if (!durationSec) {
      throw new Error('Cannot detect audio duration — file may be corrupted');
    }
    // Soniox 单文件上限 300 分钟
    if (durationSec > 300 * 60) {
      throw new Error(
        `Duration ${Math.round(durationSec / 60)} min exceeds Soniox 300-min limit`
      );
    }

    // ── 3. ffmpeg → mp3 ──
    const mp3Path = path.join(path.dirname(mergedPath), 'audio.mp3');
    transcodingProgressMap.set(session.id, 0);
    try {
      await transcodeToMp3({
        inputPath: mergedPath,
        outputPath: mp3Path,
        durationSec,
        bitrateKbps: 128,
        onProgress: (fraction) => {
          transcodingProgressMap.set(session.id, fraction);
        },
      });
    } finally {
      transcodingProgressMap.delete(session.id);
    }

    // ── 4. persist mp3 → session storage (for playback) ──
    const mp3Buffer = await fs.readFile(mp3Path);
    const stored = await persistSessionAudioArtifact(session, mp3Buffer, 'audio/mpeg');

    const durationMs = Math.round(durationSec * 1000);
    if (
      !(await setStatus(session.id, 'uploading_to_soniox', {
        recordingPath: stored.path,
        durationMs,
      }))
    ) {
      throw new PipelineHaltError();
    }
    await invalidateSessionsApiCache(session.userId);

    // ── 5. upload to Soniox ──
    const sonioxConfig = await resolveSonioxRuntimeConfigAsync({});
    if (!sonioxConfig) throw new Error('Soniox credentials not configured');

    const sonioxFile = await uploadSonioxFile(sonioxConfig, mp3Path, {
      filename: `${session.id}.mp3`,
      clientReferenceId: session.id,
    });

    if (
      !(await setStatus(session.id, 'uploading_to_soniox', {
        sonioxFileId: sonioxFile.id,
      }))
    ) {
      // 状态已变（取消/失败）—— 把刚上传的 Soniox 文件清掉，避免泄漏配额
      await deleteSonioxFile(sonioxConfig, sonioxFile.id).catch(() => undefined);
      throw new PipelineHaltError();
    }

    // ── 6. create transcription ──
    const translation: SonioxTranslationConfig | undefined =
      session.targetLang && session.targetLang !== session.sourceLang
        ? { type: 'one_way', target_language: session.targetLang }
        : undefined;

    const job = await createSonioxTranscription(sonioxConfig, {
      fileId: sonioxFile.id,
      languageHints: session.sourceLang ? [session.sourceLang] : undefined,
      enableLanguageIdentification: false,
      translation,
      clientReferenceId: session.id,
    });

    if (
      !(await setStatus(session.id, 'transcribing', {
        sonioxTranscriptionId: job.id,
      }))
    ) {
      // 取消发生在 createTranscription 之后：清 Soniox 端 transcription + file
      await deleteSonioxTranscription(sonioxConfig, job.id).catch(() => undefined);
      await deleteSonioxFile(sonioxConfig, sonioxFile.id).catch(() => undefined);
      throw new PipelineHaltError();
    }

    // ── 7. cleanup local upload dir（chunks + merged + mp3） ──
    await deleteAsyncUpload(session);
  } catch (error) {
    // 取消导致的提前退出：状态由 cancelAsyncUpload 维护，这里不覆盖
    if (error instanceof PipelineHaltError) {
      await deleteAsyncUpload(session).catch(() => undefined);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { sessionId: session.id, err: error },
      'async upload pipeline failed'
    );
    // setStatus 自带 notIn guard：如果用户已经取消，这里不会把 canceled 改成 failed
    try {
      await setStatus(session.id, 'failed', { asyncTranscribeError: message });
    } catch (innerErr) {
      logger.error({ innerErr }, 'failed to mark session as failed');
    }
    // 清理本地文件（容忍二次失败）
    await deleteAsyncUpload(session).catch(() => undefined);
    // 如果已经上传到 Soniox 但后续步骤失败，尽力清理；失败留给后续 cron
    const refreshed = await prisma.session.findUnique({ where: { id: session.id } });
    if (refreshed?.sonioxFileId) {
      const config = await resolveSonioxRuntimeConfigAsync({}).catch(() => null);
      if (config) {
        await deleteSonioxFile(config, refreshed.sonioxFileId).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    transcodingProgressMap.delete(session.id);
  }
}

/**
 * 取消正在进行的 async 上传。
 *
 * - session.asyncTranscribeStatus → 'canceled'
 * - sonioxFileId / sonioxTranscriptionId 清空（避免 cron 误删已被回收的资源，
 *   也避免 status route 在终态后还试图 poll Soniox）
 * - 本地 chunks/merged/mp3 立刻删
 * - 内存中的 transcoding progress 立刻清
 * - Soniox 上的文件也尽力删
 */
export async function cancelAsyncUpload(
  session: Pick<Session, 'id' | 'sonioxFileId'>
): Promise<void> {
  await setStatus(session.id, 'canceled', {
    sonioxFileId: null,
    sonioxTranscriptionId: null,
  });
  transcodingProgressMap.delete(session.id);
  await deleteAsyncUpload({ id: session.id }).catch(() => undefined);
  if (session.sonioxFileId) {
    const config = await resolveSonioxRuntimeConfigAsync({}).catch(() => null);
    if (config) {
      await deleteSonioxFile(config, session.sonioxFileId).catch(() => undefined);
    }
  }
}
