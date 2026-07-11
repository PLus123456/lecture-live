/**
 * 完整版补全转录的后台处理管线（平行于 asyncUploadProcessor，但源是「会话已存的完整音频」）。
 *
 * 与 async-upload 完全独立：读会话已有 recordingPath 的完整音频（含断网续采段）→ 转码 MP3 →
 * 上传 Soniox → 建异步转录任务，全程用 fullTranscribeStatus 状态机，**不动**任何实时录音产物。
 * 状态机：pending → transcoding → transcribing → (finalize) → completed / failed
 */
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { probeDurationSec, transcodeToMp3, validateMediaContainer } from '@/lib/audio/ffmpegTranscode';
import { loadSessionAudioArtifact } from '@/lib/sessionPersistence';
import { resolveAndPersistTaskRegion } from '@/lib/soniox/env';
import {
  uploadSonioxFile,
  createSonioxTranscription,
  deleteSonioxFile,
} from '@/lib/soniox/asyncFile';
import { settleFullReservation } from '@/lib/quota';

const SONIOX_MAX_DURATION_SEC = 300 * 60;
const TMP_ROOT = path.join(process.cwd(), 'data', 'full-transcribe-tmp');

class PipelineHaltError extends Error {
  constructor() {
    super('Full transcribe halted: session no longer in active state');
    this.name = 'PipelineHaltError';
  }
}

/**
 * 条件原子状态推进：仅当 fullTranscribeStatus ∈ allowedFrom 时才写 next。抢不到（被取消/
 * 重置）返回 false，调用方 halt。避免与用户取消 / 并发触发竞态。
 */
async function setFullStatus(
  sessionId: string,
  next: string,
  allowedFrom: string[],
  extra?: Record<string, unknown>
): Promise<boolean> {
  const res = await prisma.session.updateMany({
    where: { id: sessionId, fullTranscribeStatus: { in: allowedFrom } },
    data: { fullTranscribeStatus: next, ...(extra ?? {}) },
  });
  return res.count === 1;
}

/**
 * fire-and-forget 后台处理。由触发路由 claim 到 'pending' 之后调用（不阻塞响应）。
 * 任何步骤失败 → 标 failed + 记录 error；被取消（claim 抢不到）→ 静默 halt。
 */
export async function processFullTranscribe(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const tmpDir = path.join(TMP_ROOT, sessionId.replace(/[^a-zA-Z0-9_-]/g, ''));
  let uploadedFileId: string | null = null;
  let sonioxConfig: Awaited<ReturnType<typeof resolveAndPersistTaskRegion>> | null = null;

  try {
    // pending → transcoding
    if (!(await setFullStatus(sessionId, 'transcoding', ['pending']))) {
      throw new PipelineHaltError();
    }

    // 读会话完整音频（含断网续采段）
    const audio = await loadSessionAudioArtifact(session);
    if (!audio || audio.data.length === 0) {
      throw new Error('Session recording not found or empty');
    }

    await fs.mkdir(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, audio.fileName || 'input.webm');
    await fs.writeFile(inputPath, audio.data);

    // 容器安全校验（P1-11）：交给 ffprobe/ffmpeg 前先做魔数 + demuxer 白名单，拒 playlist /
    // 外部引用。会话音频虽由本系统产出，但引用可能来自 Cloudreve/历史数据，仍统一过闸。
    await validateMediaContainer(inputPath);

    const inputDurationSec = await probeDurationSec(inputPath);
    if (inputDurationSec > SONIOX_MAX_DURATION_SEC) {
      throw new Error(
        `Duration ${Math.round(inputDurationSec / 60)} min exceeds Soniox 300-min limit`
      );
    }

    // 转码 MP3（流式 WebM 容器头常缺时长，转码后以 MP3 probe 为权威）
    const mp3Path = path.join(tmpDir, 'audio.mp3');
    await transcodeToMp3({
      inputPath,
      outputPath: mp3Path,
      durationSec: inputDurationSec || undefined,
      bitrateKbps: 128,
    });

    const durationSec = (await probeDurationSec(mp3Path)) || inputDurationSec;
    if (!durationSec) {
      throw new Error('Cannot detect audio duration — recording may be corrupted');
    }
    if (durationSec > SONIOX_MAX_DURATION_SEC) {
      throw new Error(
        `Duration ${Math.round(durationSec / 60)} min exceeds Soniox 300-min limit`
      );
    }

    // P1-16：任务开始时解析并**持久化实际 region** 到 session.sonioxRegion，之后 poll/finalize/
    // cancel/maintenance 全部读该字段解析同一 region，绝不落回可变默认 region。
    sonioxConfig = await resolveAndPersistTaskRegion(sessionId, session.sonioxRegion);
    if (!sonioxConfig) throw new Error('Soniox credentials not configured');

    const sonioxFile = await uploadSonioxFile(sonioxConfig, mp3Path, {
      filename: `${sessionId}-full.mp3`,
      clientReferenceId: `${sessionId}-full`,
    });
    uploadedFileId = sonioxFile.id;

    const translation =
      session.targetLang && session.targetLang !== session.sourceLang
        ? ({ type: 'one_way', target_language: session.targetLang } as const)
        : undefined;

    const job = await createSonioxTranscription(sonioxConfig, {
      fileId: sonioxFile.id,
      languageHints: session.sourceLang ? [session.sourceLang] : undefined,
      // 与 realtime 一致开启语言识别：否则 token 不带 language 字段，分段的 language
      // 会全部落到 'en' 兜底（非英文上传标签错）。source 语言仍由 languageHints 提供。
      enableLanguageIdentification: true,
      enableSpeakerDiarization: true,
      translation,
      clientReferenceId: `${sessionId}-full`,
    });

    // transcoding → transcribing（+ Soniox 引用）。抢不到（被取消）→ 清 Soniox 文件 + halt。
    if (
      !(await setFullStatus(sessionId, 'transcribing', ['transcoding'], {
        fullSonioxFileId: sonioxFile.id,
        fullSonioxTranscriptionId: job.id,
      }))
    ) {
      await deleteSonioxFile(sonioxConfig, sonioxFile.id).catch(() => undefined);
      throw new PipelineHaltError();
    }

    // 清理本地临时文件（容忍失败，留给 cron 兜底）
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  } catch (err) {
    // 清理临时文件
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

    if (err instanceof PipelineHaltError) {
      // 被取消/竞态：不覆盖最终状态、不当错误上报。
      return;
    }

    // 上传到 Soniox 后才失败：清掉刚上传的文件避免泄漏配额。
    if (uploadedFileId && sonioxConfig) {
      await deleteSonioxFile(sonioxConfig, uploadedFileId).catch(() => undefined);
    }

    const message = err instanceof Error ? err.message : 'Full transcribe failed';
    logger.error({ err, sessionId }, 'full transcribe pipeline failed');
    // 仅当仍处于活动态时才标 failed（避免覆盖用户取消）。
    const marked = await setFullStatus(sessionId, 'failed', ['pending', 'transcoding'], {
      fullTranscribeError: message.slice(0, 500),
    }).catch(() => false);
    // R4：抢到 failed 终态（恰好一次）→ 释放入口持有的转录分钟预留（fullReservedMinutes）。
    // settleFullReservation 用 FOR UPDATE 读当前列并原子释放，与 finalize 结算 / 删会话 / cron
    // releaseOrphanFullReservations 互斥，恰好释放一次。
    if (marked) {
      await settleFullReservation(sessionId).catch(() => undefined);
    }
  }
}
