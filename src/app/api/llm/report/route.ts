// POST /api/llm/report — 录音结束后生成结构化会议报告
// 包含意义评估 + 报告生成，结果持久化到文件系统

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { isPaymentBenefitAvailable } from '@/lib/payment/entitlementAdmission';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership, assertSessionReadAccess } from '@/lib/security';
import { logAction } from '@/lib/auditLog';
import { resolveUserFeatureFlags, resolveUserSummaryModels } from '@/lib/userRoles';
import { callLLM } from '@/lib/llm/gateway';
import { resolveSummaryModel } from '@/lib/llm/summaryModel';
import { enforceRateLimit } from '@/lib/rateLimit';
import { SessionReportBudgetExceededError } from '@/lib/llm/reportManager';
import { generateOrReuseSessionReport } from '@/lib/llm/reportGenerationService';
import { ActiveJobBudgetExceededError } from '@/lib/jobQueue';
import {
  extractTranscriptText,
  loadSessionTranscriptBundle,
  loadSessionReport,
} from '@/lib/sessionPersistence';
import type { SummaryBlock } from '@/types/summary';

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isPaymentBenefitAvailable(user.id))) {
    return NextResponse.json(
      { error: '账户存在未处理的支付争议', code: 'payment_account_frozen' },
      { status: 403 }
    );
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'llm:report',
    limit: 10,
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  try {
    const { sessionId } = await req.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    try {
      assertOwnership(user.id, session.userId);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // 用户组门禁：未开通总摘要则拒绝生成结构化报告（按会话拥有者的组解析）
    const owner = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { role: true, customGroupId: true },
    });
    const allowFinalSummary = owner
      ? (await resolveUserFeatureFlags(owner)).allowFinalSummary
      : true;
    if (!allowFinalSummary) {
      return NextResponse.json(
        { error: '当前用户组未开通总摘要功能' },
        { status: 403 }
      );
    }

    // 总摘要模型由会话拥有者所属组决定（组绑定 > 全局 FINAL_SUMMARY 默认）。
    const { finalSummaryModelId } = owner
      ? await resolveUserSummaryModels(owner)
      : { finalSummaryModelId: null };

    // 加载转录数据
    const bundle = await loadSessionTranscriptBundle(session);
    if (!bundle || bundle.segments.length === 0) {
      return NextResponse.json(
        { error: 'No transcript data available' },
        { status: 400 }
      );
    }

    const fullTranscript = extractTranscriptText(bundle);
    const summaryBlocks = (bundle.summaries ?? []) as SummaryBlock[];

    // 预解析总摘要模型（组绑定或全局用途默认），拿到 contextWindow 喂给 reportManager
    // 决定是否走 map-reduce。即使解析失败也用 DEFAULT_CONTEXT_WINDOW 兜底（reportManager 内部默认）。
    const { routing: finalRouting, provider: finalSummaryProvider } =
      await resolveSummaryModel(finalSummaryModelId, 'FINAL_SUMMARY');

    const modelKey =
      finalSummaryProvider?.dbModelId ??
      ('modelId' in finalRouting
        ? `model:${finalRouting.modelId}`
        : `purpose:${finalRouting.purpose}`);

    // 手动与 finalize 后台统一经过同一个 sourceHash 单飞、复用和整次预算边界。
    const result = await generateOrReuseSessionReport({
      session,
      transcript: fullTranscript,
      sessionTitle: session.title,
      courseName: session.courseName ?? '',
      durationMs: session.durationMs,
      date: session.createdAt.toISOString().split('T')[0],
      summaryBlocks,
      language: session.targetLang || 'zh',
      callLLM: (system: string, userMsg: string, execution) =>
        callLLM(system, userMsg, {
          ...finalRouting,
          maxOutputTokens: execution.maxOutputTokens,
          onUsage: execution.onUsage,
        }),
      contextWindow: finalSummaryProvider?.contextWindow,
      maxOutputTokens: finalSummaryProvider?.maxTokens,
      modelKey,
      triggeredBy: `user:${user.id}`,
    });

    if (result.status === 'in_progress') {
      return NextResponse.json(
        {
          success: false,
          inProgress: true,
          sourceHash: result.sourceHash,
        },
        { status: 202, headers: { 'Retry-After': '5' } }
      );
    }

    if (result.status === 'generated') {
      await invalidateSessionsApiCache(user.id);
    }

    return NextResponse.json({
      success: true,
      reused: result.status === 'reused',
      reportPath: result.reportPath,
      significance: result.reportData.significance,
      hasReport: result.reportData.report !== null,
    });
  } catch (error) {
    if (error instanceof ActiveJobBudgetExceededError) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          ((error.resetAt?.getTime() ?? Date.now() + 60_000) - Date.now()) /
            1000
        )
      );
      return NextResponse.json(
        {
          error: 'Report generation token budget exhausted',
          dimension: error.dimension,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSeconds) },
        }
      );
    }
    if (error instanceof SessionReportBudgetExceededError) {
      return NextResponse.json(
        {
          error: 'Report exceeds generation budget',
          providerCalls: error.plan.providerCalls,
          reservedTokens: error.plan.reservedTokens,
        },
        { status: 413 }
      );
    }
    console.error('Report generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 }
    );
  }
}

// GET /api/llm/report?sessionId=xxx — 获取已生成的报告
export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    const { isCrossUserAdmin } = assertSessionReadAccess(user, session.userId);
    if (isCrossUserAdmin) {
      logAction(req, 'admin.session.report.read', {
        user,
        detail: `读取他人会议报告 (sessionId=${sessionId}, owner=${session.userId})`,
      });
    }
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const report = await loadSessionReport(session);
  if (!report) {
    return NextResponse.json({ report: null });
  }

  return NextResponse.json({ report });
}
