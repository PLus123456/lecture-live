import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

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
  return NextResponse.json({ tiers });
}
