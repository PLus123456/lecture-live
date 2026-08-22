import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt } from '@/lib/crypto';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';
import { writeSecurityAudit } from '@/lib/securityAudit';

export const runtime = 'nodejs';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function auditWorker(row: {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
  concurrency: number;
  weight: number;
  qps: number;
  status: string;
  sortOrder: number;
}) {
  let endpointOrigin: string | null = null;
  try {
    endpointOrigin = new URL(row.baseUrl).origin;
  } catch {
    // 不把脏 endpoint 原文写进审计。
  }
  return {
    id: row.id,
    name: row.name,
    endpointOrigin,
    endpointValid: endpointOrigin !== null,
    hasToken: Boolean(row.token),
    enabled: row.enabled,
    concurrency: row.concurrency,
    weight: row.weight,
    qps: row.qps,
    status: row.status,
    sortOrder: row.sortOrder,
  };
}

/** PATCH /api/admin/translate/workers/[id] — 更新单台设置（token 空串=保持原值） */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:translate-workers:update',
    limit: 60,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const existing = await prisma.translationWorker.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'worker 不存在' }, { status: 404 });
    }
    const body = await req.json();
    const data: Record<string, unknown> = {};

    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim().slice(0, 60);
    }
    if (typeof body.baseUrl === 'string') {
      const url = body.baseUrl.trim().replace(/\/+$/, '');
      if (!url) return NextResponse.json({ error: 'worker 地址不能为空' }, { status: 400 });
      try {
        validateCloudreveBaseUrl(url);
      } catch {
        return NextResponse.json({ error: 'worker 地址不合法' }, { status: 400 });
      }
      data.baseUrl = url;
    }
    if (typeof body.token === 'string' && body.token.trim()) {
      const token = body.token.trim();
      if (token.length < 32) {
        return NextResponse.json({ error: 'token 至少 32 字符' }, { status: 400 });
      }
      data.token = encrypt(token);
      // 换 token 后旧探测结论作废
      data.status = 'UNVERIFIED';
      data.lastError = null;
    }

    // 注：这里**刻意不做**「改 baseUrl 必须重填 token」的换靶闸（P2-2 已收窄为只保 SMTP）。
    // worker 是自建服务，换机器/换 IP 是常规运维动作，不该每次都逼着去翻 token。
    // 残余风险与收口方向见 admin/settings/route.ts 里的说明。

    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.concurrency !== undefined) data.concurrency = clampInt(body.concurrency, existing.concurrency, 1, 8);
    if (body.weight !== undefined) data.weight = clampInt(body.weight, existing.weight, 1, 100);
    if (body.qps !== undefined) data.qps = clampInt(body.qps, existing.qps, 1, 100);
    if (body.sortOrder !== undefined) data.sortOrder = clampInt(body.sortOrder, existing.sortOrder, 0, 9999);

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.translationWorker.update({ where: { id }, data });
      await writeSecurityAudit(
        req,
        {
          event: 'translate-workers.update',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'translation_worker', id },
          before: auditWorker(existing),
          after: auditWorker(updated),
          reason: 'admin_update',
          outcome: 'SUCCESS',
          metadata: { changedFields: Object.keys(data).filter((key) => key !== 'token'), tokenChanged: data.token !== undefined },
        },
        tx
      );
      return updated;
    });
    return NextResponse.json({
      worker: {
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        hasToken: Boolean(row.token),
        enabled: row.enabled,
        concurrency: row.concurrency,
        weight: row.weight,
        qps: row.qps,
        status: row.status,
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        lastError: row.lastError,
        sortOrder: row.sortOrder,
      },
    });
  } catch (err) {
    console.error('更新翻译 worker 失败:', err);
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}

/** DELETE /api/admin/translate/workers/[id] — 删除（在途任务由调度器回炉换台） */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:translate-workers:delete',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const existing = await prisma.translationWorker.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'worker 不存在' }, { status: 404 });
    }
    await prisma.$transaction(async (tx) => {
      await tx.translationWorker.delete({ where: { id } });
      await writeSecurityAudit(
        req,
        {
          event: 'translate-workers.delete',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'translation_worker', id },
          before: auditWorker(existing),
          after: { deleted: true },
          reason: 'admin_delete',
          outcome: 'SUCCESS',
        },
        tx
      );
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('删除翻译 worker 失败:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
