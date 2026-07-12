import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { LLM_PURPOSES, type LlmAdminPurpose } from '@/lib/llm/defaults';
import {
  VALID_THINKING_MODES,
  VALID_DEPTHS,
  DEFAULT_TEMPERATURE,
  coerceTemperature,
} from '@/lib/llm/routeParams';

/**
 * POST /api/admin/llm-routes
 * 把模型库条目挂载到某个用途（创建一条路由行 LlmModel）。
 * body: { registryId, purpose, thinkingMode?, thinkingDepth?, temperature?, isDefault? }
 * 规格字段从模型库写穿；该用途此前没有模型时，新路由自动成为默认。
 */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-routes:create',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const body = await req.json();
    const registryId =
      typeof body.registryId === 'string' ? body.registryId.trim() : '';
    const purpose = body.purpose as LlmAdminPurpose;

    if (!registryId || !LLM_PURPOSES.includes(purpose)) {
      return NextResponse.json(
        { error: `缺少 registryId 或 purpose 非法（允许值: ${LLM_PURPOSES.join(', ')}）` },
        { status: 400 }
      );
    }

    const registry = await prisma.llmRegistryModel.findUnique({
      where: { id: registryId },
    });
    if (!registry) {
      return NextResponse.json({ error: '模型库中不存在该模型' }, { status: 404 });
    }

    // 嵌入用途只能挂嵌入模型，文本用途只能挂文本模型
    if ((purpose === 'EMBEDDING') !== (registry.kind === 'EMBEDDING')) {
      return NextResponse.json(
        {
          error:
            purpose === 'EMBEDDING'
              ? '嵌入用途只能挂载嵌入类模型'
              : '嵌入类模型只能挂载到嵌入用途',
        },
        { status: 400 }
      );
    }

    const existingRoute = await prisma.llmModel.findFirst({
      where: { registryId, purpose },
    });
    if (existingRoute) {
      return NextResponse.json(
        { error: '该模型已挂载到此用途' },
        { status: 400 }
      );
    }

    const thinkingMode = (body.thinkingMode ?? 'NONE') as string;
    if (!(VALID_THINKING_MODES as readonly string[]).includes(thinkingMode)) {
      return NextResponse.json(
        { error: `无效的思考模式，允许值: ${VALID_THINKING_MODES.join(', ')}` },
        { status: 400 }
      );
    }
    const thinkingDepth = (body.thinkingDepth ?? 'medium') as string;
    if (!(VALID_DEPTHS as readonly string[]).includes(thinkingDepth)) {
      return NextResponse.json(
        { error: `无效的思考深度，允许值: ${VALID_DEPTHS.join(', ')}` },
        { status: 400 }
      );
    }
    const temperature = coerceTemperature(
      body.temperature,
      DEFAULT_TEMPERATURE[purpose]
    );
    if (temperature === null) {
      return NextResponse.json(
        { error: 'temperature 必须是 0–2 之间的数字' },
        { status: 400 }
      );
    }

    const route = await prisma.$transaction(async (tx) => {
      const purposeCount = await tx.llmModel.count({ where: { purpose } });
      const maxSort = await tx.llmModel.aggregate({
        where: { purpose },
        _max: { sortOrder: true },
      });
      // 显式要求默认，或该用途首个模型 → 设为默认
      const makeDefault = Boolean(body.isDefault) || purposeCount === 0;
      if (makeDefault) {
        await tx.llmModel.updateMany({
          where: { purpose, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.llmModel.create({
        data: {
          providerId: registry.providerId,
          registryId: registry.id,
          // 规格：模型库写穿副本
          modelId: registry.modelId,
          displayName: registry.displayName,
          supportsImage: registry.supportsImage,
          maxTokens: registry.maxTokens,
          contextWindow: registry.contextWindow,
          // 路由层参数
          purpose,
          thinkingMode,
          supportsThinkingDepth: thinkingMode === 'DEPTH',
          thinkingDepth,
          temperature,
          isDefault: makeDefault,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        },
      });
    });

    logAction(req, 'admin.llm.route.create', {
      user: admin,
      detail: `挂载模型到用途: ${registry.displayName} → ${purpose}`,
    });

    return NextResponse.json({ route }, { status: 201 });
  } catch (err) {
    console.error('挂载模型到用途失败:', err);
    return NextResponse.json({ error: '挂载失败' }, { status: 500 });
  }
}
