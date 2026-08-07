import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import { adminAdjust, getWalletSummary, WalletError } from '@/lib/wallet';

interface AdjustInput {
  userId?: string;
  email?: string;
  amountCentsDelta?: number;
  minutesDelta?: number;
  note?: string;
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

  let effective: { amountCentsDelta: number; minutesDelta: number };
  try {
    effective = await adminAdjust({
      userId,
      amountCentsDelta: Number.isFinite(amountCentsDelta) ? amountCentsDelta : 0,
      minutesDelta: Number.isFinite(minutesDelta) ? minutesDelta : 0,
      note: body.note,
      operatorId: admin.id,
    });
  } catch (err) {
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

  const summary = await getWalletSummary(userId);
  return NextResponse.json({ ok: true, summary });
});
