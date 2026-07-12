import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { verifyRegistryModel } from '@/lib/llm/verifyModel';

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
  if (response) {
    return response;
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

    const result = await verifyRegistryModel({
      provider: {
        apiBase: registry.provider.apiBase,
        apiKey: registry.provider.apiKey,
        isAnthropic: registry.provider.isAnthropic,
      },
      modelId: registry.modelId,
      kind: registry.kind,
    });

    const updated = await prisma.llmRegistryModel.update({
      where: { id: registryId },
      data: {
        status: result.ok ? 'OK' : 'FAILED',
        lastCheckedAt: new Date(),
        lastError: result.error,
      },
      include: { routes: { select: { id: true, purpose: true, isDefault: true } } },
    });

    logAction(req, 'admin.llm.registry.verify', {
      user: admin,
      detail: `验证模型 ${registry.displayName} (${registry.modelId}): ${result.ok ? 'OK' : `FAILED - ${result.error}`}`,
    });

    return NextResponse.json({ registryModel: updated, ok: result.ok });
  } catch (err) {
    console.error('验证模型失败:', err);
    return NextResponse.json({ error: '验证模型失败' }, { status: 500 });
  }
}
