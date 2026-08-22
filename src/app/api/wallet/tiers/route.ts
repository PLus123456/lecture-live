import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isForbiddenAdminTier } from '@/lib/payment/tierPolicy';

// 面向用户的可购档位（仅启用项，按类型 + 排序）
export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const tiers = await prisma.rechargeTier.findMany({
    where: { active: true },
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { priceCents: 'asc' }],
    select: {
      id: true,
      kind: true,
      name: true,
      priceCents: true,
      grantRole: true,
      durationDays: true,
      grantMinutes: true,
      creditCents: true,
    },
  });
  // 纵深防护：存量数据库可能仍有旧版创建的 ADMIN 档位。即使尚未完成
  // 数据清理，也绝不能把它作为可购买商品暴露给客户端。
  return NextResponse.json({ tiers: tiers.filter((tier) => !isForbiddenAdminTier(tier)) });
}
