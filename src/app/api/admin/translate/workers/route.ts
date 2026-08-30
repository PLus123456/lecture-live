import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt } from '@/lib/crypto';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';
import { writeSecurityAudit } from '@/lib/securityAudit';

export const runtime = 'nodejs';

/** worker 行对 admin 的序列化（token 恒不出网，只回 hasToken） */
function serializeWorker(row: {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
  concurrency: number;
  weight: number;
  qps: number;
  status: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  sortOrder: number;
}) {
  return {
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
  };
}

function auditWorker(row: Parameters<typeof serializeWorker>[0]) {
  let endpointOrigin: string | null = null;
  try {
    endpointOrigin = new URL(row.baseUrl).origin;
  } catch {
    // 已有脏数据不应让只读审计泄露原值或阻断序列化；只记录无效标记。
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

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sanitizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) return null;
  try {
    validateCloudreveBaseUrl(url); // 复用统一的出站地址校验（格式 + 防 SSRF 私网过滤）
  } catch {
    return null;
  }
  return url;
}

/** GET /api/admin/translate/workers — worker 列表 */
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:translate-workers:list',
    limit: 60,
  });
  if (response || !admin) return response!;
  try {
    const rows = await prisma.translationWorker.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    await writeSecurityAudit(req, {
      event: 'translate-workers.read',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'translation_worker_collection', ids: rows.map((row) => row.id) },
      after: {
        count: rows.length,
        enabledCount: rows.filter((row) => row.enabled).length,
      },
      reason: 'admin_list',
      outcome: 'SUCCESS',
    });
    return NextResponse.json({ workers: rows.map(serializeWorker) });
  } catch (err) {
    console.error('读取翻译 worker 失败:', err);
    return NextResponse.json({ error: '读取失败' }, { status: 500 });
  }
}

/** POST /api/admin/translate/workers — 新建 worker（一机一行一套设置） */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:translate-workers:create',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    const baseUrl = sanitizeBaseUrl(body.baseUrl);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
    if (!baseUrl) return NextResponse.json({ error: 'worker 地址不合法' }, { status: 400 });
    if (token.length < 32) {
      return NextResponse.json({ error: 'token 至少 32 字符' }, { status: 400 });
    }

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.translationWorker.create({
        data: {
          name,
          baseUrl,
          token: encrypt(token),
          enabled: body.enabled !== false,
          concurrency: clampInt(body.concurrency, 1, 1, 8),
          weight: clampInt(body.weight, 1, 1, 100),
          qps: clampInt(body.qps, 4, 1, 100),
          sortOrder: clampInt(body.sortOrder, 0, 0, 9999),
        },
      });
      await writeSecurityAudit(
        req,
        {
          event: 'translate-workers.create',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'translation_worker', id: created.id },
          after: auditWorker(created),
          reason: 'admin_create',
          outcome: 'SUCCESS',
        },
        tx
      );
      return created;
    });
    return NextResponse.json({ worker: serializeWorker(row) });
  } catch (err) {
    console.error('新建翻译 worker 失败:', err);
    return NextResponse.json({ error: '创建失败' }, { status: 500 });
  }
}
