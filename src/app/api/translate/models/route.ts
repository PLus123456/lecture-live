import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  listAvailableModels,
  getModelById,
  getProviderForPurpose,
} from '@/lib/llm/gateway';
import { jsonWithCache } from '@/lib/httpCache';
import {
  resolveUserFeatureFlags,
  resolveUserTranslationModelId,
} from '@/lib/userRoles';
import { getSiteSettings } from '@/lib/siteSettings';

export interface TranslationModelOption {
  /** LlmModel DB id（请求时回传给 /api/translate/text 的 modelId） */
  id: string;
  displayName: string;
  /** 底层模型标识（展示用） */
  modelId: string;
}

/**
 * GET /api/translate/models — 翻译页初始化上下文：
 * 可选模型列表（TRANSLATION 用途路由 ∩ allowedModels）+ 默认模型（组绑定 > 全局默认）+
 * 站点/组配置（开关、计费模式、限额），前端一次拿全。
 */
export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { allowedModels: true, role: true, customGroupId: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const [settings, featureFlags] = await Promise.all([
    getSiteSettings(),
    resolveUserFeatureFlags(user),
  ]);

  const userAllowed = new Set(
    user.allowedModels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const allowAll = user.role === 'ADMIN' || user.allowedModels.includes('*');

  const dbModels = await listAvailableModels();
  const models: TranslationModelOption[] = [];
  const seen = new Set<string>();
  for (const cfg of dbModels) {
    if (cfg.purpose !== 'TRANSLATION' || !cfg.dbModelId) continue;
    if (
      !allowAll &&
      ![cfg.dbModelId, cfg.name, cfg.model].some(
        (identifier) => Boolean(identifier && userAllowed.has(identifier))
      )
    ) {
      continue;
    }
    const key = `${cfg.model}::${cfg.displayName || cfg.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({
      id: cfg.dbModelId,
      displayName: cfg.displayName || cfg.model,
      modelId: cfg.model,
    });
  }

  // 默认模型：组绑定（管理员决策，可越过 allowedModels，必要时补进列表）> 全局 TRANSLATION 默认 > 列表首项
  let defaultModel = '';
  const groupModelId = await resolveUserTranslationModelId(user).catch(() => null);
  if (groupModelId) {
    const cfg = await getModelById(groupModelId).catch(() => null);
    if (cfg && cfg.dbModelId === groupModelId && cfg.purpose === 'TRANSLATION') {
      if (!models.some((m) => m.id === groupModelId)) {
        models.unshift({
          id: groupModelId,
          displayName: cfg.displayName || cfg.model,
          modelId: cfg.model,
        });
      }
      defaultModel = groupModelId;
    }
  }
  if (!defaultModel) {
    const globalDefault = await getProviderForPurpose('TRANSLATION').catch(() => null);
    if (globalDefault?.dbModelId && models.some((m) => m.id === globalDefault.dbModelId)) {
      defaultModel = globalDefault.dbModelId;
    }
  }
  if (!defaultModel && models.length > 0) {
    defaultModel = models[0].id;
  }

  return jsonWithCache(
    req,
    {
      models,
      defaultModel,
      config: {
        textEnabled: settings.translation_text_enabled && featureFlags.allowTextTranslation,
        docEnabled: settings.translation_doc_enabled && featureFlags.allowDocTranslation,
        textBillingMode: settings.translation_text_billing_mode,
        textDailyFreeLimit: settings.translation_text_daily_free_limit,
        textPriceCentsPerKchar: settings.translation_text_price_cents_per_kchar,
        docPriceCentsPerPage: settings.translation_doc_price_cents_per_page,
        docMaxPages: settings.translation_doc_max_pages,
        docMaxMb: settings.translation_doc_max_mb,
      },
    },
    {
      cacheControl: 'private, no-cache, must-revalidate',
      vary: ['Authorization', 'Cookie'],
    }
  );
}
