import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { verifyRegistryModel } from '@/lib/llm/verifyModel';
import { JOB_TYPE, trackJob } from '@/lib/jobQueue';
import { writeSecurityAudit } from '@/lib/securityAudit';

/**
 * POST /api/admin/llm-providers/[id]/registry/[registryId]/verify
 * 对模型库条目发一次最小探测请求，结果写回 status/lastCheckedAt/lastError。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; registryId: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    // 出站真实请求，限得比普通 CRUD 更紧
    scope: 'admin:llm-registry:verify',
    limit: 15,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const { id: providerId, registryId } = await params;
    const registry = await prisma.llmRegistryModel.findFirst({
      where: { id: registryId, providerId },
      include: { provider: true },
    });
    if (!registry) {
      return NextResponse.json({ error: '模型不存在' }, { status: 404 });
    }

    const result = await trackJob(
      {
        type: JOB_TYPE.ADMIN_INTEGRATION,
        triggeredBy: `admin:${admin.id}`,
        params: {
          operation: 'llm_registry_verify',
          providerId,
          registryId,
        },
        resultSummary: (value) => ({ ok: value.ok }),
        errorSummary: (error) =>
          error instanceof Error ? error.name : 'UnknownError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === 'FAILED') {
            await writeSecurityAudit(
              req,
              {
                event: 'llm-registry.verify',
                operator: { id: admin.id, email: admin.email, role: admin.role },
                target: { type: 'llm_registry_model', id: registryId, providerId },
                before: { status: registry.status },
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

          const updated = await tx.llmRegistryModel.update({
            where: { id: registryId },
            data: {
              status: terminal.result.ok ? 'OK' : 'FAILED',
              lastCheckedAt: new Date(),
              lastError: terminal.result.error,
            },
            include: {
              routes: { select: { id: true, purpose: true, isDefault: true } },
            },
          });
          await writeSecurityAudit(
            req,
            {
              event: 'llm-registry.verify',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'llm_registry_model', id: registryId, providerId },
              before: { status: registry.status },
              after: {
                status: updated.status,
                verified: terminal.result.ok,
                routeCount: updated.routes.length,
              },
              reason: 'admin_connectivity_verify',
              outcome: terminal.result.ok ? 'SUCCESS' : 'FAILED',
              metadata: { hasError: Boolean(terminal.result.error) },
            },
            tx
          );
        },
      },
      () =>
        verifyRegistryModel({
          provider: {
            apiBase: registry.provider.apiBase,
            apiKey: registry.provider.apiKey,
            isAnthropic: registry.provider.isAnthropic,
          },
          modelId: registry.modelId,
          kind: registry.kind,
        })
    );

    const updated = await prisma.llmRegistryModel.findFirst({
      where: { id: registryId, providerId },
      include: {
        routes: { select: { id: true, purpose: true, isDefault: true } },
      },
    });
    if (!updated) throw new Error('验证后的模型不存在');
    return NextResponse.json({ registryModel: updated, ok: result.ok });
  } catch (err) {
    console.error('验证模型失败:', err);
    return NextResponse.json({ error: '验证模型失败' }, { status: 500 });
  }
}
