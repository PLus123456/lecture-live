import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { writeSecurityAudit } from '@/lib/securityAudit';

// 有效的 LLM 用途枚举值
const VALID_PURPOSES = ['CHAT', 'REALTIME_SUMMARY', 'FINAL_SUMMARY', 'KEYWORD_EXTRACTION', 'EMBEDDING', 'TRANSLATION'];
const VALID_THINKING_MODES = ['NONE', 'AUTO', 'FORCED', 'DEPTH'];

// 添加模型到指定供应商
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-models:create',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
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
      thinkingMode,
      supportsImage,
      maxTokens,
      contextWindow,
      temperature,
      purpose,
      isDefault,
      sortOrder,
    } = body;
    // supportsThinkingDepth 不再从 body 取，由 thinkingMode === 'DEPTH' 派生

    if (!modelId || !displayName) {
      return NextResponse.json(
        { error: '缺少必要字段: modelId, displayName' },
        { status: 400 }
      );
    }

    if (purpose && !VALID_PURPOSES.includes(purpose)) {
      return NextResponse.json(
        { error: `无效的用途，允许值: ${VALID_PURPOSES.join(', ')}` },
        { status: 400 }
      );
    }

    if (thinkingDepth && !['low', 'medium', 'high'].includes(thinkingDepth)) {
      return NextResponse.json(
        { error: '无效的 thinkingDepth，允许值: low, medium, high' },
        { status: 400 }
      );
    }

    if (thinkingMode && !VALID_THINKING_MODES.includes(thinkingMode)) {
      return NextResponse.json(
        { error: `无效的 thinkingMode，允许值: ${VALID_THINKING_MODES.join(', ')}` },
        { status: 400 }
      );
    }

    // 验证 contextWindow >= maxTokens（否则可输入预算 <= 0，所有 chat 都会立刻 EOL）
    const effectiveMaxTokens = maxTokens ?? 4096;
    const effectiveContextWindow = contextWindow ?? 8192;
    if (effectiveContextWindow < effectiveMaxTokens) {
      return NextResponse.json(
        { error: 'contextWindow 必须 ≥ maxTokens（上下文窗口必须大于等于单次输出 token 数）' },
        { status: 400 }
      );
    }

    const effectivePurpose = purpose || 'CHAT';

    // supportsThinkingDepth 由 mode === 'DEPTH' 派生（一致性保护）
    const effectiveThinkingMode = thinkingMode ?? 'NONE';
    const effectiveSupportsDepth = effectiveThinkingMode === 'DEPTH';

    const model = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.llmModel.updateMany({
          where: { purpose: effectivePurpose, isDefault: true },
          data: { isDefault: false },
        });
      }
      const created = await tx.llmModel.create({
        data: {
          providerId,
          modelId,
          displayName,
          thinkingDepth: thinkingDepth ?? 'medium',
          thinkingMode: effectiveThinkingMode,
          supportsThinkingDepth: effectiveSupportsDepth,
          supportsImage: Boolean(supportsImage),
          maxTokens: effectiveMaxTokens,
          contextWindow: effectiveContextWindow,
          temperature: temperature ?? 0.3,
          purpose: effectivePurpose,
          isDefault: isDefault ?? false,
          sortOrder: sortOrder ?? 0,
        },
      });
      await writeSecurityAudit(
        req,
        {
          event: 'llm-models.create',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'llm_model', id: created.id, providerId },
          after: {
            modelId: created.modelId,
            displayName: created.displayName,
            purpose: created.purpose,
            isDefault: created.isDefault,
            thinkingMode: created.thinkingMode,
            supportsImage: created.supportsImage,
            maxTokens: created.maxTokens,
            contextWindow: created.contextWindow,
          },
          reason: 'admin_create',
          outcome: 'SUCCESS',
        },
        tx
      );
      return created;
    });

    return NextResponse.json({ model }, { status: 201 });
  } catch (err) {
    console.error('添加 LLM 模型失败:', err);
    return NextResponse.json({ error: '添加模型失败' }, { status: 500 });
  }
}
