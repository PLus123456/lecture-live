import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';

// 有效的 LLM 用途枚举值
const VALID_PURPOSES = ['CHAT', 'REALTIME_SUMMARY', 'FINAL_SUMMARY', 'KEYWORD_EXTRACTION'];

// 更新模型
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; modelId: string }> }
) {
  const { response } = await requireAdminAccess(req, {
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

    // 只更新提供的字段
    const updateData: Record<string, unknown> = {};
    if (body.modelId !== undefined) updateData.modelId = body.modelId;
    if (body.displayName !== undefined) updateData.displayName = body.displayName;
    if (body.thinkingDepth !== undefined) updateData.thinkingDepth = body.thinkingDepth;
    if (body.maxTokens !== undefined) updateData.maxTokens = body.maxTokens;
    if (body.temperature !== undefined) updateData.temperature = body.temperature;
    if (body.purpose !== undefined) updateData.purpose = body.purpose;
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

    // 处理 isDefault 切换逻辑
    if (body.isDefault !== undefined) {
      updateData.isDefault = body.isDefault;
      // 如果设为默认，先取消同用途下其他默认模型
      if (body.isDefault) {
        const targetPurpose = body.purpose || existing.purpose;
        await prisma.llmModel.updateMany({
          where: {
            purpose: targetPurpose,
            isDefault: true,
            id: { not: modelId },
          },
          data: { isDefault: false },
        });
      }
    }

    const model = await prisma.llmModel.update({
      where: { id: modelId },
      data: updateData,
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
  const { response } = await requireAdminAccess(req, {
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

    return NextResponse.json({ message: '模型已删除' });
  } catch (err) {
    console.error('删除 LLM 模型失败:', err);
    return NextResponse.json({ error: '删除模型失败' }, { status: 500 });
  }
}
