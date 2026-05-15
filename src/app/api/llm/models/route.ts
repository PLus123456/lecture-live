import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listAvailableModels, parseProviders } from '@/lib/llm/gateway';
import type {
  ChatModelOption,
  ChatModelsResponse,
  ThinkingDepth,
  ThinkingMode,
  LlmPurpose,
} from '@/types/llm';
import { jsonWithCache } from '@/lib/httpCache';

/**
 * 给定模型 thinkingMode + 用户角色，算出 UI 可选的深度档位。
 * 非 DEPTH 模型返回空数组，UI 自行渲染 auto/forced。
 */
function allowedDepthsFor(
  mode: ThinkingMode,
  role: 'ADMIN' | 'PRO' | 'FREE'
): ThinkingDepth[] {
  if (mode !== 'DEPTH') return [];
  return role === 'FREE' ? ['low', 'medium'] : ['low', 'medium', 'high'];
}

/**
 * GET /api/llm/models
 *
 * 返回当前用户可用的 LLM 模型列表。
 * 优先从数据库读取，回退到环境变量配置。
 */
export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { allowedModels: true, role: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 尝试从数据库读取模型配置
  const dbModels = await listAvailableModels();
  const hasDbModels = dbModels.length > 0 && dbModels[0].dbModelId;

  if (hasDbModels) {
    // ── 数据库模式 ──
    const userAllowed = new Set(
      user.allowedModels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );

    const models: ChatModelOption[] = [];
    let defaultModel = '';

    // 按底层 modelId + displayName 去重，同一模型分配多个 purpose 时只显示一次
    // 优先使用 CHAT 用途的记录（因为对话界面使用）
    const seenModelKeys = new Map<string, number>(); // key → models 数组索引

    for (const cfg of dbModels) {
      // 非 ADMIN 用户允许按 dbModelId、provider 名称或底层 modelId 授权。
      if (
        user.role !== 'ADMIN' &&
        !user.allowedModels.includes('*') &&
        ![cfg.dbModelId, cfg.name, cfg.model].some(
          (identifier) => Boolean(identifier && userAllowed.has(identifier))
        )
      ) {
        continue;
      }

      const mode = cfg.thinkingMode;
      const allowedDepths = allowedDepthsFor(mode, user.role);

      const buildOption = (purpose: LlmPurpose): ChatModelOption => ({
        name: cfg.dbModelId!,
        id: cfg.dbModelId!,
        modelId: cfg.model,
        displayName: cfg.displayName || cfg.model,
        supportsThinking: mode !== 'NONE',
        thinkingMode: mode,
        supportsThinkingDepth: mode === 'DEPTH',
        supportsImage: cfg.supportsImage,
        allowedDepths,
        purpose,
      });

      // 去重：同一底层模型（modelId + displayName）只保留一条，优先用 CHAT 用途的记录
      const dedupeKey = `${cfg.model}::${cfg.displayName || cfg.model}`;
      const existingIdx = seenModelKeys.get(dedupeKey);

      if (existingIdx !== undefined) {
        if (cfg.purpose === 'CHAT') {
          models[existingIdx] = buildOption('CHAT');
        }
        continue;
      }

      const idx = models.length;
      seenModelKeys.set(dedupeKey, idx);
      models.push(buildOption((cfg.purpose ?? 'CHAT') as LlmPurpose));

      // 该用途下 isDefault 的模型作为 defaultModel
      if (cfg.purpose === 'CHAT' && !defaultModel) {
        defaultModel = cfg.dbModelId!;
      }
    }

    if (!defaultModel && models.length > 0) {
      defaultModel = models[0].name;
    }

    const response: ChatModelsResponse = { models, defaultModel };
    return jsonWithCache(req, response, {
      cacheControl: 'private, no-cache, must-revalidate',
      vary: ['Authorization', 'Cookie'],
    });
  }

  // ── 环境变量 fallback ──
  const configuredProviders = parseProviders();
  const configuredNames = new Set(Object.keys(configuredProviders));

  const userAllowed = new Set(
    user.allowedModels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const effectiveAllowedArr =
    user.role === 'ADMIN'
      ? Array.from(configuredNames)
      : Array.from(userAllowed).filter((n) => configuredNames.has(n));

  const models: ChatModelOption[] = [];
  for (const name of effectiveAllowedArr) {
    const provider = configuredProviders[name];
    if (!provider) continue;

    const mode = provider.thinkingMode;
    models.push({
      name,
      id: name,
      modelId: provider.model,
      displayName: provider.displayName || name,
      supportsThinking: mode !== 'NONE',
      thinkingMode: mode,
      supportsThinkingDepth: mode === 'DEPTH',
      supportsImage: provider.supportsImage,
      allowedDepths: allowedDepthsFor(mode, user.role),
      purpose: 'CHAT',
    });
  }

  const activeName = process.env.LLM_ACTIVE_PROVIDER || '';
  const defaultModel = effectiveAllowedArr.includes(activeName)
    ? activeName
    : models[0]?.name || '';

  const response: ChatModelsResponse = { models, defaultModel };
  return jsonWithCache(req, response, {
    cacheControl: 'private, no-cache, must-revalidate',
    vary: ['Authorization', 'Cookie'],
  });
}
