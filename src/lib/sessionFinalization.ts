import type { Prisma, SessionStatus } from '@prisma/client';
import type { UserPayload } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import {
  mergeRecordingDraftChunks,
  deleteRecordingDraft,
} from '@/lib/recordingDraftPersistence';
import {
  loadTranscriptDraft,
  deleteTranscriptDraft,
} from '@/lib/transcriptDraftPersistence';
import {
  persistSessionAudioArtifact,
  persistSessionTranscriptArtifacts,
  extractTranscriptText,
  loadSessionTranscriptBundle,
  persistSessionReport,
  type PersistedTranscriptBundle,
} from '@/lib/sessionPersistence';
import {
  resolveServerRecordingDurationMs,
  resolveTranscriptDurationMs,
  normalizeRecordedAudioDuration,
} from '@/lib/audio/recordingDuration';
import { clampSessionDurationMs, getBillableMinutes } from '@/lib/billing';
import { deductTranscriptionMinutes } from '@/lib/quota';
import { callLLM, getProviderForPurpose } from '@/lib/llm/gateway';
import { extractAndAccumulateKeywords } from '@/lib/llm/folderKeywords';
import { generateSessionReport, generateSessionTitle } from '@/lib/llm/reportManager';
import { logSystemEvent } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import { trackJob, JOB_TYPE } from '@/lib/jobQueue';
import {
  invalidateFoldersApiCache,
  invalidateSessionsApiCache,
} from '@/lib/apiResponseCache';
import type { SummaryBlock } from '@/types/summary';

const FINALIZE_LOCK_STALE_MS = 15 * 60_000;

const EMPTY_TRANSCRIPT_BUNDLE: PersistedTranscriptBundle = {
  segments: [],
  summaries: [],
  translations: {},
};

type FinalizeSource = 'user' | 'unload' | 'system_auto_reclaim';

export class FinalizeSessionError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(
      typeof body.error === 'string' ? body.error : 'Failed to finalize session'
    );
    this.name = 'FinalizeSessionError';
    this.status = status;
    this.body = body;
  }
}

interface FinalizeSessionOptions {
  sessionId: string;
  actor: UserPayload | null;
  clientBundle?: PersistedTranscriptBundle | null;
  clientDurationMs?: number;
  clientTitle?: string;
  allowStatusPromotion?: boolean;
  finalizeSource?: FinalizeSource;
}

interface FinalizeSessionResult {
  success: true;
  alreadyCompleted?: boolean;
  recordingPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  durationMs?: number;
  transcriptMissing?: boolean;
  recordingMissing?: boolean;
}

type FinalizeSessionRecord = NonNullable<
  Awaited<ReturnType<typeof loadSessionForFinalize>>
>;

export async function finalizeSession(
  options: FinalizeSessionOptions
): Promise<FinalizeSessionResult> {
  let session = await loadSessionForFinalize(options.sessionId);
  if (!session) {
    throw new FinalizeSessionError(404, { error: 'Session not found' });
  }

  if (options.actor) {
    try {
      assertOwnership(options.actor.id, session.userId);
    } catch {
      throw new FinalizeSessionError(403, { error: 'Access denied' });
    }
  }

  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return {
      success: true,
      alreadyCompleted: true,
      recordingPath: session.recordingPath,
      transcriptPath: session.transcriptPath,
      summaryPath: session.summaryPath,
      durationMs: session.durationMs,
    };
  }

  if (session.status !== 'FINALIZING') {
    const canPromote =
      options.allowStatusPromotion === true &&
      (session.status === 'RECORDING' || session.status === 'PAUSED');

    if (!canPromote) {
      throw new FinalizeSessionError(409, {
        error: `Session status must be FINALIZING, got ${session.status}`,
      });
    }

    await promoteSessionToFinalizing(session);
    session = await loadSessionForFinalize(options.sessionId);
    if (!session) {
      throw new FinalizeSessionError(404, { error: 'Session not found' });
    }

    if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
      return {
        success: true,
        alreadyCompleted: true,
        recordingPath: session.recordingPath,
        transcriptPath: session.transcriptPath,
        summaryPath: session.summaryPath,
        durationMs: session.durationMs,
      };
    }

    if (session.status !== 'FINALIZING') {
      throw new FinalizeSessionError(409, {
        error: `Session status must be FINALIZING, got ${session.status}`,
      });
    }
  }

  // U43：记录本次获取锁的确切时间戳，作为幂等令牌。最终事务只在
  // finalizeLockedAt 仍等于此值时才提交扣费 —— 若期间被 stale-lock 接管（另一 finalizer
  // 写入了不同的 finalizeLockedAt）或对方已把状态推到 COMPLETED（锁被置 null），条件不成立、
  // count===0，本 finalizer 跳过扣费与后台任务，杜绝双重扣费/重复 LLM 任务。
  const lockTimestamp = new Date();
  const lockAcquired = await prisma.session.updateMany({
    where: {
      id: options.sessionId,
      status: 'FINALIZING',
      OR: [
        { finalizeLockedAt: null },
        {
          finalizeLockedAt: {
            lt: new Date(lockTimestamp.getTime() - FINALIZE_LOCK_STALE_MS),
          },
        },
      ],
    },
    data: {
      finalizeLockedAt: lockTimestamp,
    },
  });

  if (lockAcquired.count === 0) {
    const latest = await prisma.session.findUnique({
      where: { id: options.sessionId },
      select: {
        status: true,
        finalizeLockedAt: true,
        recordingPath: true,
        transcriptPath: true,
        summaryPath: true,
        durationMs: true,
      },
    });

    if (latest?.status === 'COMPLETED' || latest?.status === 'ARCHIVED') {
      return {
        success: true,
        alreadyCompleted: true,
        recordingPath: latest.recordingPath,
        transcriptPath: latest.transcriptPath,
        summaryPath: latest.summaryPath,
        durationMs: latest.durationMs,
      };
    }

    throw new FinalizeSessionError(409, {
      error: 'Session is already being finalized',
    });
  }

  try {
    let transcriptPath = session.transcriptPath;
    let summaryPath = session.summaryPath;
    let bundle: PersistedTranscriptBundle | null = null;
    let transcriptMissing = false;

    if (!transcriptPath) {
      bundle = await resolveTranscriptBundle(session, options.clientBundle);
      if (!bundle || bundle.segments.length === 0) {
        bundle = {
          segments: [],
          summaries: [],
          translations: {},
        };
        transcriptMissing = true;
      }
    } else {
      bundle = await loadSessionTranscriptBundle(session).catch(() => null);
    }

    const normalizedClientDurationMs =
      typeof options.clientDurationMs === 'number' &&
      Number.isFinite(options.clientDurationMs) &&
      options.clientDurationMs > 0
        ? options.clientDurationMs
        : undefined;
    const transcriptDurationMs = resolveTranscriptDurationMs(bundle);
    const serverDurationMs = resolveServerRecordingDurationMs(session);
    const legacyDurationFallbackMs =
      !session.serverStartedAt &&
      transcriptDurationMs === 0 &&
      (session.durationMs ?? 0) === 0
        ? Math.max(0, normalizedClientDurationMs ?? 0)
        : 0;
    // 自动回收（客户端崩溃/长时间无活动被 reclaim）时不信服务端墙钟时长：serverStartedAt 到
    // now 的墙钟含全部暂停/挂机空闲，客户端没能上报暂停时会把空闲整段当录音计费、超额扣配额
    // （审计 medium）。此路径改以实际转录覆盖的时长为准（更接近真实录音量，宁少勿多）。
    const isAutoReclaim = options.finalizeSource === 'system_auto_reclaim';
    const resolvedDurationMs = Math.max(
      session.durationMs ?? 0,
      transcriptDurationMs,
      isAutoReclaim ? 0 : serverDurationMs,
      legacyDurationFallbackMs
    );
    const finalDurationMs = clampSessionDurationMs(
      resolvedDurationMs,
      session.user.role
    );
    const billableMinutes = getBillableMinutes(finalDurationMs);

    if (
      normalizedClientDurationMs &&
      Math.abs(normalizedClientDurationMs - finalDurationMs) >= 60_000
    ) {
      logger.warn(
        {
          sessionId: session.id,
          clientMs: normalizedClientDurationMs,
          serverMs: serverDurationMs,
          transcriptMs: transcriptDurationMs,
          finalMs: finalDurationMs,
        },
        '[finalize] duration mismatch'
      );
    }

    let recordingPath = session.recordingPath;
    let recordingMissing = false;
    // C14：记录本次是否消费了草稿（合并录音/持久化转录成功）；草稿删除延后到最终事务
    // 提交成功之后，仅成功路径删。否则若事务回滚（如瞬时死锁/超时）而草稿已删，
    // 无 clientBundle 的重试会用空数据覆写永久转录、孤立录音——不可恢复的数据丢失。
    let shouldDeleteRecordingDraft = false;
    let shouldDeleteTranscriptDraft = false;
    // 本次收尾是否真正产出了 recordingPath。只有产出时才在提交事务里回写它，否则不覆盖
    // 数据库当前值 —— 否则会用「事前快照的 recordingPath」覆盖并发的 audio/draft/finalize
    // 刚写入的更新录音路径（审计 medium：竞态覆盖已定稿录音）。
    let recordingPathResolvedHere = false;

    if (!recordingPath) {
      const merged = await mergeRecordingDraftChunks(session);
      if (merged) {
        const normalizedBuffer = await normalizeRecordedAudioDuration({
          buffer: merged.buffer,
          mimeType: merged.manifest.mimeType,
          durationMs: finalDurationMs,
        });

        const storedAudio = await persistSessionAudioArtifact(
          session,
          normalizedBuffer,
          merged.manifest.mimeType
        );
        recordingPath = storedAudio.path;
        recordingPathResolvedHere = true;
        shouldDeleteRecordingDraft = true;
      } else {
        recordingMissing = true;
      }
    }

    if (!transcriptPath) {
      const stored = await persistSessionTranscriptArtifacts(
        session,
        bundle ?? EMPTY_TRANSCRIPT_BUNDLE
      );
      transcriptPath = stored.transcript.path;
      summaryPath = stored.summary.path;
      shouldDeleteTranscriptDraft = true;
    }

    const normalizedTitle =
      typeof options.clientTitle === 'string' && options.clientTitle.trim()
        ? options.clientTitle.trim().slice(0, 160)
        : undefined;
    const shouldDeduct = billableMinutes > 0 && session.user.role !== 'ADMIN';
    const commit = await prisma.$transaction(async (tx) => {
      // U43：条件原子提交 —— 仅当会话仍处于 FINALIZING 且 finalizeLockedAt 仍等于本次
      // 获取锁的时间戳时才 update。若 stale-lock 已被另一 finalizer 接管（写入不同
      // finalizeLockedAt）或对方已把状态推到 COMPLETED（锁置 null），count===0，
      // 本事务不扣费、返回 lockLost 标记，跳过后台任务，杜绝双重扣费与重复 LLM 任务。
      const updateResult = await tx.session.updateMany({
        where: {
          id: options.sessionId,
          status: 'FINALIZING',
          finalizeLockedAt: lockTimestamp,
        },
        data: {
          status: 'COMPLETED',
          // 只在本次真正产出录音时才回写 recordingPath，避免用事前快照覆盖并发写入的新值。
          ...(recordingPathResolvedHere ? { recordingPath } : {}),
          transcriptPath,
          summaryPath,
          finalizeLockedAt: null,
          serverPausedAt: null,
          durationMs: finalDurationMs,
          ...(normalizedTitle ? { title: normalizedTitle } : {}),
        },
      });

      if (updateResult.count === 0) {
        return { lockLost: true as const };
      }

      if (shouldDeduct) {
        // 走 deductTranscriptionMinutes（内含 ensureQuotaWindow 跨月度重置点窗口校正，
        // 修正裸 increment 把分钟加到未重置旧窗口的隐性 drift）；传入 tx 使"扣减 ⟺
        // status→COMPLETED"在同一事务原子提交（失败一起回滚，杜绝并发/重试双扣或漏扣）。
        await deductTranscriptionMinutes(session.userId, billableMinutes, tx);
      }

      const updated = await tx.session.findUnique({
        where: { id: options.sessionId },
      });
      return { lockLost: false as const, updated };
    });

    // U43：锁在处理期间被接管/会话已被对方 COMPLETED —— 本次不做任何写入/扣费/后台任务，
    // 按"已完成"返回当前库中真实状态，避免重复收尾。
    if (commit.lockLost) {
      const latest = await prisma.session.findUnique({
        where: { id: options.sessionId },
        select: {
          recordingPath: true,
          transcriptPath: true,
          summaryPath: true,
          durationMs: true,
        },
      });
      return {
        success: true,
        alreadyCompleted: true,
        recordingPath: latest?.recordingPath ?? recordingPath,
        transcriptPath: latest?.transcriptPath ?? transcriptPath,
        summaryPath: latest?.summaryPath ?? summaryPath,
        durationMs: latest?.durationMs ?? finalDurationMs,
      };
    }

    const updatedSession = commit.updated!;

    // C14：事务已成功提交，永久 artifact 的 path 与 COMPLETED 状态已落库，此时才删草稿。
    if (shouldDeleteRecordingDraft) {
      await deleteRecordingDraft(session).catch(() => undefined);
    }
    if (shouldDeleteTranscriptDraft) {
      await deleteTranscriptDraft(session).catch(() => undefined);
    }

    if (transcriptMissing) {
      logSystemEvent(
        'session.finalize.transcript_missing',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          source: options.finalizeSource ?? 'user',
          durationMs: finalDurationMs,
        })
      );
    }

    if (recordingMissing) {
      logSystemEvent(
        'session.finalize.recording_missing',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          source: options.finalizeSource ?? 'user',
          durationMs: finalDurationMs,
        })
      );
    }

    if (options.finalizeSource === 'system_auto_reclaim') {
      logSystemEvent(
        'session.auto_reclaimed',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          durationMs: finalDurationMs,
          billableMinutes,
          transcriptMissing,
          recordingMissing,
        })
      );
    }

    if (transcriptPath && summaryPath) {
      const folderIds = session.folders.map((folder) => folder.folderId);
      void runBackgroundLLMTasks({
        sessionId: session.id,
        userId: session.userId,
        transcriptPath,
        summaryPath,
        recordingPath,
        title: updatedSession.title,
        courseName: session.courseName ?? '',
        durationMs: updatedSession.durationMs,
        createdAt: session.createdAt,
        targetLang: session.targetLang || 'zh',
        folderIds,
        bundle,
      });
    }

    return {
      success: true,
      recordingPath,
      transcriptPath,
      summaryPath,
      durationMs: updatedSession.durationMs ?? undefined,
      transcriptMissing,
      recordingMissing,
    };
  } catch (error) {
    // U43：仅在仍持本次锁时释放（条件匹配 finalizeLockedAt=lockTimestamp），
    // 避免误清另一 finalizer 接管后写入的锁。
    await releaseFinalizeLock(options.sessionId, lockTimestamp);
    if (error instanceof FinalizeSessionError) {
      throw error;
    }
    throw error;
  }
}

async function loadSessionForFinalize(sessionId: string) {
  return prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      folders: {
        select: { folderId: true },
      },
      user: {
        select: {
          role: true,
          email: true,
        },
      },
    },
  });
}

async function promoteSessionToFinalizing(session: FinalizeSessionRecord) {
  const promotion = await prisma.session.updateMany({
    where: {
      id: session.id,
      status: session.status,
    },
    data: buildFinalizePromotionData(session),
  });

  if (promotion.count > 0) {
    return;
  }

  const latest = await prisma.session.findUnique({
    where: { id: session.id },
    select: { status: true },
  });

  if (latest?.status === 'COMPLETED' || latest?.status === 'ARCHIVED') {
    return;
  }

  if (latest?.status !== 'FINALIZING') {
    throw new FinalizeSessionError(409, {
      error: `Session status must be FINALIZING, got ${latest?.status ?? 'UNKNOWN'}`,
    });
  }
}

function buildFinalizePromotionData(session: {
  status: SessionStatus;
  serverPausedAt: Date | null;
}): Prisma.SessionUpdateManyMutationInput {
  const now = new Date();
  const data: Prisma.SessionUpdateManyMutationInput = {
    status: 'FINALIZING',
    // 用 serverPausedAt 记录"录音实际结束时间"，避免 finalize 延迟造成 duration 被高估。
    serverPausedAt: now,
  };

  if (session.status === 'PAUSED' && session.serverPausedAt) {
    const pendingPausedMs = Math.max(
      0,
      now.getTime() - session.serverPausedAt.getTime()
    );
    if (pendingPausedMs > 0) {
      data.serverPausedMs = { increment: pendingPausedMs };
    }
  }

  return data;
}

async function resolveTranscriptBundle(
  session: FinalizeSessionRecord,
  clientBundle?: PersistedTranscriptBundle | null
): Promise<PersistedTranscriptBundle | null> {
  const draft = await loadTranscriptDraft(session);
  const draftSegs = draft?.segments.length ?? 0;
  const clientSegs = clientBundle?.segments.length ?? 0;

  // 取段数更多的一方为主转录（防陈旧标签用更短的 clientBundle 覆盖服务端更完整的草稿——
  // 转录只增不减，段数是完整度的可靠代理；审计 medium）。summaries/translations 取任一非空。
  // 段数相同时优先 clientBundle（本次收尾请求，通常最新）。
  const pickClient = clientSegs > 0 && clientSegs >= draftSegs;

  if (pickClient && clientBundle) {
    return {
      segments: clientBundle.segments,
      summaries:
        clientBundle.summaries?.length > 0
          ? clientBundle.summaries
          : (draft?.summaries ?? []),
      translations:
        Object.keys(clientBundle.translations ?? {}).length > 0
          ? clientBundle.translations
          : (draft?.translations ?? {}),
    };
  }

  if (draft && draftSegs > 0) {
    return {
      segments: draft.segments,
      summaries:
        clientBundle?.summaries?.length && clientBundle.summaries.length > 0
          ? clientBundle.summaries
          : draft.summaries,
      translations:
        clientBundle &&
        Object.keys(clientBundle.translations ?? {}).length > 0
          ? clientBundle.translations
          : draft.translations,
    };
  }

  if (clientBundle) {
    return clientBundle;
  }

  return null;
}

async function releaseFinalizeLock(sessionId: string, lockTimestamp?: Date) {
  // 若提供 lockTimestamp，仅在仍持本次锁时释放（条件 updateMany），避免误清被接管后的锁。
  if (lockTimestamp) {
    await prisma.session
      .updateMany({
        where: { id: sessionId, finalizeLockedAt: lockTimestamp },
        data: { finalizeLockedAt: null },
      })
      .catch(() => undefined);
    return;
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      finalizeLockedAt: null,
    },
  }).catch(() => undefined);
}

export interface BackgroundTaskParams {
  sessionId: string;
  userId: string;
  transcriptPath: string | null;
  summaryPath: string | null;
  recordingPath: string | null;
  title: string;
  courseName: string;
  durationMs: number | null;
  createdAt: Date;
  targetLang: string;
  folderIds: string[];
  bundle: PersistedTranscriptBundle | null;
}

export async function runBackgroundLLMTasks(params: BackgroundTaskParams) {
  if (!params.transcriptPath || !params.summaryPath) {
    return;
  }

  try {
    const sessionForLoad = {
      id: params.sessionId,
      userId: params.userId,
      recordingPath: params.recordingPath,
      transcriptPath: params.transcriptPath,
      summaryPath: params.summaryPath,
    };
    const bundle =
      params.bundle ?? (await loadSessionTranscriptBundle(sessionForLoad));
    if (!bundle || bundle.segments.length === 0) {
      logger.warn(
        { sessionId: params.sessionId },
        '[finalize-bg] no transcript data, skip LLM'
      );
      return;
    }

    const fullTranscript = extractTranscriptText(bundle);

    const keywordPromise = Promise.all(
      params.folderIds.map(async (folderId) => {
        await trackJob(
          {
            type: JOB_TYPE.KEYWORD_EXTRACTION,
            sessionId: params.sessionId,
            userId: params.userId,
            triggeredBy: 'system',
            params: { folderId },
          },
          async () => {
            await extractAndAccumulateKeywords(
              params.sessionId,
              folderId,
              fullTranscript,
              callLLM
            );
            return { folderId };
          }
        ).catch((error) => {
          logger.error(
            {
              sessionId: params.sessionId,
              folderId,
              err: serializeError(error),
            },
            '[finalize-bg] keyword extraction failed'
          );
        });
      })
    );

    const summaryBlocks = (bundle.summaries ?? []) as SummaryBlock[];

    const reportAndTitlePromise = (async () => {
      // 步骤 1: 报告生成
      await trackJob(
        {
          type: JOB_TYPE.REPORT_GENERATION,
          sessionId: params.sessionId,
          userId: params.userId,
          triggeredBy: 'system',
          params: { title: params.title, courseName: params.courseName },
        },
        async () => {
          // 拿 FINAL_SUMMARY 模型的 contextWindow 喂给 reportManager 决定 map-reduce 阈值
          const finalSummaryProvider = await getProviderForPurpose('FINAL_SUMMARY').catch(
            () => null
          );

          const reportData = await generateSessionReport({
            sessionId: params.sessionId,
            transcript: fullTranscript,
            sessionTitle: params.title,
            courseName: params.courseName,
            durationMs: params.durationMs ?? 0,
            date: params.createdAt.toISOString().split('T')[0],
            summaryBlocks,
            language: params.targetLang,
            callLLM: (system: string, userMessage: string) =>
              callLLM(system, userMessage, { purpose: 'FINAL_SUMMARY' }),
            contextWindow: finalSummaryProvider?.contextWindow,
          });

          const stored = await persistSessionReport(sessionForLoad, reportData);
          await prisma.session.update({
            where: { id: params.sessionId },
            data: { reportPath: stored.path },
          });
          return { reportPath: stored.path };
        }
      );

      // 步骤 2: 标题生成（仅覆盖默认标题）
      const DEFAULT_TITLES = ['新建讲座会话', 'New Lecture Session'];
      if (!DEFAULT_TITLES.includes(params.title)) {
        logger.info(
          { sessionId: params.sessionId },
          '[finalize-bg] custom title, skip title generation'
        );
        return;
      }

      await trackJob(
        {
          type: JOB_TYPE.TITLE_GENERATION,
          sessionId: params.sessionId,
          userId: params.userId,
          triggeredBy: 'system',
          params: { originalTitle: params.title },
        },
        async () => {
          const generated = await generateSessionTitle({
            transcript: fullTranscript,
            summaryBlocks,
            courseName: params.courseName,
            language: params.targetLang,
            callLLM: (system: string, userMessage: string) =>
              callLLM(system, userMessage, { purpose: 'FINAL_SUMMARY' }),
          });

          if (!generated) {
            return { skipped: true, reason: 'generation_failed' };
          }

          await prisma.session.update({
            where: { id: params.sessionId },
            data: { title: generated.zh, titleEn: generated.en },
          });
          return { zh: generated.zh, en: generated.en };
        }
      );
    })().catch((error) => {
      logger.error(
        { sessionId: params.sessionId, err: serializeError(error) },
        '[finalize-bg] report/title generation failed'
      );
    });

    await Promise.allSettled([keywordPromise, reportAndTitlePromise]);
    await Promise.all([
      invalidateSessionsApiCache(params.userId),
      invalidateFoldersApiCache(params.userId),
    ]);
    logger.info(
      { sessionId: params.sessionId },
      '[finalize-bg] background tasks completed'
    );
  } catch (error) {
    logger.error(
      { sessionId: params.sessionId, err: serializeError(error) },
      '[finalize-bg] background task failed'
    );
  }
}
