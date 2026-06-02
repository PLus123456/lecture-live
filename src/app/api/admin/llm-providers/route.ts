import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt } from '@/lib/crypto';
import {
  normalizeDefaultModelsByPurpose,
  pickDefaultModelIdsByPurpose,
} from '@/lib/llm/defaults';
import { serializeProviderForAdmin } from '@/lib/llm/providerAdmin';
import { logAction } from '@/lib/auditLog';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';

// 获取所有 LLM 供应商及其模型
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:llm-providers:list',
    limit: 60,
  });
  if (response) {
    return response;
  }

  try {
    const providers = await prisma.llmProvider.findMany({
      include: {
        models: {
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    return NextResponse.json({
      providers: providers.map((provider) => serializeProviderForAdmin(provider)),
    });
  } catch (err) {
    console.error('获取 LLM 供应商列表失败:', err);
    return NextResponse.json({ error: '获取供应商失败' }, { status: 500 });
  }
}

// 创建新的 LLM 供应商
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-providers:create',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const apiBase = typeof body.apiBase === 'string' ? body.apiBase.trim() : '';
    const { isAnthropic, sortOrder } = body;

    if (!name || !apiKey || !apiBase) {
      return NextResponse.json(
        { error: '缺少必要字段: name, apiKey, apiBase' },
        { status: 400 }
      );
    }

    // 校验 apiBase：格式合法 + 私网过滤（防 SSRF，服务端每次请求都会打这个地址）
    // 复用 Cloudreve 的 validateCloudreveBaseUrl（http/https + 私网黑名单），返回规范化后的 URL
    let normalizedApiBase: string;
    try {
      normalizedApiBase = validateCloudreveBaseUrl(apiBase);
    } catch {
      return NextResponse.json(
        { error: 'apiBase 必须是合法的 http(s) 地址，且不能指向内网/本地地址' },
        { status: 400 }
      );
    }

    // 创建供应商，同时创建其模型（如果提供了 models 数组）
    const incomingModels = Array.isArray(body.models)
      ? (body.models as Array<Record<string, unknown>>)
      : [];

    const modelsData: Array<{
      modelId: string;
      displayName: string;
      thinkingDepth: string;
      thinkingMode: 'NONE' | 'AUTO' | 'FORCED' | 'DEPTH';
      supportsThinkingDepth: boolean;
      supportsImage: boolean;
      maxTokens: number;
      contextWindow: number;
      temperature: number;
      purpose: 'CHAT' | 'REALTIME_SUMMARY' | 'FINAL_SUMMARY' | 'KEYWORD_EXTRACTION' | 'EMBEDDING';
      isDefault: boolean;
      sortOrder: number;
    }> = [];

    for (const [idx, m] of incomingModels.entries()) {
      const maxTokens = Number(m.maxTokens ?? m.max_tokens ?? 4096);
      const contextWindow = Number(m.contextWindow ?? m.context_window ?? 8192);
      // 校验 contextWindow >= maxTokens（否则可输入预算 <= 0，所有 chat 都会立刻 EOL）
      if (contextWindow < maxTokens) {
        return NextResponse.json(
          {
            error: `模型 ${(m.modelId ?? m.model_id ?? '') as string}: contextWindow 必须 ≥ maxTokens（上下文窗口必须大于等于单次输出 token 数）`,
          },
          { status: 400 }
        );
      }
      const thinkingMode = (m.thinkingMode ?? m.thinking_mode ?? 'NONE') as
        | 'NONE'
        | 'AUTO'
        | 'FORCED'
        | 'DEPTH';
      // supportsThinkingDepth 由 mode === 'DEPTH' 派生（一致性保护，覆盖 body 值）
      const supportsDepth = thinkingMode === 'DEPTH';
      modelsData.push({
        modelId: (m.modelId ?? m.model_id ?? '') as string,
        displayName: (m.displayName ?? m.display_name ?? '') as string,
        thinkingDepth: (m.thinkingDepth ?? m.thinking_budget ?? 'medium') as string,
        thinkingMode,
        supportsThinkingDepth: supportsDepth,
        supportsImage: Boolean(m.supportsImage ?? m.supports_image ?? false),
        maxTokens,
        contextWindow,
        temperature: Number(m.temperature ?? 0.3),
        purpose: (m.purpose ?? 'CHAT') as
          | 'CHAT'
          | 'REALTIME_SUMMARY'
          | 'FINAL_SUMMARY'
          | 'KEYWORD_EXTRACTION'
          | 'EMBEDDING',
        isDefault: Boolean(m.isDefault ?? m.is_default ?? false),
        sortOrder: Number(m.sortOrder ?? m.sort_order ?? idx),
      });
    }

    const createdProvider = await prisma.llmProvider.create({
      data: {
        name,
        apiKey: encrypt(apiKey),
        apiBase: normalizedApiBase,
        isAnthropic: isAnthropic ?? false,
        sortOrder: sortOrder ?? 0,
        ...(modelsData.length > 0 ? { models: { create: modelsData } } : {}),
      },
      include: {
        models: { orderBy: { sortOrder: 'asc' } },
      },
    });

    const defaultModelIds = pickDefaultModelIdsByPurpose(createdProvider.models);
    if (Object.keys(defaultModelIds).length > 0) {
      await normalizeDefaultModelsByPurpose(defaultModelIds);
    }

    const provider = await prisma.llmProvider.findUnique({
      where: { id: createdProvider.id },
      include: {
        models: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!provider) {
      throw new Error('创建后的供应商不存在');
    }

    logAction(req, 'admin.llm.provider.create', {
      user: admin,
      detail: `创建 LLM 供应商: ${name}`,
    });

    return NextResponse.json(
      { provider: serializeProviderForAdmin(provider) },
      { status: 201 }
    );
  } catch (err) {
    console.error('创建 LLM 供应商失败:', err);
    return NextResponse.json({ error: '创建供应商失败' }, { status: 500 });
  }
}
