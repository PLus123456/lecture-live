import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import type { UserRole } from '@prisma/client';

type TierKind = 'membership' | 'minutes' | 'topup';
const TIER_KINDS: TierKind[] = ['membership', 'minutes', 'topup'];

interface TierInput {
  kind?: string;
  name?: string;
  priceCents?: number;
  grantRole?: string | null;
  durationDays?: number | null;
  grantMinutes?: number | null;
  creditCents?: number | null;
  active?: boolean;
  sortOrder?: number;
}

function intOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/** 校验并归一化档位输入；返回 { data } 或 { error }。 */
function normalizeTier(body: TierInput): { data?: Record<string, unknown>; error?: string } {
  const kind = body.kind;
  if (!kind || !TIER_KINDS.includes(kind as TierKind)) {
    return { error: '档位类型无效（membership | minutes | topup）' };
  }
  const name = (body.name ?? '').trim();
  if (!name) return { error: '档位名称不能为空' };
  const priceCents = intOrNull(body.priceCents);
  if (priceCents == null) return { error: '价格必须为非负整数（分）' };

  const data: Record<string, unknown> = {
    kind,
    name,
    priceCents,
    active: body.active ?? true,
    sortOrder: intOrNull(body.sortOrder) ?? 0,
    grantRole: null,
    durationDays: null,
    grantMinutes: null,
    creditCents: null,
  };

  if (kind === 'membership') {
    const role = (body.grantRole ?? 'PRO') as UserRole;
    if (!['ADMIN', 'PRO', 'FREE'].includes(role)) return { error: '授予角色无效' };
    const days = intOrNull(body.durationDays);
    if (!days || days <= 0) return { error: '会员档位必须设置正的时长天数' };
    data.grantRole = role;
    data.durationDays = days;
  } else if (kind === 'minutes') {
    const minutes = intOrNull(body.grantMinutes);
    if (!minutes || minutes <= 0) return { error: '时间档位必须设置正的赠送分钟数' };
    data.grantMinutes = minutes;
  } else {
    // topup：creditCents 可空（默认等于 priceCents，在结算时兜底）
    const credit = intOrNull(body.creditCents);
    data.creditCents = credit ?? priceCents;
  }
  return { data };
}

// 列出所有档位
export const GET = withRequestLogging('admin:recharge:tiers:list', async (req: Request) => {
  const { response } = await requireAdminAccess(req, { scope: 'admin:recharge:tiers:list' });
  if (response) return response;
  const tiers = await prisma.rechargeTier.findMany({
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json({ tiers });
});

// 新建档位
export const POST = withRequestLogging('admin:recharge:tiers:create', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:tiers:create',
    limit: 30,
  });
  if (response) return response;
  let body: TierInput;
  try {
    body = (await req.json()) as TierInput;
  } catch {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }
  const { data, error } = normalizeTier(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const tier = await prisma.rechargeTier.create({ data: data as never });
  logAction(req, 'admin.recharge.tier.create', {
    user: admin,
    detail: `新建档位: ${tier.name} (${tier.kind})`,
  });
  return NextResponse.json({ tier });
});

// 更新档位（id 在 body）
export const PATCH = withRequestLogging('admin:recharge:tiers:update', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:tiers:update',
    limit: 30,
  });
  if (response) return response;
  let body: TierInput & { id?: string };
  try {
    body = (await req.json()) as TierInput & { id?: string };
  } catch {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: '缺少档位 id' }, { status: 400 });
  const { data, error } = normalizeTier(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  try {
    const tier = await prisma.rechargeTier.update({ where: { id: body.id }, data: data as never });
    logAction(req, 'admin.recharge.tier.update', {
      user: admin,
      detail: `更新档位: ${tier.name} (${tier.kind})`,
    });
    return NextResponse.json({ tier });
  } catch {
    return NextResponse.json({ error: '档位不存在' }, { status: 404 });
  }
});

// 删除档位（id 在查询）
export const DELETE = withRequestLogging('admin:recharge:tiers:delete', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:tiers:delete',
    limit: 30,
  });
  if (response) return response;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少档位 id' }, { status: 400 });
  try {
    const tier = await prisma.rechargeTier.delete({ where: { id } });
    logAction(req, 'admin.recharge.tier.delete', {
      user: admin,
      detail: `删除档位: ${tier.name} (${tier.kind})`,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '档位不存在' }, { status: 404 });
  }
});
