import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt } from '@/lib/crypto';
import {
  normalizeDefaultModelsByPurpose,
  pickDefaultModelIdsByPurpose,
} from '@/lib/llm/defaults';
import { serializeProviderForAdmin } from '@/lib/llm/providerAdmin';
import { ensureLlmRegistry } from '@/lib/llm/registry';
import {
  describeLlmEndpointForAudit,
  validateLlmProviderBaseUrl,
} from '@/lib/llm/outboundPolicy';
import { requireLlmAdminCurrentPassword } from '@/lib/llm/adminReauth';
import { writeLlmSecurityAudit } from '@/lib/llm/securityAudit';
import { writeSecurityAudit } from '@/lib/securityAudit';

// 获取所有 LLM 供应商及其模型（模型库条目 + 用途路由行）
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-providers:list',
    limit: 60,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    // 惰性迁移：把历史「无 registry」的路由行归并出模型库条目（幂等，无待迁移行时只花一次 count）
    await ensureLlmRegistry({
      onMigrated: async (tx, migration) => {
        await writeSecurityAudit(
          req,
          {
            event: 'llm-registry.migrate',
            operator: { id: admin.id, email: admin.email, role: admin.role },
            target: {
              type: 'llm_registry_model',
              id: migration.registryId,
              ids: migration.routeIds,
            },
            before: { linked: false },
            after: {
              linked: true,
              createdRegistry: migration.createdRegistry,
              routeCount: migration.routeIds.length,
            },
            reason: 'legacy_registry_backfill',
            outcome: 'SUCCESS',
          },
          tx
        );
      },
    });

    const providers = await prisma.llmProvider.findMany({
      include: {
        models: {
          orderBy: { sortOrder: 'asc' },
        },
        registryModels: {
          orderBy: { sortOrder: 'asc' },
          include: {
            routes: {
              select: { id: true, purpose: true, isDefault: true },
            },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    await writeSecurityAudit(req, {
      event: 'llm-providers.read',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: {
        type: 'llm_provider_collection',
        ids: providers.map((provider) => provider.id),
      },
      after: {
        providerCount: providers.length,
        modelCount: providers.reduce(
          (total, provider) => total + provider.models.length,
          0
        ),
        registryCount: providers.reduce(
          (total, provider) => total + provider.registryModels.length,
          0
        ),
      },
      reason: 'admin_list',
      outcome: 'SUCCESS',
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
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
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

    // SEC-034：LLM 使用独立、精确 origin allowlist；不得继承 Cloudreve 的私网豁免。
    let normalizedApiBase: string;
    try {
      normalizedApiBase = await validateLlmProviderBaseUrl(apiBase);
    } catch {
      await writeLlmSecurityAudit(req, 'llm-provider.create-rejected', {
        user: admin,
        detail: {
          reason: 'outbound_origin_policy',
          endpoint: describeLlmEndpointForAudit(apiBase),
        },
      });
      return NextResponse.json(
        { error: 'apiBase 必须是已加入服务端允许列表的安全 http(s) origin' },
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

    // 创建 provider 会立即把一份新凭据绑定到可出站的主机；即使已有 ADMIN
    // cookie，也必须在本次高风险写入中证明当前密码，阻断被盗会话持久化恶意端点。
    const reauth = await requireLlmAdminCurrentPassword(
      req,
      admin.id,
      body.currentPassword
    );
    if (!reauth.ok) {
      await writeLlmSecurityAudit(req, 'llm-provider.create-rejected', {
        user: admin,
        detail: {
          reason: `reauth_${reauth.reason}`,
          endpoint: describeLlmEndpointForAudit(normalizedApiBase),
        },
      });
      return reauth.response;
    }

    const provider = await prisma.$transaction(async (tx) => {
      const createdProvider = await tx.llmProvider.create({
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
        await normalizeDefaultModelsByPurpose(defaultModelIds, tx);
      }

      const fullProvider = await tx.llmProvider.findUnique({
        where: { id: createdProvider.id },
        include: {
          models: { orderBy: { sortOrder: 'asc' } },
        },
      });
      if (!fullProvider) {
        throw new Error('创建后的供应商不存在');
      }

      await writeSecurityAudit(
        req,
        {
          event: 'llm-providers.create',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'llm_provider', id: fullProvider.id },
          after: {
            id: fullProvider.id,
            name: fullProvider.name,
            endpoint: describeLlmEndpointForAudit(fullProvider.apiBase),
            isAnthropic: fullProvider.isAnthropic,
            hasApiKey: Boolean(fullProvider.apiKey),
            modelCount: fullProvider.models.length,
          },
          reason: 'admin_create',
          outcome: 'SUCCESS',
          metadata: { normalizedDefaultPurposes: Object.keys(defaultModelIds) },
        },
        tx
      );
      return fullProvider;
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
