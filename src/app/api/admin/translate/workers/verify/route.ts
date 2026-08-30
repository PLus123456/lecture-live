import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { decrypt } from '@/lib/crypto';
import { pingTranslateWorker } from '@/lib/translate/workerClient';
import { JOB_TYPE, trackJob } from '@/lib/jobQueue';
import { writeSecurityAudit } from '@/lib/securityAudit';

export const runtime = 'nodejs';

/**
 * POST /api/admin/translate/workers/verify — 测试连接。
 * body: { id? } 指定单台；缺省全部。结果落库（status/lastCheckedAt/lastError），
 * 面板健康灯反映最近一次真实探测（与音频增强纯只读 verify 的差异：集群化后落库便于一览）。
 */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:translate-workers:verify',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

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

    const operation = await trackJob(
      {
        type: JOB_TYPE.ADMIN_INTEGRATION,
        triggeredBy: `admin:${admin.id}`,
        params: {
          operation: 'translation_worker_verify',
          targetIds: rows.map((row) => row.id),
        },
        resultSummary: (value) => ({
          checkedCount: value.publicResults.length,
          okCount: value.publicResults.filter((entry) => entry.ok).length,
        }),
        errorSummary: (error) =>
          error instanceof Error ? error.name : 'UnknownError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === 'FAILED') {
            await writeSecurityAudit(
              req,
              {
                event: 'translate-workers.verify',
                operator: { id: admin.id, email: admin.email, role: admin.role },
                target: {
                  type: 'translation_worker_collection',
                  ids: rows.map((row) => row.id),
                },
                before: { requestedCount: rows.length },
                reason: 'admin_connectivity_verify',
                outcome: 'FAILED',
                metadata: {
                  errorClass:
                    terminal.error instanceof Error
                      ? terminal.error.name
                      : 'UnknownError',
                },
              },
              tx
            );
            return;
          }

          for (const update of terminal.result.statusUpdates) {
            await tx.translationWorker.update({
              where: { id: update.id },
              data: update.data,
            });
          }
          const okCount = terminal.result.publicResults.filter(
            (entry) => entry.ok
          ).length;
          await writeSecurityAudit(
            req,
            {
              event: 'translate-workers.verify',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: {
                type: 'translation_worker_collection',
                ids: rows.map((row) => row.id),
              },
              before: { requestedCount: rows.length },
              after: {
                checkedCount: rows.length,
                okCount,
                failedCount: rows.length - okCount,
              },
              reason: 'admin_connectivity_verify',
              outcome:
                okCount === rows.length
                  ? 'SUCCESS'
                  : okCount === 0
                    ? 'FAILED'
                    : 'PARTIAL',
            },
            tx
          );
        },
      },
      async () => {
        const checkedAt = new Date();
        const probes = await Promise.all(
          rows.map(async (row) => {
            let token = '';
            try {
              token = decrypt(row.token);
            } catch {
              token = '';
            }

            if (!token) {
              return {
                publicResult: {
                  id: row.id,
                  name: row.name,
                  baseUrl: row.baseUrl,
                  ok: false,
                  version: null,
                  queue: null,
                  engine: null,
                  error: 'token 解密失败',
                },
                statusData: {
                  status: 'FAILED',
                  lastCheckedAt: checkedAt,
                  lastError: 'token 解密失败',
                },
              };
            }

            try {
              const health = await pingTranslateWorker({
                baseUrl: row.baseUrl,
                token,
              });
              // queue 缟失代表可能命中了未鉴权的裸 healthz，不能当凭据验证成功。
              const ok = Boolean(health.ok && health.queue);
              const lastError = ok
                ? null
                : health.queue
                  ? 'healthz 返回 ok=false'
                  : 'token 鉴权失败（healthz 未返回队列详情）';
              return {
                publicResult: {
                  id: row.id,
                  name: row.name,
                  baseUrl: row.baseUrl,
                  ok,
                  version: health.version ?? null,
                  queue: health.queue ?? null,
                  engine: health.engine ?? null,
                  error: ok ? null : 'token 鉴权失败',
                },
                statusData: {
                  status: ok ? 'OK' : 'FAILED',
                  lastCheckedAt: checkedAt,
                  lastError,
                },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                publicResult: {
                  id: row.id,
                  name: row.name,
                  baseUrl: row.baseUrl,
                  ok: false,
                  version: null,
                  queue: null,
                  engine: null,
                  error: '连接失败',
                },
                statusData: {
                  status: 'FAILED',
                  lastCheckedAt: checkedAt,
                  lastError: message.slice(0, 500),
                },
              };
            }
          })
        );

        return {
          publicResults: probes.map((probe) => probe.publicResult),
          statusUpdates: probes.map((probe, index) => ({
            id: rows[index].id,
            data: probe.statusData,
          })),
        };
      }
    );
    const results = operation.publicResults;

    return NextResponse.json({ ok: results.every((r) => r.ok), workers: results });
  } catch (err) {
    console.error('翻译 worker 测试连接失败:', err);
    return NextResponse.json({ error: '探测失败' }, { status: 500 });
  }
}
