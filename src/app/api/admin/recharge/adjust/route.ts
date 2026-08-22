import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import { getSecurityAuditRequestId, writeSecurityAudit } from '@/lib/securityAudit';
import { adminAdjust, getWalletSummary, WalletError } from '@/lib/wallet';

interface AdjustInput {
  userId?: string;
  email?: string;
  amountCentsDelta?: number;
  minutesDelta?: number;
  note?: string;
}

function walletSnapshot(
  summary: Awaited<ReturnType<typeof getWalletSummary>>
): Record<string, unknown> | null {
  if (!summary) return null;
  return {
    walletBalanceCents: summary.walletBalanceCents,
    purchasedMinutesBalance: summary.purchasedMinutesBalance,
  };
}

function auditUnavailable(message: string, err: unknown): NextResponse {
  console.error(message, err);
  return NextResponse.json({ error: '安全审计服务暂时不可用' }, { status: 503 });
}

// 管理员手动调整用户余额 / 永久时长池
export const POST = withRequestLogging('admin:recharge:adjust', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:adjust',
    limit: 30,
  });
  if (response) return response;
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  let body: AdjustInput;
  try {
    body = (await req.json()) as AdjustInput;
  } catch {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }

  // 解析目标用户（id 优先，否则按 email）
  let userId = body.userId;
  if (!userId && body.email) {
    const target = await prisma.user.findUnique({
      where: { email: body.email.trim() },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    userId = target.id;
  }
  if (!userId) return NextResponse.json({ error: '缺少目标用户（userId 或 email）' }, { status: 400 });

  const amountCentsDelta = Number(body.amountCentsDelta ?? 0);
  const minutesDelta = Number(body.minutesDelta ?? 0);
  const requested = {
    amountCentsDelta: Number.isFinite(amountCentsDelta) ? amountCentsDelta : 0,
    minutesDelta: Number.isFinite(minutesDelta) ? minutesDelta : 0,
  };
  const requestId = getSecurityAuditRequestId(req);
  let before: Awaited<ReturnType<typeof getWalletSummary>>;
  try {
    before = await getWalletSummary(userId);
    await writeSecurityAudit(req, {
      event: 'recharge.adjust',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'user_wallet', id: userId, ownerId: userId },
      before: walletSnapshot(before),
      after: { requested },
      reason: 'admin_adjust',
      outcome: 'ATTEMPTED',
      metadata: { noteProvided: Boolean(body.note?.trim()) },
      requestId,
    });
  } catch (err) {
    return auditUnavailable('管理员调整钱包前安全审计失败:', err);
  }

  let effective: { amountCentsDelta: number; minutesDelta: number };
  try {
    effective = await adminAdjust({
      userId,
      ...requested,
      note: body.note,
      operatorId: admin.id,
    });
  } catch (err) {
    try {
      await writeSecurityAudit(req, {
        event: 'recharge.adjust',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'user_wallet', id: userId, ownerId: userId },
        before: walletSnapshot(before),
        after: { requested },
        reason: 'admin_adjust',
        outcome: 'FAILED',
        metadata: {
          noteProvided: Boolean(body.note?.trim()),
          errorType: err instanceof Error ? err.name : 'UnknownError',
          ...(err instanceof WalletError ? { errorCode: err.code } : {}),
        },
        requestId,
      });
    } catch (auditErr) {
      return auditUnavailable('管理员调整钱包失败结果安全审计失败:', auditErr);
    }
    if (err instanceof WalletError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    console.error('管理员调整钱包失败:', err);
    return NextResponse.json({ error: '调整失败' }, { status: 500 });
  }

  // 记**实际生效**值（P3-18）：调整会按余额/池余额截断，记请求值会和台账里的截断值互相矛盾，
  // 事后没人分得清哪个是真的。请求值另行附上，便于看出被截断了多少。
  logAction(req, 'admin.recharge.adjust', {
    user: admin,
    detail:
      `调整用户 ${userId}: 余额${effective.amountCentsDelta}分, 时长${effective.minutesDelta}分钟` +
      (effective.amountCentsDelta !== amountCentsDelta ||
      effective.minutesDelta !== minutesDelta
        ? `（请求值 余额${amountCentsDelta}分/时长${minutesDelta}分钟，已按余额截断）`
        : ''),
  });

  let summary: Awaited<ReturnType<typeof getWalletSummary>>;
  try {
    summary = await getWalletSummary(userId);
  } catch (err) {
    try {
      await writeSecurityAudit(req, {
        event: 'recharge.adjust',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'user_wallet', id: userId, ownerId: userId },
        before: walletSnapshot(before),
        after: { effective },
        reason: 'admin_adjust',
        outcome: 'PARTIAL',
        metadata: {
          requested,
          noteProvided: Boolean(body.note?.trim()),
          errorType: err instanceof Error ? err.name : 'UnknownError',
        },
        requestId,
      });
    } catch (auditErr) {
      return auditUnavailable('管理员调整钱包部分完成安全审计失败:', auditErr);
    }
    throw err;
  }
  try {
    await writeSecurityAudit(req, {
      event: 'recharge.adjust',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'user_wallet', id: userId, ownerId: userId },
      before: walletSnapshot(before),
      after: { wallet: walletSnapshot(summary), effective },
      reason: 'admin_adjust',
      outcome: 'SUCCESS',
      metadata: {
        requested,
        noteProvided: Boolean(body.note?.trim()),
        truncated:
          effective.amountCentsDelta !== requested.amountCentsDelta ||
          effective.minutesDelta !== requested.minutesDelta,
      },
      requestId,
    });
  } catch (err) {
    return auditUnavailable('管理员调整钱包完成安全审计失败:', err);
  }
  return NextResponse.json({ ok: true, summary });
});
