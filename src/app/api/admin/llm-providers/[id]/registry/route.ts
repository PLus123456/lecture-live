import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { coerceRegistryKind } from '@/lib/llm/registry';

/**
 * POST /api/admin/llm-providers/[id]/registry
 * 在某网关下登记一个模型库条目（仅规格，不挂任何用途；挂用途走 /api/admin/llm-routes）。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-registry:create',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id: providerId } = await params;
    const provider = await prisma.llmProvider.findUnique({
      where: { id: providerId },
    });
    if (!provider) {
      return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
    }

    const body = await req.json();
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!modelId || !displayName) {
      return NextResponse.json(
        { error: '缺少必要字段: modelId, displayName' },
        { status: 400 }
      );
    }

    const kind = coerceRegistryKind(body.kind);
    const maxTokens = Number(body.maxTokens ?? 4096);
    const contextWindow = Number(body.contextWindow ?? 8192);
    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      return NextResponse.json({ error: 'maxTokens 必须是正整数' }, { status: 400 });
    }
    if (!Number.isFinite(contextWindow) || contextWindow < maxTokens) {
      return NextResponse.json(
        { error: 'contextWindow 必须 ≥ maxTokens（上下文窗口必须大于等于单次输出 token 数）' },
        { status: 400 }
      );
    }
    const rawDimensions = Number(body.embeddingDimensions);
    const embeddingDimensions =
      kind === 'EMBEDDING' && Number.isFinite(rawDimensions) && rawDimensions > 0
        ? Math.floor(rawDimensions)
        : null;

    // 同网关下 (modelId, displayName) 唯一，避免模型库里出现无法区分的重复条目
    const dup = await prisma.llmRegistryModel.findFirst({
      where: { providerId, modelId, displayName },
    });
    if (dup) {
      return NextResponse.json(
        { error: '该网关下已存在同名同标识的模型' },
        { status: 400 }
      );
    }

    const maxSort = await prisma.llmRegistryModel.aggregate({
      where: { providerId },
      _max: { sortOrder: true },
    });

    const registry = await prisma.llmRegistryModel.create({
      data: {
        providerId,
        modelId,
        displayName,
        kind,
        supportsImage: Boolean(body.supportsImage ?? false),
        maxTokens: Math.floor(maxTokens),
        contextWindow: Math.floor(contextWindow),
        embeddingDimensions,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      include: { routes: { select: { id: true, purpose: true, isDefault: true } } },
    });

    logAction(req, 'admin.llm.registry.create', {
      user: admin,
      detail: `登记模型: ${displayName} (${modelId}) @ ${provider.name}`,
    });

    return NextResponse.json({ registryModel: registry }, { status: 201 });
  } catch (err) {
    console.error('登记模型失败:', err);
    return NextResponse.json({ error: '登记模型失败' }, { status: 500 });
  }
}
