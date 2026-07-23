import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { encrypt } from '@/lib/crypto';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';

export const runtime = 'nodejs';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
  if (response) return response;

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
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.concurrency !== undefined) data.concurrency = clampInt(body.concurrency, existing.concurrency, 1, 8);
    if (body.weight !== undefined) data.weight = clampInt(body.weight, existing.weight, 1, 100);
    if (body.qps !== undefined) data.qps = clampInt(body.qps, existing.qps, 1, 100);
    if (body.sortOrder !== undefined) data.sortOrder = clampInt(body.sortOrder, existing.sortOrder, 0, 9999);

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }
    const row = await prisma.translationWorker.update({ where: { id }, data });
    logAction(req, 'admin.translate.worker.update', {
      user: admin,
      detail: `更新翻译 worker: ${row.name}`,
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
  if (response) return response;

  try {
    const { id } = await params;
    const row = await prisma.translationWorker.delete({ where: { id } }).catch(() => null);
    if (!row) {
      return NextResponse.json({ error: 'worker 不存在' }, { status: 404 });
    }
    logAction(req, 'admin.translate.worker.delete', {
      user: admin,
      detail: `删除翻译 worker: ${row.name} (${row.baseUrl})`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('删除翻译 worker 失败:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
