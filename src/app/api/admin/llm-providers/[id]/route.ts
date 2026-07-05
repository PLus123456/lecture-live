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

// 更新 LLM 供应商
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-providers:update',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id } = await params;
    const body = await req.json();

    // 检查供应商是否存在
    const existing = await prisma.llmProvider.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
    }

    // 只更新提供的字段
    const updateData: Record<string, unknown> = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: '供应商名称不能为空' }, { status: 400 });
      }
      updateData.name = name;
    }
    if (typeof body.apiKey === 'string') {
      const apiKey = body.apiKey.trim();
      if (apiKey) {
        updateData.apiKey = encrypt(apiKey);
      }
    }
    if (typeof body.apiBase === 'string') {
      const apiBase = body.apiBase.trim();
      if (!apiBase) {
        return NextResponse.json({ error: 'API Base 不能为空' }, { status: 400 });
      }
      // 安全：与创建路径(POST)一致，校验 http(s) + 私网黑名单防 SSRF。
      // 否则可先用合法公网地址建 provider 过校验，再 PATCH 改成 169.254.169.254
      // (云元数据)/内网地址，使服务端每次 LLM 调用都向内网发起携带 apiKey 的 fetch。
      try {
        updateData.apiBase = validateCloudreveBaseUrl(apiBase);
      } catch {
        return NextResponse.json(
          { error: 'apiBase 必须是合法的 http(s) 地址，且不能指向内网/本地地址' },
          { status: 400 }
        );
      }
    }
    if (body.isAnthropic !== undefined) updateData.isAnthropic = body.isAnthropic;
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

    // 如果包含 models 数组，进行批量同步
    if (Array.isArray(body.models)) {
      const incomingModels = body.models as Array<Record<string, unknown>>;
      const existingModels = await prisma.llmModel.findMany({ where: { providerId: id } });
      const incomingIds = new Set(
        incomingModels
          .map((m) => m.id as string)
          .filter((mid) => mid && !mid.startsWith('temp-'))
      );

      // U13：先对整批做一次性预校验并规整数据，再在单事务内 delete+update+create。
      // 否则 deleteMany 先执行、循环中途某模型 contextWindow<maxTokens 返回 400 时，
      // 已删/已改的模型无法回滚，留下半同步状态（被删的默认模型永久消失）。
      const preparedModels: Array<{
        mid: string;
        data: {
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
        };
      }> = [];
      for (const m of incomingModels) {
        const maxTokens = Number(m.maxTokens ?? m.max_tokens ?? 4096);
        const contextWindow = Number(m.contextWindow ?? m.context_window ?? 8192);
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
        preparedModels.push({
          mid: m.id as string,
          data: {
            modelId: (m.modelId ?? m.model_id ?? '') as string,
            displayName: (m.displayName ?? m.display_name ?? '') as string,
            thinkingDepth: (m.thinkingDepth ?? m.thinking_budget ?? 'medium') as string,
            thinkingMode,
            supportsThinkingDepth: supportsDepth,
            supportsImage: Boolean(m.supportsImage ?? m.supports_image ?? false),
            maxTokens,
            contextWindow,
            temperature: Number(m.temperature ?? 0.3),
            purpose: (m.purpose ?? 'CHAT') as 'CHAT' | 'REALTIME_SUMMARY' | 'FINAL_SUMMARY' | 'KEYWORD_EXTRACTION' | 'EMBEDDING',
            isDefault: Boolean(m.isDefault ?? m.is_default ?? false),
            sortOrder: Number(m.sortOrder ?? m.sort_order ?? 0),
          },
        });
      }

      // 删除前端已移除的模型
      const toDelete = existingModels.filter((m) => !incomingIds.has(m.id));

      // 原子提交：删除 + 更新/创建全部包进单事务，任一失败整体回滚
      await prisma.$transaction(async (tx) => {
        if (toDelete.length > 0) {
          await tx.llmModel.deleteMany({
            where: { id: { in: toDelete.map((m) => m.id) } },
          });
        }
        for (const { mid, data } of preparedModels) {
          if (mid && !mid.startsWith('temp-')) {
            await tx.llmModel.update({ where: { id: mid }, data });
          } else {
            await tx.llmModel.create({ data: { ...data, providerId: id } });
          }
        }
      });
    }

    let provider = await prisma.llmProvider.update({
      where: { id },
      data: updateData,
      include: {
        models: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    const defaultModelIds = pickDefaultModelIdsByPurpose(provider.models);
    if (Object.keys(defaultModelIds).length > 0) {
      await normalizeDefaultModelsByPurpose(defaultModelIds);

      const refreshedProvider = await prisma.llmProvider.findUnique({
        where: { id },
        include: {
          models: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      });

      if (!refreshedProvider) {
        throw new Error('更新后的供应商不存在');
      }

      provider = refreshedProvider;
    }

    logAction(req, 'admin.llm.provider.update', {
      user: admin,
      detail: `更新 LLM 供应商: ${provider.name}`,
    });

    return NextResponse.json({ provider: serializeProviderForAdmin(provider) });
  } catch (err) {
    console.error('更新 LLM 供应商失败:', err);
    return NextResponse.json({ error: '更新供应商失败' }, { status: 500 });
  }
}

// 删除 LLM 供应商（级联删除其下所有模型）
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-providers:delete',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id } = await params;

    // 检查供应商是否存在
    const existing = await prisma.llmProvider.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
    }

    // 删除供应商（Prisma schema 中设置了 onDelete: Cascade，模型会自动删除）
    await prisma.llmProvider.delete({ where: { id } });

    logAction(req, 'admin.llm.provider.delete', {
      user: admin,
      detail: `删除 LLM 供应商: ${existing.name}`,
    });

    return NextResponse.json({ message: '供应商已删除' });
  } catch (err) {
    console.error('删除 LLM 供应商失败:', err);
    return NextResponse.json({ error: '删除供应商失败' }, { status: 500 });
  }
}
