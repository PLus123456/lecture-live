import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';

// 有效的 LLM 用途枚举值
const VALID_PURPOSES = ['CHAT', 'REALTIME_SUMMARY', 'FINAL_SUMMARY', 'KEYWORD_EXTRACTION', 'EMBEDDING', 'TRANSLATION'];
const VALID_THINKING_MODES = ['NONE', 'AUTO', 'FORCED', 'DEPTH'];

// 更新模型
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; modelId: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-models:update',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id: providerId, modelId } = await params;

    // 检查模型是否存在且属于该供应商
    const existing = await prisma.llmModel.findFirst({
      where: { id: modelId, providerId },
    });
    if (!existing) {
      return NextResponse.json({ error: '模型不存在' }, { status: 404 });
    }

    const body = await req.json();

    // 验证 purpose 枚举值
    if (body.purpose && !VALID_PURPOSES.includes(body.purpose)) {
      return NextResponse.json(
        { error: `无效的用途，允许值: ${VALID_PURPOSES.join(', ')}` },
        { status: 400 }
      );
    }

    // 验证 thinkingDepth 值
    if (body.thinkingDepth && !['low', 'medium', 'high'].includes(body.thinkingDepth)) {
      return NextResponse.json(
        { error: '无效的 thinkingDepth，允许值: low, medium, high' },
        { status: 400 }
      );
    }

    if (body.thinkingMode && !VALID_THINKING_MODES.includes(body.thinkingMode)) {
      return NextResponse.json(
        { error: `无效的 thinkingMode，允许值: ${VALID_THINKING_MODES.join(', ')}` },
        { status: 400 }
      );
    }

    // 验证 contextWindow >= maxTokens 组合（用 patch 中提供的值；未提供则用现有值）
    const nextMaxTokens =
      body.maxTokens !== undefined ? Number(body.maxTokens) : existing.maxTokens;
    const nextContextWindow =
      body.contextWindow !== undefined ? Number(body.contextWindow) : existing.contextWindow;
    if (nextContextWindow < nextMaxTokens) {
      return NextResponse.json(
        { error: 'contextWindow 必须 ≥ maxTokens（上下文窗口必须大于等于单次输出 token 数）' },
        { status: 400 }
      );
    }

    // 只更新提供的字段
    const updateData: Record<string, unknown> = {};
    if (body.modelId !== undefined) updateData.modelId = body.modelId;
    if (body.displayName !== undefined) updateData.displayName = body.displayName;
    if (body.thinkingDepth !== undefined) updateData.thinkingDepth = body.thinkingDepth;
    if (body.thinkingMode !== undefined) updateData.thinkingMode = body.thinkingMode;
    if (body.supportsImage !== undefined)
      updateData.supportsImage = Boolean(body.supportsImage);
    if (body.maxTokens !== undefined) updateData.maxTokens = body.maxTokens;
    if (body.contextWindow !== undefined) updateData.contextWindow = body.contextWindow;
    if (body.temperature !== undefined) updateData.temperature = body.temperature;
    if (body.purpose !== undefined) updateData.purpose = body.purpose;
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

    // supportsThinkingDepth 由 mode === 'DEPTH' 派生（一致性保护，覆盖 body 值）
    const finalThinkingMode = (updateData.thinkingMode ?? existing.thinkingMode) as string;
    updateData.supportsThinkingDepth = finalThinkingMode === 'DEPTH';

    // 处理 isDefault 切换逻辑
    // U64：仅当 body.isDefault 显式给出时才重整默认，会漏掉「只改 purpose」的场景——
    // 一个 isDefault=true 的模型被 PATCH 到新 purpose 时会带着 true 过去，造成新 purpose
    // 双默认、旧 purpose 丢默认，sortOrder 兜底解析可能命中错误模型。故：最终 isDefault
    // （本次未给则沿用现有）为 true 时，一律对其最终 purpose 清理其他默认模型。
    const finalIsDefault =
      body.isDefault !== undefined ? Boolean(body.isDefault) : existing.isDefault;
    // body.purpose 已在上方按 VALID_PURPOSES 校验；未提供则沿用现有枚举值。
    const finalPurpose = (body.purpose ?? existing.purpose) as typeof existing.purpose;
    if (body.isDefault !== undefined) {
      updateData.isDefault = Boolean(body.isDefault);
    }
    if (finalIsDefault) {
      await prisma.llmModel.updateMany({
        where: {
          purpose: finalPurpose,
          isDefault: true,
          id: { not: modelId },
        },
        data: { isDefault: false },
      });
    }

    const model = await prisma.llmModel.update({
      where: { id: modelId },
      data: updateData,
    });

    // U67：模型级更新补审计
    logAction(req, 'admin.llm.model.update', {
      user: admin,
      detail: `更新 LLM 模型: ${model.modelId} (${finalPurpose}${finalIsDefault ? ', 默认' : ''})`,
    });

    return NextResponse.json({ model });
  } catch (err) {
    console.error('更新 LLM 模型失败:', err);
    return NextResponse.json({ error: '更新模型失败' }, { status: 500 });
  }
}

// 删除模型
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; modelId: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-models:delete',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id: providerId, modelId } = await params;

    // 检查模型是否存在且属于该供应商
    const existing = await prisma.llmModel.findFirst({
      where: { id: modelId, providerId },
    });
    if (!existing) {
      return NextResponse.json({ error: '模型不存在' }, { status: 404 });
    }

    await prisma.llmModel.delete({ where: { id: modelId } });

    // U67：模型级删除补审计（删默认模型会静默回落 sortOrder 模型，须留操作者痕迹）
    logAction(req, 'admin.llm.model.delete', {
      user: admin,
      detail: `删除 LLM 模型: ${existing.modelId} (${existing.purpose}${existing.isDefault ? ', 默认' : ''})`,
    });

    return NextResponse.json({ message: '模型已删除' });
  } catch (err) {
    console.error('删除 LLM 模型失败:', err);
    return NextResponse.json({ error: '删除模型失败' }, { status: 500 });
  }
}
