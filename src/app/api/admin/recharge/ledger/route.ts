import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { withRequestLogging } from '@/lib/requestLogger';
import type { Prisma } from '@prisma/client';

// 出账/进账台账：钱包流水列表（分页 + 按类型/用户筛选，附用户邮箱）
export const GET = withRequestLogging('admin:recharge:ledger:list', async (req: Request) => {
  const { response } = await requireAdminAccess(req, { scope: 'admin:recharge:ledger:list', limit: 60 });
  if (response) return response;

  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(sp.get('pageSize') || '20', 10)));
  const type = sp.get('type') || undefined;
  const userId = sp.get('userId') || undefined;

  const where: Prisma.WalletTransactionWhereInput = {};
  if (type) where.type = type;
  if (userId) where.userId = userId;

  const [items, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  const userIds = [...new Set(items.map((t) => t.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, displayName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    transactions: items.map((t) => ({
      ...t,
      userEmail: byId.get(t.userId)?.email ?? null,
      userName: byId.get(t.userId)?.displayName ?? null,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
});
