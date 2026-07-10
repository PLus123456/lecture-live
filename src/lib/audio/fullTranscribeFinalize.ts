/**
 * 完整版补全转录的「收尾（finalize）」+ 计费逻辑。
 *
 * 与 asyncTranscribeFinalize（上传文件转录）**平行且独立**：用一套独立的 full* 字段
 * （fullTranscribeStatus / fullTranscriptPath / fullSonioxTranscriptionId …），产出一份
 * 「独立并列」的完整转录，**绝不覆盖**实时录音的 transcriptPath / recordingPath / status。
 *
 * 幂等 & 计费（关键，不可漂移）：靠两道条件原子 updateMany —
 *   (a) claim：WHERE fullTranscribeStatus='transcribing' → 'finalizing'，抢到(count===1)才继续；
 *   (b) finalize 守卫：WHERE fullTranscribeStatus='finalizing' → 'completed'，抢不到则不扣费。
 * 故对同一 session，补全转录的扣费恰好执行一次（前端 poll 与 cron 回收互斥，绝不双扣）。
 * 计费口径：ceil(getBillableMinutes(durationMs) × async_upload_billing_multiplier)，与异步上传
 * 转录同口径（倍率默认 0.8、admin 可配）。
 */
import fs from 'fs/promises';
import path from 'path';
import type { Session } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { SonioxRuntimeConfig } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
  getSonioxTranscript,
} from '@/lib/soniox/asyncFile';
import {
  convertAsyncTokensToSegments,
  extractTranslationsByTokens,
} from '@/lib/soniox/asyncTranscriptConverter';
import { deductTranscriptionMinutes } from '@/lib/quota';
import { getBillableMinutes } from '@/lib/billing';
import { getSiteSettings } from '@/lib/siteSettings';

const FULL_TRANSCRIPTS_DIR = path.join(process.cwd(), 'data', 'full-transcripts');

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** 完整版转录落盘引用（本地）。回放页新端点据此读取，与实时 transcriptPath 完全分离。 */
export function fullTranscriptReference(sessionId: string): string {
  return `local:full-transcripts/${normalizeSessionId(sessionId)}.json`;
}

function fullTranscriptLocalPath(sessionId: string): string {
  return path.join(FULL_TRANSCRIPTS_DIR, `${normalizeSessionId(sessionId)}.json`);
}

/** 原子写（tmp+rename），避免半截损坏的 JSON。 */
async function writeJsonAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function persistFullTranscript(
  sessionId: string,
  bundle: { segments: unknown[]; summaries: unknown[]; translations: Record<string, string> }
): Promise<string> {
  await fs.mkdir(FULL_TRANSCRIPTS_DIR, { recursive: true });
  await writeJsonAtomic(fullTranscriptLocalPath(sessionId), JSON.stringify(bundle, null, 2));
  return fullTranscriptReference(sessionId);
}

export interface FullTranscriptBundle {
  segments: unknown[];
  summaries: unknown[];
  translations: Record<string, string>;
}

/**
 * 从 fullTranscriptPath 引用解析出本地文件路径。
 * 阶段B 只落本地（`local:full-transcripts/{id}.json`）；阶段C 接 Cloudreve 时在读取端扩展远程分支。
 * 用 path.basename 收口，杜绝路径穿越；无引用则回退按 sessionId 约定路径（兼容文件已落盘但
 * path 尚未写回 DB 的边缘态）。
 */
function resolveLocalFullTranscriptPath(
  session: Pick<Session, 'id' | 'fullTranscriptPath'>
): string {
  const ref = session.fullTranscriptPath;
  if (ref && ref.startsWith('local:')) {
    const remainder = ref.slice('local:'.length); // e.g. full-transcripts/{id}.json
    return path.join(FULL_TRANSCRIPTS_DIR, path.basename(remainder));
  }
  return fullTranscriptLocalPath(session.id);
}

/**
 * 读取完整版补全转录 bundle（回放页「完整版」视图 + 读取端点 GET full-transcript 用）。
 * 找不到 / JSON 损坏 → null（调用方降级为空）。字段做防御性归一，绝不抛。
 */
export async function loadFullTranscript(
  session: Pick<Session, 'id' | 'fullTranscriptPath'>
): Promise<FullTranscriptBundle | null> {
  const filePath = resolveLocalFullTranscriptPath(session);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Partial<FullTranscriptBundle>;
  const translations =
    record.translations && typeof record.translations === 'object' && !Array.isArray(record.translations)
      ? Object.fromEntries(
          Object.entries(record.translations as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string'
          ) as [string, string][]
        )
      : {};

  return {
    segments: Array.isArray(record.segments) ? record.segments : [],
    summaries: Array.isArray(record.summaries) ? record.summaries : [],
    translations,
  };
}

export type FinalizableFullSession = Pick<
  Session,
  'id' | 'userId' | 'fullSonioxFileId' | 'fullSonioxTranscriptionId' | 'targetLang' | 'durationMs'
>;

export type FinalizeFullResult =
  | { outcome: 'claim_lost' }
  | { outcome: 'canceled_during_finalize' }
  | { outcome: 'completed'; fullTranscriptPath: string; segmentCount: number };

/**
 * 收尾一份「Soniox 侧已 completed」的完整版补全转录。调用前提：调用方已确认 Soniox job completed。
 * 不 poll Soniox 状态，只抢锁 + 拉 transcript + 落 fullTranscriptPath + 扣费。
 */
export async function finalizeFullTranscription(
  session: FinalizableFullSession,
  sonioxConfig: SonioxRuntimeConfig
): Promise<FinalizeFullResult> {
  const transcriptionId = session.fullSonioxTranscriptionId;
  if (!transcriptionId) {
    return { outcome: 'claim_lost' };
  }

  // ── 条件原子 claim：transcribing → finalizing ──
  const claim = await prisma.session.updateMany({
    where: { id: session.id, fullTranscribeStatus: 'transcribing' },
    data: { fullTranscribeStatus: 'finalizing' },
  });
  if (claim.count !== 1) {
    return { outcome: 'claim_lost' };
  }

  const transcript = await getSonioxTranscript(sonioxConfig, transcriptionId);
  const segments = convertAsyncTokensToSegments(transcript.tokens, {
    targetLang: session.targetLang,
  });
  const translations = extractTranslationsByTokens(transcript.tokens, segments);
  const bundle = { segments, summaries: [] as unknown[], translations };

  // 落盘到独立的 full-transcripts（**不碰** transcriptPath / recordingPath / status）。
  const fullPath = await persistFullTranscript(session.id, bundle);

  // finalize 守卫：finalizing → completed，抢不到（收尾期间被取消/重置）则不扣费。
  const finalized = await prisma.session.updateMany({
    where: { id: session.id, fullTranscribeStatus: 'finalizing' },
    data: {
      fullTranscribeStatus: 'completed',
      fullTranscriptPath: fullPath,
      fullSonioxFileId: null,
      fullSonioxTranscriptionId: null,
    },
  });
  if (finalized.count !== 1) {
    if (session.fullSonioxFileId) {
      await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => undefined);
    }
    await deleteSonioxTranscription(sonioxConfig, transcriptionId).catch(() => undefined);
    return { outcome: 'canceled_during_finalize' };
  }

  // ── 计费（额外按异步倍率扣，与异步上传转录同口径）──
  // claim + finalize 守卫共同保证仅一个路径进到此分支且未被取消，故恰好扣一次。
  // 计费失败不影响转录完成，留给对账兜底。
  try {
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const billableMinutes = Math.ceil(
      getBillableMinutes(session.durationMs) * async_upload_billing_multiplier
    );
    if (billableMinutes > 0) {
      await deductTranscriptionMinutes(session.userId, billableMinutes);
    }
  } catch (billingErr) {
    logger.error(
      { err: billingErr, sessionId: session.id },
      'full transcribe billing deduct failed (transcription already completed)'
    );
  }

  // 清 Soniox 资源（幂等，失败不抛）
  if (session.fullSonioxFileId) {
    await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => undefined);
  }
  await deleteSonioxTranscription(sonioxConfig, transcriptionId).catch(() => undefined);

  return { outcome: 'completed', fullTranscriptPath: fullPath, segmentCount: segments.length };
}
