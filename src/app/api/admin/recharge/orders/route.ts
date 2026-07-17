import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { withRequestLogging } from '@/lib/requestLogger';
import type { Prisma } from '@prisma/client';

// 进账台账：支付订单列表（分页 + 按状态/渠道筛选，附用户邮箱）
export const GET = withRequestLogging('admin:recharge:orders:list', async (req: Request) => {
  const { response } = await requireAdminAccess(req, { scope: 'admin:recharge:orders:list', limit: 60 });
  if (response) return response;

  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(sp.get('pageSize') || '20', 10)));
  const status = sp.get('status') || undefined;
  const provider = sp.get('provider') || undefined;

  const where: Prisma.PaymentOrderWhereInput = {};
  if (status) where.status = status;
  if (provider) where.provider = provider;

  const [orders, total] = await Promise.all([
    prisma.paymentOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentOrder.count({ where }),
  ]);

  const userIds = [...new Set(orders.map((o) => o.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, displayName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    orders: orders.map((o) => ({
      ...o,
      userEmail: byId.get(o.userId)?.email ?? null,
      userName: byId.get(o.userId)?.displayName ?? null,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
});
