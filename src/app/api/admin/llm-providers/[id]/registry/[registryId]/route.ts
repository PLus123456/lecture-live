import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import {
  coerceRegistryKind,
  syncRegistrySpecToRoutes,
  type RegistrySpec,
} from '@/lib/llm/registry';

/**
 * PATCH /api/admin/llm-providers/[id]/registry/[registryId]
 * 更新模型库条目的规格，并写穿到其下所有用途路由行（运行时只读路由行）。
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; registryId: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-registry:update',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id: providerId, registryId } = await params;
    const existing = await prisma.llmRegistryModel.findFirst({
      where: { id: registryId, providerId },
    });
    if (!existing) {
      return NextResponse.json({ error: '模型不存在' }, { status: 404 });
    }

    const body = await req.json();

    const modelId =
      typeof body.modelId === 'string' && body.modelId.trim()
        ? body.modelId.trim()
        : existing.modelId;
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim()
        : existing.displayName;
    const kind =
      body.kind !== undefined ? coerceRegistryKind(body.kind) : existing.kind;
    const supportsImage =
      body.supportsImage !== undefined
        ? Boolean(body.supportsImage)
        : existing.supportsImage;
    const maxTokens =
      body.maxTokens !== undefined ? Number(body.maxTokens) : existing.maxTokens;
    const contextWindow =
      body.contextWindow !== undefined
        ? Number(body.contextWindow)
        : existing.contextWindow;

    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      return NextResponse.json({ error: 'maxTokens 必须是正整数' }, { status: 400 });
    }
    if (!Number.isFinite(contextWindow) || contextWindow < maxTokens) {
      return NextResponse.json(
        { error: 'contextWindow 必须 ≥ maxTokens（上下文窗口必须大于等于单次输出 token 数）' },
        { status: 400 }
      );
    }

    let embeddingDimensions = existing.embeddingDimensions;
    if (body.embeddingDimensions !== undefined) {
      const raw = Number(body.embeddingDimensions);
      embeddingDimensions =
        Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
    }
    if (kind !== 'EMBEDDING') {
      embeddingDimensions = null;
    }

    // 同网关下 (modelId, displayName) 唯一
    const dup = await prisma.llmRegistryModel.findFirst({
      where: { providerId, modelId, displayName, id: { not: registryId } },
    });
    if (dup) {
      return NextResponse.json(
        { error: '该网关下已存在同名同标识的模型' },
        { status: 400 }
      );
    }

    const spec: RegistrySpec = {
      modelId,
      displayName,
      supportsImage,
      maxTokens: Math.floor(maxTokens),
      contextWindow: Math.floor(contextWindow),
    };

    // modelId 变了 → 之前的连通性验证结果失效
    const statusReset =
      modelId !== existing.modelId
        ? { status: 'UNVERIFIED', lastCheckedAt: null, lastError: null }
        : {};

    const registry = await prisma.$transaction(async (tx) => {
      const updated = await tx.llmRegistryModel.update({
        where: { id: registryId },
        data: {
          kind,
          embeddingDimensions,
          ...spec,
          ...statusReset,
          ...(body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))
            ? { sortOrder: Math.floor(Number(body.sortOrder)) }
            : {}),
        },
        include: {
          routes: { select: { id: true, purpose: true, isDefault: true } },
        },
      });
      // 规格写穿到所有路由行
      await syncRegistrySpecToRoutes(registryId, spec, tx);
      return updated;
    });

    logAction(req, 'admin.llm.registry.update', {
      user: admin,
      detail: `更新模型: ${displayName} (${modelId})`,
    });

    return NextResponse.json({ registryModel: registry });
  } catch (err) {
    console.error('更新模型失败:', err);
    return NextResponse.json({ error: '更新模型失败' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/llm-providers/[id]/registry/[registryId]
 * 从模型库移除模型（外键级联删除其所有用途路由行；组绑定的失效 id 由
 * resolveSummaryModel/access 的存在性校验静默回落全局默认）。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; registryId: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-registry:delete',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id: providerId, registryId } = await params;
    const existing = await prisma.llmRegistryModel.findFirst({
      where: { id: registryId, providerId },
    });
    if (!existing) {
      return NextResponse.json({ error: '模型不存在' }, { status: 404 });
    }

    await prisma.llmRegistryModel.delete({ where: { id: registryId } });

    logAction(req, 'admin.llm.registry.delete', {
      user: admin,
      detail: `移除模型: ${existing.displayName} (${existing.modelId})`,
    });

    return NextResponse.json({ message: '模型已移除' });
  } catch (err) {
    console.error('移除模型失败:', err);
    return NextResponse.json({ error: '移除模型失败' }, { status: 500 });
  }
}
