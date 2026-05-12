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
) {
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      asyncTranscribeStatus: status,
      ...extra,
    },
  });
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

async function processAsyncUpload(opts: ProcessOptions): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: opts.sessionId } });
  if (!session) throw new Error('Session not found');

  let mergedPath: string | null = null;
  let mp3Path: string | null = null;

  try {
    // ── 1. merge chunks ──
    await setStatus(session.id, 'transcoding');
    const manifest = await loadAsyncUploadManifest(session);
    if (!manifest) throw new Error('Upload manifest missing');
    if (manifest.receivedSeqs.length !== manifest.totalChunks) {
      throw new Error(
        `Missing chunks: ${manifest.receivedSeqs.length} of ${manifest.totalChunks}`
      );
    }
    const merged = await mergeAsyncUploadChunks(session);
    mergedPath = merged.filePath;

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
    mp3Path = path.join(path.dirname(mergedPath), 'audio.mp3');
    await transcodeToMp3({
      inputPath: mergedPath,
      outputPath: mp3Path,
      durationSec,
      bitrateKbps: 128,
    });

    // ── 4. persist mp3 → session storage (for playback) ──
    const mp3Buffer = await fs.readFile(mp3Path);
    const stored = await persistSessionAudioArtifact(session, mp3Buffer, 'audio/mpeg');

    const durationMs = Math.round(durationSec * 1000);
    await setStatus(session.id, 'uploading_to_soniox', {
      recordingPath: stored.path,
      durationMs,
    });
    await invalidateSessionsApiCache(session.userId);

    // ── 5. upload to Soniox ──
    const sonioxConfig = await resolveSonioxRuntimeConfigAsync({});
    if (!sonioxConfig) throw new Error('Soniox credentials not configured');

    const sonioxFile = await uploadSonioxFile(sonioxConfig, mp3Path, {
      filename: `${session.id}.mp3`,
      clientReferenceId: session.id,
    });

    await setStatus(session.id, 'uploading_to_soniox', {
      sonioxFileId: sonioxFile.id,
    });

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

    await setStatus(session.id, 'transcribing', {
      sonioxTranscriptionId: job.id,
    });

    // ── 7. cleanup local upload dir（chunks + merged + mp3） ──
    await deleteAsyncUpload(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { sessionId: session.id, err: error },
      'async upload pipeline failed'
    );
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
    // 局部变量本来就是 path 引用，文件由 deleteAsyncUpload 统一删
    void mergedPath;
    void mp3Path;
  }
}

/**
 * 取消正在进行的 async 上传。把 session 标为 canceled 并清理本地文件。
 * 已上传到 Soniox 的文件也尽力清理。
 */
export async function cancelAsyncUpload(
  session: Pick<Session, 'id' | 'sonioxFileId'>
): Promise<void> {
  await setStatus(session.id, 'canceled');
  await deleteAsyncUpload({ id: session.id }).catch(() => undefined);
  if (session.sonioxFileId) {
    const config = await resolveSonioxRuntimeConfigAsync({}).catch(() => null);
    if (config) {
      await deleteSonioxFile(config, session.sonioxFileId).catch(() => undefined);
    }
  }
}
