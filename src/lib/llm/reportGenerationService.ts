import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import {
  ActiveJobConflictError,
  completeActiveJob,
  failActiveJob,
  JOB_TYPE,
} from '@/lib/jobQueue';
import {
  completeStagedArtifactPublishes,
  loadSessionReport,
  rollbackStagedArtifact,
  settleStagedArtifactsInTransaction,
  stageArtifact,
} from '@/lib/sessionPersistence';
import {
  getStoredArtifactById,
  STORED_ARTIFACT_STATE,
} from '@/lib/storage/storedArtifactLedger';
import {
  assertSessionReportWorkWithinBudget,
  generateSessionReport,
  planSessionReportWork,
  type SessionReportWorkPlan,
} from '@/lib/llm/reportManager';
import { logger, serializeError } from '@/lib/logger';
import type { SessionReportData } from '@/types/report';
import type { SummaryBlock } from '@/types/summary';
import type { LLMCallUsage } from '@/lib/llm/gateway';
import {
  claimLlmTokenBudget,
  conservativeLlmCallTokens,
  getLlmTokenBudgets,
  LLM_TOKEN_RESOURCE_SCOPE,
  trustedLlmUsageTokens,
} from '@/lib/llm/resourceBudget';

const reportGenerationLogger = logger.child({ component: 'report-generation-service' });

/** sourceHash / 持久化 envelope 的版本；prompt 或哈希输入语义变化时必须递增。 */
export const REPORT_GENERATION_SCHEMA_VERSION = 2;
export const REPORT_RESOURCE_SCOPE = LLM_TOKEN_RESOURCE_SCOPE;
export const getReportTokenBudgets = getLlmTokenBudgets;

interface ReportArtifactSession {
  id: string;
  userId: string;
  recordingPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
}

export interface GenerateOrReuseSessionReportOptions {
  session: ReportArtifactSession;
  transcript: string;
  sessionTitle: string;
  courseName: string;
  durationMs: number;
  date: string;
  summaryBlocks: SummaryBlock[];
  language: string;
  callLLM: (
    system: string,
    user: string,
    execution: {
      maxOutputTokens: number;
      onUsage: (usage: LLMCallUsage | undefined) => void;
    }
  ) => Promise<string>;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 不含密钥的稳定模型身份；模型切换后应产生新的报告版本。 */
  modelKey: string;
  triggeredBy: string;
}

export type GenerateOrReuseSessionReportResult =
  | {
      status: 'generated' | 'reused';
      reportData: SessionReportData;
      reportPath: string;
      sourceHash: string;
      plan: SessionReportWorkPlan;
    }
  | {
      status: 'in_progress';
      sourceHash: string;
      plan: SessionReportWorkPlan;
    };

export class SessionReportGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionReportGenerationError';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeSessionReportSourceHash(
  options: Omit<GenerateOrReuseSessionReportOptions, 'callLLM' | 'triggeredBy'>
): string {
  const hash = crypto.createHash('sha256');
  hash.update(`report-generation-v${REPORT_GENERATION_SCHEMA_VERSION}\0`);
  hash.update(options.transcript);
  hash.update('\0');
  hash.update(
    stableJson({
      sessionId: options.session.id,
      // 显示标题可被 owner 低成本反复改名，且 finalize 会在报告后自动改标题。
      // 它不是内容版本，不能用来制造新 activeKey/付费缓存失效。
      courseName: options.courseName,
      durationMs: options.durationMs,
      date: options.date,
      summaryBlocks: options.summaryBlocks,
      language: options.language,
      contextWindow: options.contextWindow ?? null,
      maxOutputTokens: options.maxOutputTokens ?? null,
      modelKey: options.modelKey,
    })
  );
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isCompleteSessionReport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.title !== 'string' ||
    typeof value.topic !== 'string' ||
    typeof value.date !== 'string' ||
    typeof value.duration !== 'string' ||
    typeof value.overview !== 'string' ||
    !isStringArray(value.participants) ||
    !isStringArray(value.conclusions) ||
    !isStringArray(value.actionItems) ||
    !Array.isArray(value.sections) ||
    !value.sections.every(
      (section) =>
        isRecord(section) &&
        typeof section.title === 'string' &&
        isStringArray(section.points)
    ) ||
    !isRecord(value.keyTerms) ||
    !Object.values(value.keyTerms).every((entry) => typeof entry === 'string')
  ) {
    return false;
  }
  return true;
}

/**
 * 只有同 sourceHash 且语义完整的结果可复用：
 * - 不值得总结 + report=null 是有效否定；
 * - 值得总结但 report=null 是上次供应商/解析失败，必须允许重试。
 */
function reusableReport(
  value: unknown,
  sourceHash: string
): SessionReportData | null {
  if (!isRecord(value) || !isRecord(value._generation)) return null;
  if (
    value._generation.schemaVersion !== REPORT_GENERATION_SCHEMA_VERSION ||
    value._generation.sourceHash !== sourceHash ||
    !isRecord(value.significance) ||
    typeof value.significance.score !== 'number' ||
    !Number.isFinite(value.significance.score) ||
    value.significance.score < 0 ||
    value.significance.score > 1 ||
    typeof value.significance.reason !== 'string' ||
    typeof value.significance.isWorthSummarizing !== 'boolean' ||
    typeof value.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.generatedAt))
  ) {
    return null;
  }
  if (value.significance.isWorthSummarizing) {
    return isCompleteSessionReport(value.report)
      ? (value as unknown as SessionReportData)
      : null;
  }
  return value.report === null ? (value as unknown as SessionReportData) : null;
}

function activeKey(sessionId: string, sourceHash: string): string {
  return `report:${sessionId}:${sourceHash}`;
}

function reportMaxOutputTokens(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : 4096;
}

async function loadReusableReport(
  session: ReportArtifactSession,
  reportPath: string | null,
  sourceHash: string
): Promise<SessionReportData | null> {
  if (!reportPath) return null;
  try {
    const stored = await loadSessionReport({ ...session, reportPath });
    return reusableReport(stored, sourceHash);
  } catch (error) {
    reportGenerationLogger.warn(
      { sessionId: session.id, err: serializeError(error) },
      '读取已有报告失败，按未命中处理'
    );
    return null;
  }
}

/**
 * 手动 POST 与 finalize 后台任务的唯一报告生成入口。
 * 工作量先完整规划并过硬预算，再用 DB 唯一 activeKey 原子 claim；任何 provider 调用都发生在 claim 之后。
 */
export async function generateOrReuseSessionReport(
  options: GenerateOrReuseSessionReportOptions
): Promise<GenerateOrReuseSessionReportResult> {
  const sourceHash = computeSessionReportSourceHash(options);
  const plan = planSessionReportWork({
    transcript: options.transcript,
    sessionTitle: options.sessionTitle,
    courseName: options.courseName,
    durationMs: options.durationMs,
    date: options.date,
    summaryBlocks: options.summaryBlocks,
    language: options.language,
    contextWindow: options.contextWindow,
    maxOutputTokens: options.maxOutputTokens,
  });
  const current = await prisma.session.findUnique({
    where: { id: options.session.id },
    select: { reportPath: true },
  });
  if (!current) {
    throw new SessionReportGenerationError('Session no longer exists');
  }

  const expectedReportPath = current.reportPath;
  const cached = await loadReusableReport(
    options.session,
    expectedReportPath,
    sourceHash
  );
  if (cached && expectedReportPath) {
    return {
      status: 'reused',
      reportData: cached,
      reportPath: expectedReportPath,
      sourceHash,
      plan,
    };
  }

  // 缓存命中不发生付费，允许复用历史上已生成的合法大报告；缓存未命中时，预算门禁
  // 必须早于 claim 和首个 provider 调用。预算不足不会留下任务，也不会发生部分付费。
  assertSessionReportWorkWithinBudget(plan);
  let jobId: string;
  try {
    jobId = await claimLlmTokenBudget({
      type: JOB_TYPE.REPORT_GENERATION,
      sessionId: options.session.id,
      userId: options.session.userId,
      triggeredBy: options.triggeredBy,
      activeKey: activeKey(options.session.id, sourceHash),
      units: plan.reservedTokens,
      params: {
        sourceHash,
        schemaVersion: REPORT_GENERATION_SCHEMA_VERSION,
        reservedTokens: plan.reservedTokens,
        providerCalls: plan.providerCalls,
        chunkCount: plan.chunkCount,
      },
    });
  } catch (error) {
    // 初读 cache miss 后，winner 可能已经发布并释放 activeKey，甚至已耗尽当日预算。
    // 所有 claim 失败都先按 exact sourceHash 二次读；缓存命中永远不应受预算限制。
    const refreshed = await prisma.session.findUnique({
      where: { id: options.session.id },
      select: { reportPath: true },
    });
    const winner = refreshed
      ? await loadReusableReport(options.session, refreshed.reportPath, sourceHash)
      : null;
    if (winner && refreshed?.reportPath) {
      return {
        status: 'reused',
        reportData: winner,
        reportPath: refreshed.reportPath,
        sourceHash,
        plan,
      };
    }
    if (!(error instanceof ActiveJobConflictError)) throw error;
    return { status: 'in_progress', sourceHash, plan };
  }

  // 还要闭合 cache miss → winner 完成并释放 activeKey → loser 成功 claim 的间隙。
  // 在首个 provider 调用前再次读 exact-hash；命中时以 0 usage 结束本次 claim。
  let afterClaim: { reportPath: string | null } | null;
  try {
    afterClaim = await prisma.session.findUnique({
      where: { id: options.session.id },
      select: { reportPath: true },
    });
  } catch (error) {
    await failActiveJob(
      jobId,
      error,
      {
        sourceHash,
        reservedTokens: plan.reservedTokens,
        actualTokens: 0,
        providerCallsStarted: 0,
      },
      0
    ).catch((jobError) => {
      reportGenerationLogger.error(
        {
          sessionId: options.session.id,
          jobId,
          err: serializeError(jobError),
        },
        '报告 claim 后缓存复核失败且任务终态未知'
      );
    });
    throw error;
  }
  if (!afterClaim) {
    const missingSessionError = new SessionReportGenerationError(
      'Session no longer exists'
    );
    await failActiveJob(
      jobId,
      missingSessionError,
      {
        sourceHash,
        reservedTokens: plan.reservedTokens,
        actualTokens: 0,
        providerCallsStarted: 0,
      },
      0
    );
    throw missingSessionError;
  }
  const afterClaimWinner = await loadReusableReport(
    options.session,
    afterClaim.reportPath,
    sourceHash
  );
  if (afterClaimWinner && afterClaim.reportPath) {
    await completeActiveJob(
      jobId,
      {
        sourceHash,
        reservedTokens: plan.reservedTokens,
        actualTokens: 0,
        providerCallsStarted: 0,
        reusedAfterClaim: true,
      },
      0
    );
    return {
      status: 'reused',
      reportData: afterClaimWinner,
      reportPath: afterClaim.reportPath,
      sourceHash,
      plan,
    };
  }
  if (afterClaim.reportPath !== expectedReportPath) {
    const changedArtifactError = new SessionReportGenerationError(
      'report artifact changed while waiting for generation claim'
    );
    await failActiveJob(
      jobId,
      changedArtifactError,
      {
        sourceHash,
        reservedTokens: plan.reservedTokens,
        actualTokens: 0,
        providerCallsStarted: 0,
      },
      0
    );
    throw changedArtifactError;
  }

  let providerCallsStarted = 0;
  let actualTokens = 0;
  let providerMeasuredCalls = 0;
  let conservativeFallbackCalls = 0;
  let accountingInvariantFailed = false;
  const maxOutputTokens = reportMaxOutputTokens(options.maxOutputTokens);
  const budgetedCall = async (system: string, user: string): Promise<string> => {
    if (accountingInvariantFailed) {
      throw new SessionReportGenerationError(
        'report token accounting invariant already failed'
      );
    }
    if (providerCallsStarted >= plan.providerCalls) {
      throw new SessionReportGenerationError(
        'report generator exceeded its pre-reserved provider call count'
      );
    }
    providerCallsStarted += 1;
    const callReservation = conservativeLlmCallTokens(
      system,
      user,
      maxOutputTokens
    );
    let measured: number | null = null;
    let response: string | undefined;
    let callFailed = false;
    let callError: unknown;
    try {
      response = await options.callLLM(system, user, {
        maxOutputTokens,
        onUsage: (usage) => {
          // usage 是上游输入，不能让异常/恶意数值撑爆本地账本或把预留卡死。
          measured = trustedLlmUsageTokens(usage, callReservation);
        },
      });
    } catch (error) {
      callFailed = true;
      callError = error;
    }

    // 上游可能已开始计费才断连。拿不到可信 usage 时按该调用的已预留上界
    // 结算，不把「未返响应」或 usage=0 误当成零成本。
    const settledCallUnits = measured ?? callReservation;
    if (measured === null) conservativeFallbackCalls += 1;
    else providerMeasuredCalls += 1;
    const nextActualTokens = actualTokens + settledCallUnits;
    if (
      !Number.isSafeInteger(nextActualTokens) ||
      nextActualTokens > plan.reservedTokens
    ) {
      // planner/runtime 若未来发生漂移，保守地结算全部预留并终止，不留卡死 lease。
      actualTokens = plan.reservedTokens;
      accountingInvariantFailed = true;
      throw new SessionReportGenerationError(
        'report actual usage exceeded its pre-reserved token budget'
      );
    }
    actualTokens = nextActualTokens;
    if (callFailed) throw callError;
    return response as string;
  };

  let reportData: SessionReportData;
  let reportPath: string;
  try {
    const generated = await generateSessionReport({
      sessionId: options.session.id,
      transcript: options.transcript,
      sessionTitle: options.sessionTitle,
      courseName: options.courseName,
      durationMs: options.durationMs,
      date: options.date,
      summaryBlocks: options.summaryBlocks,
      language: options.language,
      callLLM: budgetedCall,
      contextWindow: options.contextWindow,
    });
    if (generated.significance.isWorthSummarizing && generated.report === null) {
      throw new SessionReportGenerationError(
        'report generation returned no report for significant content'
      );
    }
    reportData = {
      ...generated,
      _generation: {
        schemaVersion: REPORT_GENERATION_SCHEMA_VERSION,
        sourceHash,
      },
    };
    // 报告也按「版本化对象 + DB CAS」发布。即使不同 sourceHash 并发（例如标题恰好
    // 在生成期间变化），也不会互相覆盖同一个物理文件或把较早写入静默踩掉。
    const staged = await stageArtifact(
      options.session,
      'reports',
      JSON.stringify(reportData, null, 2),
      { previousReference: expectedReportPath }
    );
    let publications: Awaited<
      ReturnType<typeof settleStagedArtifactsInTransaction>
    > = [];
    let committedAfterReadback = false;
    try {
      publications = await prisma.$transaction(async (tx) => {
        const published = await tx.session.updateMany({
          where: {
            id: options.session.id,
            reportPath: expectedReportPath,
          },
          data: { reportPath: staged.reference },
        });
        if (published.count !== 1) {
          throw new SessionReportGenerationError(
            'report artifact changed while generation was running'
          );
        }
        return settleStagedArtifactsInTransaction(tx, [staged]);
      });
      reportPath = staged.reference;
    } catch (publishError) {
      let readbackPath: string | null | undefined;
      try {
        const [readback, artifact] = await Promise.all([
          prisma.session.findUnique({
            where: { id: options.session.id },
            select: { reportPath: true },
          }),
          getStoredArtifactById(staged.storedArtifactId),
        ]);
        readbackPath = readback?.reportPath;
        if (
          readbackPath === staged.reference &&
          artifact?.state === STORED_ARTIFACT_STATE.ACTIVE &&
          artifact.reference === staged.reference
        ) {
          reportPath = staged.reference;
          committedAfterReadback = true;
          reportGenerationLogger.warn(
            { sessionId: options.session.id },
            '报告事务返回失败但 readback 确认 owner+ledger 已发布'
          );
        } else if (
          readbackPath !== staged.reference &&
          artifact?.state === STORED_ARTIFACT_STATE.RESERVED
        ) {
          await rollbackStagedArtifact(options.session, staged).catch(
            (rollbackError) => {
              reportGenerationLogger.error(
                {
                  sessionId: options.session.id,
                  err: serializeError(rollbackError),
                },
                '报告事务失败后 staged artifact 回滚失败'
              );
            }
          );
          throw publishError;
        } else {
          throw new SessionReportGenerationError(
            'report artifact publication outcome is unknown'
          );
        }
      } catch (readbackError) {
        if (readbackError === publishError) throw readbackError;
        reportGenerationLogger.error(
          {
            sessionId: options.session.id,
            err: serializeError(readbackError),
          },
          '报告 owner+ledger 发布结果未知，保留 staged artifact'
        );
        throw publishError;
      }
    }
    if (!committedAfterReadback) {
      await completeStagedArtifactPublishes(options.session, publications).catch(
        (cleanupError) => {
          reportGenerationLogger.warn(
            {
              sessionId: options.session.id,
              err: serializeError(cleanupError),
            },
            '报告已发布，但旧 artifact 清理失败'
          );
        }
      );
    }
  } catch (error) {
    await failActiveJob(
      jobId,
      error,
      {
        sourceHash,
        reservedTokens: plan.reservedTokens,
        actualTokens,
        providerCallsStarted,
        providerMeasuredCalls,
        conservativeFallbackCalls,
      },
      actualTokens
    ).catch((jobError) => {
      // 终态写返回失败时状态未知，不能绕过 claim 立即重跑；若数据库仍是
      // PROCESSING/activeKey，现有僵尸回收会在阈值后安全释放。
      reportGenerationLogger.error(
        {
          sessionId: options.session.id,
          jobId,
          err: serializeError(jobError),
        },
        '报告失败任务终态写入结果未知，按 activeKey 仍占用处理'
      );
    });
    throw error;
  }

  // 终态更新必须 await。若数据库状态未知，抛错并让 activeKey 保守占用，报告本身已可在后续复用。
  await completeActiveJob(jobId, {
    reportPath,
    sourceHash,
    reservedTokens: plan.reservedTokens,
    actualTokens,
    providerCallsStarted,
    providerMeasuredCalls,
    conservativeFallbackCalls,
  }, actualTokens);

  return {
    status: 'generated',
    reportData,
    reportPath,
    sourceHash,
    plan,
  };
}
