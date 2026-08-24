import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import { isPurchasableMembershipRole } from '@/lib/payment/tierPolicy';
import { writeSecurityAudit } from '@/lib/securityAudit';

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
  // null / undefined / 空串 = 「没给」，必须回 null 而不是 0：`Number(null) === 0` 会把
  // 「没填到账额」的全价 topup 档静默变成到账 0 分（P3-13：用户付全款、钱包一分不进）。
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  // 负数与超 32 位（Int 列上限）视为无效 → 返回 null（让上层回 400 或回退默认），不再截 0：
  // 否则 priceCents=-100 会被静默截成 ¥0 档（L3），超大值写库时 Int 溢出 500 而非干净的 400。
  if (!Number.isFinite(n) || n < 0 || n > 2_147_483_647) return null;
  return Math.floor(n);
}

/** body 里显式出现的键才算「要改」；undefined = 不改（PATCH 局部更新的判据）。 */
const TIER_KEYS = [
  'kind',
  'name',
  'priceCents',
  'active',
  'sortOrder',
  'grantRole',
  'durationDays',
  'grantMinutes',
  'creditCents',
] as const;

/** 换 kind 时这四列是**派生**的（按新 kind 重算/置空），必须跟着写，否则残留旧 kind 的值。 */
const KIND_DERIVED_KEYS = ['grantRole', 'durationDays', 'grantMinutes', 'creditCents'];

interface TierRow {
  kind: string;
  name: string;
  priceCents: number;
  grantRole: string | null;
  durationDays: number | null;
  grantMinutes: number | null;
  creditCents: number | null;
  active: boolean;
  sortOrder: number;
}

interface AuditableTierRow extends TierRow {
  id?: string;
}

class TierResponseError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'TierResponseError';
  }
}

class RequiredSecurityAuditError extends Error {
  constructor(readonly auditCause: unknown) {
    super('required security audit failed');
    this.name = 'RequiredSecurityAuditError';
  }
}

function tierForAudit(tier: AuditableTierRow): Record<string, unknown> {
  return {
    ...(tier.id ? { id: tier.id } : {}),
    kind: tier.kind,
    name: tier.name,
    priceCents: tier.priceCents,
    grantRole: tier.grantRole,
    durationDays: tier.durationDays,
    grantMinutes: tier.grantMinutes,
    creditCents: tier.creditCents,
    active: tier.active,
    sortOrder: tier.sortOrder,
  };
}

function auditUnavailable(err: unknown): NextResponse {
  console.error('充值档位安全审计失败:', err);
  return NextResponse.json({ error: '安全审计服务暂时不可用' }, { status: 503 });
}

/**
 * 校验并归一化档位输入；返回 { data } 或 { error }。
 *
 * 传 `current`（PATCH）时走**局部更新**：缺省字段以现有行参与校验，且只回 body 里显式出现的键。
 * 从前 PATCH 复用整套「缺省即默认值」的逻辑，改个名字就把 `active`/`sortOrder`/`grantRole`/
 * `creditCents` 静默重置成默认值（停用的档位被改回上架、卖 FREE 的档位被改成卖 PRO）——P3-9。
 */
function normalizeTier(
  body: TierInput,
  current?: TierRow
): { data?: Record<string, unknown>; error?: string } {
  const partial = current != null;
  const given = (k: (typeof TIER_KEYS)[number]) => body[k] !== undefined;
  // 校验用的「合并后完整档位」：PATCH 缺省沿用现有行的值。
  const merged: TierInput = {
    kind: given('kind') ? body.kind : current?.kind,
    name: given('name') ? body.name : current?.name,
    priceCents: given('priceCents') ? body.priceCents : current?.priceCents,
    grantRole: given('grantRole') ? body.grantRole : current?.grantRole,
    durationDays: given('durationDays') ? body.durationDays : current?.durationDays,
    grantMinutes: given('grantMinutes') ? body.grantMinutes : current?.grantMinutes,
    creditCents: given('creditCents') ? body.creditCents : current?.creditCents,
    active: given('active') ? body.active : current?.active ?? true,
    sortOrder: given('sortOrder') ? body.sortOrder : current?.sortOrder ?? 0,
  };

  const kind = merged.kind;
  if (!kind || !TIER_KINDS.includes(kind as TierKind)) {
    return { error: '档位类型无效（membership | minutes | topup）' };
  }
  // 换 kind 时 grantRole 等四列是派生的，必须跟着写（见 KIND_DERIVED_KEYS）。提前算出来，
  // 好让下面的 ADMIN 硬拒判断知道「本次请求到底会不会写 grantRole」。
  const kindChanged = partial && given('kind') && body.kind !== current?.kind;
  const name = (merged.name ?? '').trim();
  if (!name) return { error: '档位名称不能为空' };
  const priceCents = intOrNull(merged.priceCents);
  if (priceCents == null) return { error: '价格必须为非负整数（分）' };
  // P3-7：¥0 的会员/时长档 = 无限提款机（applyGrantTx 的余额守卫对 0 恒真），一个「0 元体验档」
  // 建完即成提款机。只对**本次请求带来的价格**设限——否则历史遗留的 0 元档连「停用」都改不动。
  if (kind !== 'topup' && priceCents <= 0 && (!partial || given('priceCents'))) {
    return { error: '会员/时间档位价格必须大于 0（¥0 档位等同无限领取）' };
  }

  const data: Record<string, unknown> = {
    kind,
    name,
    priceCents,
    active: merged.active ?? true,
    sortOrder: intOrNull(merged.sortOrder) ?? 0,
    grantRole: null,
    durationDays: null,
    grantMinutes: null,
    creditCents: null,
  };

  if (kind === 'membership') {
    const role = merged.grantRole ?? 'PRO';
    if (!isPurchasableMembershipRole(role)) {
      // 已存在的 ADMIN 商品必须还能被停用/整理，否则收紧校验反而会锁死补救入口。
      // 这里只兼容「原本就是 ADMIN 且最终仍保持下架」的 PATCH；新建、重新上架、
      // 换 kind 或显式写 ADMIN 一律拒绝。钱包最终发放边界还会独立 fail-closed。
      const quarantiningLegacyAdmin =
        partial &&
        current?.kind === 'membership' &&
        current.grantRole === 'ADMIN' &&
        !given('kind') &&
        !given('grantRole') &&
        merged.active === false;
      if (!quarantiningLegacyAdmin) {
        return { error: '会员商品不能授予管理员角色' };
      }
    }
    const days = intOrNull(merged.durationDays);
    if (!days || days <= 0) return { error: '会员档位必须设置正的时长天数' };
    data.grantRole = role;
    data.durationDays = days;
  } else if (kind === 'minutes') {
    const minutes = intOrNull(merged.grantMinutes);
    if (!minutes || minutes <= 0) return { error: '时间档位必须设置正的赠送分钟数' };
    data.grantMinutes = minutes;
  } else {
    // topup：creditCents 可空（默认等于 priceCents，在结算时兜底）
    const credit = intOrNull(merged.creditCents);
    data.creditCents = credit ?? priceCents;
  }

  if (!partial) return { data };

  const patch: Record<string, unknown> = {};
  for (const k of TIER_KEYS) {
    if (given(k) || (kindChanged && KIND_DERIVED_KEYS.includes(k))) patch[k] = data[k];
  }
  return { data: patch };
}

/**
 * 审计流水里的档位描述。**必须带 grantRole**（P6-15）：只写 name + kind 的话，一个卖 ADMIN 的
 * 会员档和一个卖 PRO 的在流水里长得一模一样 —— 这正是「档位偷偷改成授予 ADMIN」事后查不出来的原因。
 */
function describeTier(tier: {
  name: string;
  kind: string;
  grantRole: string | null;
  priceCents: number;
}): string {
  const role = tier.grantRole ? ` grantRole=${tier.grantRole}` : '';
  return `${tier.name} (${tier.kind}${role}, ${tier.priceCents}分)`;
}

// 列出所有档位
export const GET = withRequestLogging('admin:recharge:tiers:list', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:tiers:list',
  });
  if (response) return response;
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });
  const tiers = await prisma.rechargeTier.findMany({
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const payload = { tiers };
  try {
    await writeSecurityAudit(req, {
      event: 'recharge.tiers.read',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'recharge_tier_collection' },
      reason: 'admin_list',
      outcome: 'SUCCESS',
      metadata: { count: tiers.length },
    });
  } catch (err) {
    return auditUnavailable(err);
  }
  return NextResponse.json(payload);
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
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  let tier;
  try {
    tier = await prisma.$transaction(async (tx) => {
      const created = await tx.rechargeTier.create({ data: data as never });
      try {
        await writeSecurityAudit(
          req,
          {
            event: 'recharge.tier.create',
            operator: { id: admin.id, email: admin.email, role: admin.role },
            target: { type: 'recharge_tier', id: created.id },
            after: tierForAudit(created),
            reason: 'admin_create',
            outcome: 'SUCCESS',
          },
          tx
        );
      } catch (err) {
        throw new RequiredSecurityAuditError(err);
      }
      return created;
    });
  } catch (err) {
    if (err instanceof RequiredSecurityAuditError) return auditUnavailable(err.auditCause);
    throw err;
  }
  logAction(req, 'admin.recharge.tier.create', {
    user: admin,
    detail: `新建档位: ${describeTier(tier)}`,
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
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  try {
    const { tier, current } = await prisma.$transaction(async (tx) => {
      // 局部更新须在同一事务里读取实际旧值，避免并发更新后审计的 before 与真正被覆盖值不一致。
      const current = await tx.rechargeTier.findUnique({ where: { id: body.id } });
      if (!current) throw new TierResponseError(404, '档位不存在');
      const { data, error } = normalizeTier(body, current as unknown as TierRow);
      if (error) throw new TierResponseError(400, error);

      let updated;
      try {
        updated = await tx.rechargeTier.update({ where: { id: body.id }, data: data as never });
      } catch {
        throw new TierResponseError(404, '档位不存在');
      }
      try {
        await writeSecurityAudit(
          req,
          {
            event: 'recharge.tier.update',
            operator: { id: admin.id, email: admin.email, role: admin.role },
            target: { type: 'recharge_tier', id: updated.id },
            before: tierForAudit(current),
            after: tierForAudit(updated),
            reason: 'admin_update',
            outcome: 'SUCCESS',
          },
          tx
        );
      } catch (err) {
        throw new RequiredSecurityAuditError(err);
      }
      return { tier: updated, current };
    });
    logAction(req, 'admin.recharge.tier.update', {
      user: admin,
      detail: `更新档位: ${describeTier(tier)}（原 ${describeTier(current)}）`,
    });
    return NextResponse.json({ tier });
  } catch (err) {
    if (err instanceof RequiredSecurityAuditError) return auditUnavailable(err.auditCause);
    if (err instanceof TierResponseError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
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
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });
  try {
    const tier = await prisma.$transaction(async (tx) => {
      let deleted;
      try {
        deleted = await tx.rechargeTier.delete({ where: { id } });
      } catch {
        throw new TierResponseError(404, '档位不存在');
      }
      try {
        await writeSecurityAudit(
          req,
          {
            event: 'recharge.tier.delete',
            operator: { id: admin.id, email: admin.email, role: admin.role },
            target: { type: 'recharge_tier', id: deleted.id },
            before: tierForAudit(deleted),
            reason: 'admin_delete',
            outcome: 'SUCCESS',
          },
          tx
        );
      } catch (err) {
        throw new RequiredSecurityAuditError(err);
      }
      return deleted;
    });
    logAction(req, 'admin.recharge.tier.delete', {
      user: admin,
      detail: `删除档位: ${describeTier(tier)}`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RequiredSecurityAuditError) return auditUnavailable(err.auditCause);
    if (err instanceof TierResponseError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
