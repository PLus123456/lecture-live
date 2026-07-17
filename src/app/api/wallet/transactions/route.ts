import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// 用户自己的钱包流水（我的账单，分页）
export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(sp.get('pageSize') || '20', 10)));

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { userId: payload.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        amountCents: true,
        balanceAfterCents: true,
        minutesDelta: true,
        note: true,
        createdAt: true,
      },
    }),
    prisma.walletTransaction.count({ where: { userId: payload.id } }),
  ]);

  return NextResponse.json({
    transactions,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
