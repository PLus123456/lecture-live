import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { coerceRegistryKind } from '@/lib/llm/registry';
import { LLM_PURPOSES, type LlmAdminPurpose } from '@/lib/llm/defaults';
import { createRouteForRegistry, purposeMatchesKind } from '@/lib/llm/attachRoute';

/**
 * POST /api/admin/llm-providers/[id]/registry
 * 在某网关下登记一个模型库条目，并可选地一步挂载到若干用途（body.purposes）。
 * 不传 purposes = 仅登记（后续在「用途路由」里挂载）。登记与挂载在同一事务内完成，
 * 挂载语义与 /api/admin/llm-routes 完全一致（首个模型自动成为该用途默认）。
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
    // 缺省规格：上下文 256K；输出顶到系统输出预算上限（tokenBudget.OUTPUT_TOKENS_CAP=8192，
    // 配得再大运行时也会被 clamp 回 8192，只是白吃输入预算）
    const maxTokens = Number(body.maxTokens ?? 8192);
    const contextWindow = Number(body.contextWindow ?? 262144);
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

    // 可选：登记时一步挂载的用途列表（去重；类型必须与模型 kind 匹配）
    const rawPurposes = Array.isArray(body.purposes) ? body.purposes : [];
    const purposes = Array.from(new Set(rawPurposes)) as LlmAdminPurpose[];
    for (const purpose of purposes) {
      if (!LLM_PURPOSES.includes(purpose)) {
        return NextResponse.json(
          { error: `purposes 含非法用途（允许值: ${LLM_PURPOSES.join(', ')}）` },
          { status: 400 }
        );
      }
      if (!purposeMatchesKind(purpose, kind)) {
        return NextResponse.json(
          {
            error:
              kind === 'EMBEDDING'
                ? '嵌入类模型只能挂载到嵌入用途'
                : '文本模型不能挂载到嵌入用途',
          },
          { status: 400 }
        );
      }
    }

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

    // 登记 + 挂载放同一事务：任一用途挂载失败则整体回滚，不留「半挂载」状态
    const registryId = await prisma.$transaction(async (tx) => {
      const created = await tx.llmRegistryModel.create({
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
      });
      for (const purpose of purposes) {
        await createRouteForRegistry(tx, created, purpose);
      }
      return created.id;
    });

    const registry = await prisma.llmRegistryModel.findUnique({
      where: { id: registryId },
      include: { routes: { select: { id: true, purpose: true, isDefault: true } } },
    });

    logAction(req, 'admin.llm.registry.create', {
      user: admin,
      detail: `登记模型: ${displayName} (${modelId}) @ ${provider.name}${
        purposes.length > 0 ? ` → 挂载 ${purposes.join('/')}` : ''
      }`,
    });

    return NextResponse.json({ registryModel: registry }, { status: 201 });
  } catch (err) {
    console.error('登记模型失败:', err);
    return NextResponse.json({ error: '登记模型失败' }, { status: 500 });
  }
}
