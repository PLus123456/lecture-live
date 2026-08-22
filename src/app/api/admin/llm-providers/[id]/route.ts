import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt } from '@/lib/crypto';
import {
  normalizeDefaultModelsByPurpose,
  pickDefaultModelIdsByPurpose,
} from '@/lib/llm/defaults';
import { serializeProviderForAdmin } from '@/lib/llm/providerAdmin';
import {
  hasFreshSecret,
  isEndpointRetargeted,
  requiresSecretReentry,
  retargetErrorMessage,
} from '@/lib/credentialRetarget';
import {
  describeLlmEndpointForAudit,
  validateLlmProviderBaseUrl,
} from '@/lib/llm/outboundPolicy';
import { requireLlmAdminCurrentPassword } from '@/lib/llm/adminReauth';
import { writeLlmSecurityAudit } from '@/lib/llm/securityAudit';
import { writeSecurityAudit } from '@/lib/securityAudit';

type LockedProviderBinding = {
  id: string;
  name: string;
  apiKey: string;
  apiBase: string;
  isAnthropic: boolean;
  updatedAt: Date;
};

class ConcurrentProviderBindingError extends Error {
  constructor(
    readonly reason:
      | 'fresh_api_key_required_after_concurrent_change'
      | 'reauth_required_after_concurrent_change'
      | 'provider_binding_changed_since_preflight'
      | 'provider_version_changed',
    readonly providerId: string,
    readonly endpoint: string,
    readonly endpointChanged: boolean,
    readonly protocolChanged: boolean
  ) {
    super(reason);
    this.name = 'ConcurrentProviderBindingError';
  }
}

function endpointQueryChanged(current: unknown, next: unknown): boolean | null {
  try {
    return new URL(String(current ?? '')).search !== new URL(String(next ?? '')).search;
  } catch {
    return null;
  }
}

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
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
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
    let normalizedApiBase: string | undefined;
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: '供应商名称不能为空' }, { status: 400 });
      }
      updateData.name = name;
    }
    if (hasFreshSecret(body.apiKey)) {
      const apiKey = body.apiKey.trim();
      updateData.apiKey = encrypt(apiKey);
    }
    if (typeof body.apiBase === 'string') {
      const apiBase = body.apiBase.trim();
      if (!apiBase) {
        return NextResponse.json({ error: 'API Base 不能为空' }, { status: 400 });
      }
      try {
        normalizedApiBase = await validateLlmProviderBaseUrl(apiBase);
        updateData.apiBase = normalizedApiBase;
      } catch {
        await writeLlmSecurityAudit(req, 'llm-provider.update-rejected', {
          user: admin,
          detail: {
            providerId: id,
            reason: 'outbound_origin_policy',
            endpoint: describeLlmEndpointForAudit(apiBase),
          },
        });
        return NextResponse.json(
          { error: 'apiBase 必须是已加入服务端允许列表的安全 http(s) origin' },
          { status: 400 }
        );
      }
    }

    if (body.isAnthropic !== undefined && typeof body.isAnthropic !== 'boolean') {
      return NextResponse.json({ error: 'isAnthropic 必须是布尔值' }, { status: 400 });
    }

    const endpointRetargeted = isEndpointRetargeted([
      { current: existing.apiBase, next: normalizedApiBase },
    ]);
    const protocolRetargeted =
      body.isAnthropic !== undefined && body.isAnthropic !== existing.isAnthropic;
    const credentialRetargeted = endpointRetargeted || protocolRetargeted;

    // SEC-034：已保存的 API key 必须与端点/协议重新绑定。否则管理员只改 apiBase、把
    // apiKey 留空（沿用旧值），后续 gateway 会把无法从后台读出的真实密钥主动发给新主机。
    // 比较完整 apiBase（而不只是 origin），因为共享网关常用 path 区分租户；尾斜杠等价由
    // credentialRetarget 的统一归一逻辑处理。Anthropic 协议模式变化也要求重新绑定凭据。
    if (
      requiresSecretReentry({
        endpoint: [
          // 必须比较最终落库值而非 raw body。URL validator 会规范化 pathname/query；若两套
          // 归一口径不同，攻击者可构造 raw 等价、stored 不等价的地址绕过换靶闸。
          { current: existing.apiBase, next: normalizedApiBase },
          { current: existing.isAnthropic, next: body.isAnthropic },
        ],
        hasStoredSecret: Boolean(existing.apiKey),
        suppliedSecret: body.apiKey,
      })
    ) {
      await writeLlmSecurityAudit(req, 'llm-provider.update-rejected', {
        user: admin,
        detail: {
          providerId: id,
          reason: 'fresh_api_key_required',
          endpoint: describeLlmEndpointForAudit(normalizedApiBase ?? existing.apiBase),
          endpointChanged: endpointRetargeted,
          protocolChanged: protocolRetargeted,
        },
      });
      return NextResponse.json(
        {
          error: retargetErrorMessage(
            'LLM API 地址或协议',
            'API Key'
          ),
        },
        { status: 400 }
      );
    }

    // A stolen ADMIN cookie must not be enough to bind a stored credential to a
    // different network/protocol target. Ordinary rename/sort/model edits and a
    // canonically unchanged endpoint intentionally do not invoke this bcrypt gate.
    let recentReauthCompleted = false;
    if (credentialRetargeted) {
      const reauth = await requireLlmAdminCurrentPassword(
        req,
        admin.id,
        body.currentPassword
      );
      if (!reauth.ok) {
        await writeLlmSecurityAudit(req, 'llm-provider.update-rejected', {
          user: admin,
          detail: {
            providerId: id,
            reason: `reauth_${reauth.reason}`,
            endpoint: describeLlmEndpointForAudit(
              normalizedApiBase ?? existing.apiBase
            ),
            endpointChanged: endpointRetargeted,
            protocolChanged: protocolRetargeted,
          },
        });
        return reauth.response;
      }
      recentReauthCompleted = true;
    }

    if (body.isAnthropic !== undefined) updateData.isAnthropic = body.isAnthropic;
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

    const incomingModels = Array.isArray(body.models)
      ? (body.models as Array<Record<string, unknown>>)
      : null;
    const incomingIds = new Set(
      (incomingModels ?? [])
        .map((model) => model.id as string)
        .filter((modelId) => modelId && !modelId.startsWith('temp-'))
    );
    const preparedModels: Array<{
      mid: string;
      data: Prisma.LlmModelUncheckedCreateWithoutProviderInput;
    }> = [];
    for (const model of incomingModels ?? []) {
      const maxTokens = Number(model.maxTokens ?? model.max_tokens ?? 4096);
      const contextWindow = Number(model.contextWindow ?? model.context_window ?? 8192);
      if (contextWindow < maxTokens) {
        return NextResponse.json(
          {
            error: `模型 ${(model.modelId ?? model.model_id ?? '') as string}: contextWindow 必须 ≥ maxTokens（上下文窗口必须大于等于单次输出 token 数）`,
          },
          { status: 400 }
        );
      }
      const thinkingMode = (model.thinkingMode ?? model.thinking_mode ?? 'NONE') as
        | 'NONE'
        | 'AUTO'
        | 'FORCED'
        | 'DEPTH';
      preparedModels.push({
        mid: model.id as string,
        data: {
          modelId: (model.modelId ?? model.model_id ?? '') as string,
          displayName: (model.displayName ?? model.display_name ?? '') as string,
          thinkingDepth: (model.thinkingDepth ?? model.thinking_budget ?? 'medium') as string,
          thinkingMode,
          supportsThinkingDepth: thinkingMode === 'DEPTH',
          supportsImage: Boolean(model.supportsImage ?? model.supports_image ?? false),
          maxTokens,
          contextWindow,
          temperature: Number(model.temperature ?? 0.3),
          purpose: (model.purpose ?? 'CHAT') as Prisma.LlmModelUncheckedCreateWithoutProviderInput['purpose'],
          isDefault: Boolean(model.isDefault ?? model.is_default ?? false),
          sortOrder: Number(model.sortOrder ?? model.sort_order ?? 0),
        },
      });
    }

    const provider = await prisma.$transaction(async (tx) => {
      // SEC-034: the binding row is the serialization point. It must be the first database read in
      // this transaction; all secret-reentry and reauth decisions below are recomputed from this
      // current-read value, not the stale preliminary read used for cheap validation.
      const lockedRows = await tx.$queryRaw<LockedProviderBinding[]>`
        SELECT id, name, apiKey, apiBase, isAnthropic, updatedAt
        FROM LlmProvider
        WHERE id = ${id}
        FOR UPDATE
      `;
      const locked = lockedRows[0];
      if (!locked) throw new Error('PROVIDER_NOT_FOUND');

      // A partial binding patch (for example apiKey-only) was prepared against `existing` above.
      // If another writer changed endpoint/protocol/key before this row lock, applying that patch to
      // the new binding can send a credential to a target the administrator never reviewed. Refuse
      // every sensitive binding write and make the client refresh; ordinary name/model edits may
      // still merge because they cannot retarget a credential.
      const bindingChangedSincePreflight =
        locked.apiBase !== existing.apiBase ||
        locked.isAnthropic !== existing.isAnthropic ||
        locked.apiKey !== existing.apiKey;
      const touchesCredentialBinding =
        normalizedApiBase !== undefined ||
        body.isAnthropic !== undefined ||
        hasFreshSecret(body.apiKey);
      if (bindingChangedSincePreflight && touchesCredentialBinding) {
        throw new ConcurrentProviderBindingError(
          'provider_binding_changed_since_preflight',
          id,
          normalizedApiBase ?? locked.apiBase,
          locked.apiBase !== existing.apiBase,
          locked.isAnthropic !== existing.isAnthropic
        );
      }

      const lockedEndpointChanged = isEndpointRetargeted([
        { current: locked.apiBase, next: normalizedApiBase },
      ]);
      const lockedProtocolChanged =
        body.isAnthropic !== undefined && body.isAnthropic !== locked.isAnthropic;
      const lockedCredentialRetargeted =
        lockedEndpointChanged || lockedProtocolChanged;

      if (
        requiresSecretReentry({
          endpoint: [
            { current: locked.apiBase, next: normalizedApiBase },
            { current: locked.isAnthropic, next: body.isAnthropic },
          ],
          hasStoredSecret: Boolean(locked.apiKey),
          suppliedSecret: body.apiKey,
        })
      ) {
        throw new ConcurrentProviderBindingError(
          'fresh_api_key_required_after_concurrent_change',
          id,
          normalizedApiBase ?? locked.apiBase,
          lockedEndpointChanged,
          lockedProtocolChanged
        );
      }
      if (lockedCredentialRetargeted && !recentReauthCompleted) {
        throw new ConcurrentProviderBindingError(
          'reauth_required_after_concurrent_change',
          id,
          normalizedApiBase ?? locked.apiBase,
          lockedEndpointChanged,
          lockedProtocolChanged
        );
      }

      if (incomingModels) {
        const currentModels = await tx.llmModel.findMany({ where: { providerId: id } });
        const toDelete = currentModels.filter((model) => !incomingIds.has(model.id));
        if (toDelete.length > 0) {
          await tx.llmModel.deleteMany({
            where: { id: { in: toDelete.map((model) => model.id) } },
          });
        }
        for (const { mid, data } of preparedModels) {
          if (mid && !mid.startsWith('temp-')) {
            await tx.llmModel.update({ where: { id: mid }, data });
          } else {
            await tx.llmModel.create({ data: { ...data, providerId: id } });
          }
        }
      }

      // Version CAS makes the commit predicate explicit even though FOR UPDATE already serializes
      // writers. No endpoint/key derived from a different version can be committed.
      const versioned = await tx.llmProvider.updateMany({
        where: { id, updatedAt: locked.updatedAt },
        data: {
          ...(updateData as Prisma.LlmProviderUpdateManyMutationInput),
          updatedAt: new Date(),
        },
      });
      if (versioned.count !== 1) {
        throw new ConcurrentProviderBindingError(
          'provider_version_changed',
          id,
          normalizedApiBase ?? locked.apiBase,
          lockedEndpointChanged,
          lockedProtocolChanged
        );
      }

      let updated = await tx.llmProvider.findUnique({
        where: { id },
        include: { models: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!updated) throw new Error('PROVIDER_NOT_FOUND');

      const defaultModelIds = pickDefaultModelIdsByPurpose(updated.models);
      if (Object.keys(defaultModelIds).length > 0) {
        await normalizeDefaultModelsByPurpose(defaultModelIds, tx);
        updated = await tx.llmProvider.findUnique({
          where: { id },
          include: { models: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!updated) throw new Error('PROVIDER_NOT_FOUND');
      }

      await writeSecurityAudit(
        req,
        {
          event: 'llm-provider.update',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'llm-provider', id },
          before: {
            name: locked.name,
            endpoint: describeLlmEndpointForAudit(locked.apiBase),
            protocol: locked.isAnthropic ? 'anthropic' : 'openai-compatible',
          },
          after: {
            name: updated.name,
            endpoint: describeLlmEndpointForAudit(updated.apiBase),
            protocol: updated.isAnthropic ? 'anthropic' : 'openai-compatible',
            apiKey: { rotated: hasFreshSecret(body.apiKey) },
          },
          reason: 'admin_llm_provider_update',
          outcome: 'SUCCESS',
          metadata: {
            endpointChanged: lockedEndpointChanged,
            protocolChanged: lockedProtocolChanged,
            queryChanged: endpointQueryChanged(locked.apiBase, updated.apiBase),
            modelCount: updated.models.length,
          },
        },
        tx
      );

      return updated;
    });

    return NextResponse.json({ provider: serializeProviderForAdmin(provider) });
  } catch (err) {
    if (err instanceof ConcurrentProviderBindingError) {
      try {
        await writeLlmSecurityAudit(req, 'llm-provider.update-rejected', {
          user: admin,
          detail: {
            providerId: err.providerId,
            reason: err.reason,
            endpoint: describeLlmEndpointForAudit(err.endpoint),
            endpointChanged: err.endpointChanged,
            protocolChanged: err.protocolChanged,
          },
        });
      } catch {
        return NextResponse.json({ error: '安全审计写入失败' }, { status: 500 });
      }
      return NextResponse.json(
        {
          error:
            err.reason === 'fresh_api_key_required_after_concurrent_change'
              ? retargetErrorMessage('并发变更后的 LLM API 地址或协议', 'API Key')
              : '供应商配置已被并发修改，请刷新后重新验证管理员密码并重试',
          code: 'PROVIDER_BINDING_CHANGED',
        },
        { status: 409 }
      );
    }
    if (err instanceof Error && err.message === 'PROVIDER_NOT_FOUND') {
      return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
    }
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
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const { id } = await params;

    const deleted = await prisma.$transaction(async (tx) => {
      const existing = await tx.llmProvider.findUnique({
        where: { id },
        include: { _count: { select: { models: true } } },
      });
      if (!existing) return false;

      await tx.llmProvider.delete({ where: { id } });
      await writeSecurityAudit(
        req,
        {
          event: 'llm-provider.delete',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'llm-provider', id },
          before: {
            name: existing.name,
            endpoint: describeLlmEndpointForAudit(existing.apiBase),
            protocol: existing.isAnthropic ? 'anthropic' : 'openai-compatible',
            modelCount: existing._count.models,
          },
          after: null,
          reason: 'admin_llm_provider_delete',
          outcome: 'SUCCESS',
        },
        tx
      );
      return true;
    });
    if (!deleted) {
      return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
    }

    return NextResponse.json({ message: '供应商已删除' });
  } catch (err) {
    console.error('删除 LLM 供应商失败:', err);
    return NextResponse.json({ error: '删除供应商失败' }, { status: 500 });
  }
}
