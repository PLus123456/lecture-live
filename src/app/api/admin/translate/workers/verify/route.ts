import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { decrypt } from '@/lib/crypto';
import { verifyAndRecordWorker } from '@/lib/translate/workerClient';

export const runtime = 'nodejs';

/**
 * POST /api/admin/translate/workers/verify — 测试连接。
 * body: { id? } 指定单台；缺省全部。结果落库（status/lastCheckedAt/lastError），
 * 面板健康灯反映最近一次真实探测（与音频增强纯只读 verify 的差异：集群化后落库便于一览）。
 */
export async function POST(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:translate-workers:verify',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) return response;

  try {
    const body = await req.json().catch(() => ({}));
    const targetId = typeof body.id === 'string' ? body.id : null;
    const rows = await prisma.translationWorker.findMany({
      where: targetId ? { id: targetId } : {},
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (rows.length === 0) {
      return NextResponse.json({ error: '没有可探测的 worker' }, { status: 404 });
    }

    const results = await Promise.all(
      rows.map(async (row) => {
        let token = '';
        try {
          token = decrypt(row.token);
        } catch {
          token = '';
        }
        if (!token) {
          await prisma.translationWorker
            .update({
              where: { id: row.id },
              data: { status: 'FAILED', lastCheckedAt: new Date(), lastError: 'token 解密失败' },
            })
            .catch(() => undefined);
          return { id: row.id, name: row.name, baseUrl: row.baseUrl, ok: false, error: 'token 解密失败' };
        }
        const health = await verifyAndRecordWorker({ id: row.id, baseUrl: row.baseUrl, token });
        // queue 缺失 = 无鉴权的裸响应（token 不对），一并判失败
        const ok = Boolean(health?.ok && health.queue);
        if (health && !health.queue) {
          await prisma.translationWorker
            .update({
              where: { id: row.id },
              data: { status: 'FAILED', lastError: 'token 鉴权失败（healthz 未返回队列详情）' },
            })
            .catch(() => undefined);
        }
        return {
          id: row.id,
          name: row.name,
          baseUrl: row.baseUrl,
          ok,
          version: health?.version ?? null,
          queue: health?.queue ?? null,
          engine: health?.engine ?? null,
          error: ok ? null : health ? 'token 鉴权失败' : '连接失败',
        };
      })
    );

    return NextResponse.json({ ok: results.every((r) => r.ok), workers: results });
  } catch (err) {
    console.error('翻译 worker 测试连接失败:', err);
    return NextResponse.json({ error: '探测失败' }, { status: 500 });
  }
}
