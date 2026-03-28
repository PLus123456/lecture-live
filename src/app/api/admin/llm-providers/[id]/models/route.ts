import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';

// 有效的 LLM 用途枚举值
const VALID_PURPOSES = ['CHAT', 'REALTIME_SUMMARY', 'FINAL_SUMMARY', 'KEYWORD_EXTRACTION'];

// 添加模型到指定供应商
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:llm-models:create',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id: providerId } = await params;

    // 检查供应商是否存在
    const provider = await prisma.llmProvider.findUnique({ where: { id: providerId } });
    if (!provider) {
      return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
    }

    const body = await req.json();
    const {
      modelId,
      displayName,
      thinkingDepth,
      maxTokens,
      temperature,
      purpose,
      isDefault,
      sortOrder,
    } = body;

    if (!modelId || !displayName) {
      return NextResponse.json(
        { error: '缺少必要字段: modelId, displayName' },
        { status: 400 }
      );
    }

    // 验证 purpose 枚举值
    if (purpose && !VALID_PURPOSES.includes(purpose)) {
      return NextResponse.json(
        { error: `无效的用途，允许值: ${VALID_PURPOSES.join(', ')}` },
        { status: 400 }
      );
    }

    // 验证 thinkingDepth 值
    if (thinkingDepth && !['low', 'medium', 'high'].includes(thinkingDepth)) {
      return NextResponse.json(
        { error: '无效的 thinkingDepth，允许值: low, medium, high' },
        { status: 400 }
      );
    }

    // 如果设置为默认模型，先取消同用途下其他默认模型
    const effectivePurpose = purpose || 'CHAT';
    if (isDefault) {
      await prisma.llmModel.updateMany({
        where: { purpose: effectivePurpose, isDefault: true },
        data: { isDefault: false },
      });
    }

    const model = await prisma.llmModel.create({
      data: {
        providerId,
        modelId,
        displayName,
        thinkingDepth: thinkingDepth ?? 'medium',
        maxTokens: maxTokens ?? 4096,
        temperature: temperature ?? 0.3,
        purpose: effectivePurpose,
        isDefault: isDefault ?? false,
        sortOrder: sortOrder ?? 0,
      },
    });

    return NextResponse.json({ model }, { status: 201 });
  } catch (err) {
    console.error('添加 LLM 模型失败:', err);
    return NextResponse.json({ error: '添加模型失败' }, { status: 500 });
  }
}
