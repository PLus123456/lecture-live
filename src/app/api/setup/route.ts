// src/app/api/setup/route.ts
// 初始部署设置向导 API — 检查状态 & 完成各步骤配置

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { getNextQuotaResetAt } from '@/lib/billing';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';
// P6-4：与 admin/soniox/route.ts 共用同一份实现，避免「同一防护只装在一条路径上」重演。
import {
  validateSonioxRestUrl,
  validateSonioxWsUrl,
} from '@/lib/sonioxUrlValidation';
import bcrypt from 'bcryptjs';

// 「首个管理员已被认领」的 CAS 键。SiteSetting.key 上有唯一索引，create 抢锁天然原子；
// MySQL 表达不了「role=ADMIN 只能一行」，findFirst + create 之间的空档足够并发造出
// 第二个隐藏管理员（还会被 setAuthCookie 直接登录）。
const ADMIN_CLAIM_KEY = 'setup_admin_claimed';

/** 事务内「已有管理员」的哨兵：与 P2002（唯一键冲突）区分开，好给出准确的错误文案。 */
class AdminAlreadyExistsError extends Error {}

interface SetupStatusPayload {
  setupComplete: boolean;
  steps: {
    database: boolean;
    admin: boolean;
    llm: boolean;
    soniox: boolean;
  };
  error?: string;
}

function isMissingTableError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2021'
  );
}

function getSetupErrorMessage(error: unknown): string {
  if (isMissingTableError(error)) {
    return '数据库已连接，但应用数据表尚未初始化。请先执行 Prisma schema 同步。';
  }

  if (
    error instanceof Error &&
    /(JWT_SECRET|ENCRYPTION_KEY)/.test(error.message)
  ) {
    return '服务器缺少必要的安全密钥配置，请检查 JWT_SECRET 和 ENCRYPTION_KEY。';
  }

  return '设置步骤执行失败，请检查服务器日志。';
}

function hasSonioxEnvConfig(): boolean {
  return !!(
    process.env.SONIOX_API_KEY ||
    process.env.SONIOX_US_API_KEY ||
    process.env.SONIOX_EU_API_KEY ||
    process.env.SONIOX_JP_API_KEY
  );
}

async function getSetupStatus(): Promise<SetupStatusPayload> {
  let dbConnected = false;
  let schemaReady = true;
  let hasAdmin = false;
  let hasLlmProvider = false;
  let hasSoniox = hasSonioxEnvConfig();
  let setupComplete = false;
  let errorMessage: string | undefined;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch {
    return {
      setupComplete: false,
      steps: {
        database: false,
        admin: false,
        llm: false,
        soniox: hasSoniox,
      },
      error: '数据库连接失败，请检查 DATABASE_URL 和数据库服务状态。',
    };
  }

  try {
    const [adminCount, providerCount, sonioxSetting] = await Promise.all([
      prisma.user.count({
        where: { role: 'ADMIN' },
      }),
      prisma.llmProvider.count(),
      prisma.siteSetting.findUnique({
        where: { key: 'soniox_configured' },
      }),
    ]);

    hasAdmin = adminCount > 0;
    hasLlmProvider = providerCount > 0;
    hasSoniox = hasSoniox || sonioxSetting?.value === 'true';
  } catch (error) {
    if (isMissingTableError(error)) {
      schemaReady = false;
      errorMessage = '数据库已连接，但应用数据表尚未初始化。请先执行 Prisma schema 同步。';
    } else {
      throw error;
    }
  }

  if (schemaReady) {
    setupComplete = await isSetupComplete();

    // 自动检测：如果所有步骤（数据库 + admin + LLM + Soniox）已就绪但未标记完成，
    // 说明是已有部署升级后首次访问，自动标记为完成
    if (!setupComplete && dbConnected && hasAdmin && hasLlmProvider && hasSoniox) {
      await prisma.siteSetting.upsert({
        where: { key: 'setup_complete' },
        update: { value: 'true' },
        create: { key: 'setup_complete', value: 'true' },
      });
      setupComplete = true;
    }
  }

  return {
    setupComplete,
    steps: {
      database: dbConnected && schemaReady,
      admin: hasAdmin,
      llm: hasLlmProvider,
      soniox: hasSoniox,
    },
    error: errorMessage,
  };
}

/** 恒定时间比较（长度不同直接判否，避免长度侧信道之外的逐字节短路）。 */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * C02/P6-4：给公开的引导路由加门禁。中间件整条放行 `/api/setup`，此前唯一的门是
 * `setup_complete` 布尔 + 10 次/10 分钟限流，而完整接管只需要 3-4 个请求。
 *
 * 两条互补的通行证，任一成立即放行：
 *  1. `x-setup-token` 匹配 `SETUP_BOOTSTRAP_TOKEN`（若配了该环境变量）。这是运维显式
 *     关掉「首次部署匿名窗口」的开关：一旦配上，匿名者连 step=admin 都进不来。
 *  2. 已登录且角色是 ADMIN。向导里 step=admin 之后浏览器就持有该管理员 cookie
 *     （setup/page.tsx 的 fetch 带 credentials:'include'），故正常流程无感。
 *
 * 两条都不成立时：只有「库里一个管理员都没有 且 没配 SETUP_BOOTSTRAP_TOKEN」才放行——
 * 这就是真正的首次部署窗口，且只剩 step=admin 一条路径（被 ADMIN_CLAIM_KEY 的 CAS
 * 收成一次性的）。llm / soniox / complete 一律不再对匿名者开放。
 */
async function requireSetupAuthorization(req: Request): Promise<NextResponse | null> {
  const bootstrapToken = process.env.SETUP_BOOTSTRAP_TOKEN?.trim();
  if (bootstrapToken) {
    const provided = req.headers.get('x-setup-token')?.trim() ?? '';
    if (provided && secretsMatch(provided, bootstrapToken)) {
      return null;
    }
  }

  let adminCount = 0;
  try {
    adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
  } catch (error) {
    // 表还没建好（P2021）时按「全新库」处理，否则 schema 未同步就永远进不了向导。
    if (!isMissingTableError(error)) throw error;
    adminCount = 0;
  }

  // 还没有管理员：这时无人可登录。没配引导密钥就放行（首次部署窗口），配了就必须带密钥。
  if (adminCount === 0) {
    if (!bootstrapToken) return null;
    return NextResponse.json(
      { error: '缺少或错误的部署引导密钥（x-setup-token）' },
      { status: 401 }
    );
  }

  const { verifyAuth } = await import('@/lib/auth');
  const user = await verifyAuth(req);
  if (!user || user.role !== 'ADMIN') {
    return NextResponse.json(
      { error: '实例已有管理员，请以管理员身份登录后再继续设置' },
      { status: 403 }
    );
  }
  return null;
}

/** 检查是否已完成初始设置 */
async function isSetupComplete(): Promise<boolean> {
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { key: 'setup_complete' },
    });
    return setting?.value === 'true';
  } catch {
    // 数据库可能还没准备好
    return false;
  }
}

/**
 * GET /api/setup
 * 返回当前设置状态（各步骤完成情况）
 */
export async function GET(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'setup:get',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const status = await getSetupStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error('Setup check failed:', error);
    return NextResponse.json(
      { error: '无法检查设置状态' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/setup
 * 根据 step 参数执行不同步骤
 */
export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'setup:post',
    limit: 10,
    windowMs: 10 * 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 已完成设置则阻止再次执行（防止攻击）
  const complete = await isSetupComplete();
  if (complete) {
    return NextResponse.json(
      { error: '初始设置已完成，无法重复执行' },
      { status: 403 }
    );
  }

  // 门禁失败 fail-closed：判定不了就别放行（判定本身要查库）。
  let unauthorized: NextResponse | null;
  try {
    unauthorized = await requireSetupAuthorization(req);
  } catch (error) {
    console.error('Setup authorization check failed:', error);
    return NextResponse.json({ error: getSetupErrorMessage(error) }, { status: 500 });
  }
  if (unauthorized) {
    return unauthorized;
  }

  const body = await req.json();
  const { step } = body;

  try {
    switch (step) {
      case 'database':
        return handleDatabaseCheck();
      case 'admin':
        return handleCreateAdmin(body);
      case 'llm':
        return handleConfigureLlm(body);
      case 'soniox':
        return handleConfigureSoniox(body);
      case 'complete':
        return handleCompleteSetup();
      default:
        return NextResponse.json({ error: '未知步骤' }, { status: 400 });
    }
  } catch (error) {
    console.error(`Setup step "${step}" failed:`, error);
    return NextResponse.json(
      { error: getSetupErrorMessage(error) },
      { status: 500 }
    );
  }
}

/** Step 1: 测试数据库连接 */
async function handleDatabaseCheck() {
  try {
    const status = await getSetupStatus();
    if (!status.steps.database) {
      return NextResponse.json(
        { success: false, error: status.error || '数据库尚未准备就绪' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, message: '数据库连接成功' });
  } catch (error) {
    console.error('Setup database check failed:', error);
    return NextResponse.json(
      { success: false, error: getSetupErrorMessage(error) },
      { status: 500 }
    );
  }
}

/** Step 2: 创建管理员账号 */
async function handleCreateAdmin(body: {
  email?: string;
  password?: string;
  displayName?: string;
}) {
  const {
    signToken,
    setAuthCookie,
    CLIENT_SESSION_TOKEN,
    validatePassword,
  } = await import('@/lib/auth');
  const { email, password, displayName } = body;

  if (!email || !password || !displayName) {
    return NextResponse.json(
      { error: '请提供邮箱、密码和显示名称' },
      { status: 400 }
    );
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // C02/P6-4：把「检查没有管理员」与「建管理员」收进一个事务，并用 SiteSetting.key 的
  // 唯一索引做 CAS 抢占——findFirst + create 之间没有锁，并发能造出第二个隐藏管理员，
  // 而且创建后会被 setAuthCookie 直接登录。抢占失败（P2002）即 409。
  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      await tx.siteSetting.create({
        data: { key: ADMIN_CLAIM_KEY, value: 'true' },
      });

      // 兜底：CAS 键是本次修复才引入的，存量库（已建管理员、未标记 setup_complete）
      // 里没有这一行，抢占会成功——所以仍要按老口径查一次。
      const existingAdmin = await tx.user.findFirst({ where: { role: 'ADMIN' } });
      if (existingAdmin) {
        throw new AdminAlreadyExistsError();
      }

      return tx.user.create({
        data: {
          email,
          passwordHash,
          displayName,
          role: 'ADMIN',
          quotaResetAt: getNextQuotaResetAt(),
          // 初始管理员通过部署向导创建，视为已验证——否则开启邮箱验证后管理员会把自己锁在门外。
          emailVerifiedAt: new Date(),
          transcriptionMinutesLimit: 999999,
          storageHoursLimit: 999999,
          allowedModels: 'local,gpt,claude,deepseek',
        },
      });
    });
  } catch (error) {
    if (error instanceof AdminAlreadyExistsError) {
      return NextResponse.json({ error: '管理员账号已存在' }, { status: 409 });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target = Array.isArray(error.meta?.target)
        ? (error.meta?.target as string[])
        : [];
      if (target.includes('email')) {
        return NextResponse.json({ error: '该邮箱已被注册' }, { status: 409 });
      }
      // ADMIN_CLAIM_KEY 抢占失败：另一个并发请求已经在创建首个管理员。
      return NextResponse.json({ error: '管理员账号已存在' }, { status: 409 });
    }
    throw error;
  }

  // 自动登录：签发 token 并设置 cookie
  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  });
  const response = NextResponse.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
    token: CLIENT_SESSION_TOKEN,
  });
  setAuthCookie(response, token);
  return response;
}

/** Step 3: 配置 LLM Provider */
async function handleConfigureLlm(body: {
  providers?: Array<{
    name: string;
    apiKey: string;
    apiBase: string;
    isAnthropic?: boolean;
    models?: Array<{
      modelId: string;
      displayName: string;
      purpose?: string;
      isDefault?: boolean;
      maxTokens?: number;
      temperature?: number;
    }>;
  }>;
}) {
  const { encrypt } = await import('@/lib/crypto');
  const { providers } = body;
  if (!providers || providers.length === 0) {
    return NextResponse.json(
      { error: '请至少配置一个 LLM 供应商' },
      { status: 400 }
    );
  }

  const created = [];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p.name || !p.apiKey || !p.apiBase) {
      return NextResponse.json(
        { error: `供应商 ${i + 1}: 名称、API Key 和 API 地址必填` },
        { status: 400 }
      );
    }

    // C02/P6-4：apiBase 此前零校验直接落库，而管理员正规路由（admin/llm-providers）
    // 有 validateCloudreveBaseUrl（http/https + 私网黑名单）。落库后 gateway 会把用户
    // prompt 与转录持续发到这个地址，公开路径上更不能省。
    let normalizedApiBase: string;
    try {
      normalizedApiBase = validateCloudreveBaseUrl(p.apiBase);
    } catch {
      return NextResponse.json(
        { error: `供应商 ${i + 1}: API 地址无效（需 http/https 且不得指向内网地址）` },
        { status: 400 }
      );
    }

    // 加密 API Key 后存入数据库
    const encryptedKey = encrypt(p.apiKey);

    const provider = await prisma.llmProvider.create({
      data: {
        name: p.name,
        apiKey: encryptedKey,
        apiBase: normalizedApiBase,
        isAnthropic: p.isAnthropic ?? false,
        sortOrder: i,
      },
    });

    // 创建模型配置：先登记模型库条目（规格真源），再按用途建路由行（同一模型多用途共用条目）
    if (p.models && p.models.length > 0) {
      const registryByKey = new Map<string, string>(); // modelId::displayName → registryId
      for (let j = 0; j < p.models.length; j++) {
        const m = p.models[j];
        const purpose =
          (m.purpose as 'CHAT' | 'REALTIME_SUMMARY' | 'FINAL_SUMMARY' | 'KEYWORD_EXTRACTION' | 'EMBEDDING') ||
          'CHAT';
        const registryKey = `${m.modelId}::${m.displayName}`;
        let registryId = registryByKey.get(registryKey);
        if (!registryId) {
          const registry = await prisma.llmRegistryModel.create({
            data: {
              providerId: provider.id,
              modelId: m.modelId,
              displayName: m.displayName,
              kind: purpose === 'EMBEDDING' ? 'EMBEDDING' : 'TEXT',
              maxTokens: m.maxTokens ?? 4096,
              sortOrder: j,
            },
          });
          registryId = registry.id;
          registryByKey.set(registryKey, registryId);
        }
        await prisma.llmModel.create({
          data: {
            providerId: provider.id,
            registryId,
            modelId: m.modelId,
            displayName: m.displayName,
            purpose,
            isDefault: m.isDefault ?? (j === 0),
            maxTokens: m.maxTokens ?? 4096,
            temperature: m.temperature ?? 0.3,
            sortOrder: j,
          },
        });
      }
    }

    created.push({ id: provider.id, name: provider.name });
  }

  return NextResponse.json({
    success: true,
    providers: created,
  });
}

/** Step 4: 配置 Soniox API Keys（加密存储到 SiteSetting） */
async function handleConfigureSoniox(body: {
  regions?: Record<string, {
    apiKey: string;
    wsUrl?: string;
    restUrl?: string;
  }>;
  defaultRegion?: string;
}) {
  const { encrypt } = await import('@/lib/crypto');
  const { invalidateSiteSettingsCache } = await import('@/lib/siteSettings');
  const { invalidateSonioxDbConfigCache } = await import('@/lib/soniox/env');
  const { regions, defaultRegion } = body;

  if (!regions || Object.keys(regions).length === 0) {
    return NextResponse.json(
      { error: '请至少配置一个区域的 Soniox API Key' },
      { status: 400 }
    );
  }

  // C02/P6-4：先整体校验所有 URL 再落库——管理员正规路由（admin/soniox）有这套校验，
  // 公开的 setup 路径此前没有，等于给未认证者一条把实时转录改指到自己服务器的路。
  // 先校验后写入，避免「前一个区域已写、后一个区域报错」的半成品状态。
  const validatedRegions: Array<{
    upper: string;
    apiKey: string;
    wsUrl?: string;
    restUrl?: string;
  }> = [];
  for (const [region, config] of Object.entries(regions)) {
    if (!['us', 'eu', 'jp'].includes(region)) continue;
    if (!config.apiKey) continue;

    try {
      validatedRegions.push({
        upper: region.toUpperCase(),
        apiKey: config.apiKey,
        wsUrl: config.wsUrl ? validateSonioxWsUrl(config.wsUrl) : undefined,
        restUrl: config.restUrl ? validateSonioxRestUrl(config.restUrl) : undefined,
      });
    } catch {
      return NextResponse.json(
        { error: `区域 ${region}: Soniox 地址无效（不得指向内网地址）` },
        { status: 400 }
      );
    }
  }

  // 逐区域加密存储
  for (const { upper, apiKey, wsUrl, restUrl } of validatedRegions) {
    // 加密 API Key
    await prisma.siteSetting.upsert({
      where: { key: `soniox_${upper}_api_key` },
      update: { value: encrypt(apiKey) },
      create: { key: `soniox_${upper}_api_key`, value: encrypt(apiKey) },
    });

    // 存储 URL（不需要加密）
    if (wsUrl) {
      await prisma.siteSetting.upsert({
        where: { key: `soniox_${upper}_ws_url` },
        update: { value: wsUrl },
        create: { key: `soniox_${upper}_ws_url`, value: wsUrl },
      });
    }
    if (restUrl) {
      await prisma.siteSetting.upsert({
        where: { key: `soniox_${upper}_rest_url` },
        update: { value: restUrl },
        create: { key: `soniox_${upper}_rest_url`, value: restUrl },
      });
    }
  }

  // 默认区域
  if (defaultRegion) {
    await prisma.siteSetting.upsert({
      where: { key: 'soniox_default_region' },
      update: { value: defaultRegion },
      create: { key: 'soniox_default_region', value: defaultRegion },
    });
  }

  // 标记 Soniox 已配置
  await prisma.siteSetting.upsert({
    where: { key: 'soniox_configured' },
    update: { value: 'true' },
    create: { key: 'soniox_configured', value: 'true' },
  });

  invalidateSiteSettingsCache();
  invalidateSonioxDbConfigCache();

  return NextResponse.json({ success: true });
}

/** 标记设置完成 */
async function handleCompleteSetup() {
  // C02/P6-4：此前零前置条件。全仓三处写 setup_complete 全写 'true'、无一处写回 false，
  // 所以匿名者抢先置位就把实例锁死（要恢复必须直连数据库）。
  // 至少要求管理员已存在——正常向导本来就先建管理员，不影响任何合法流程。
  const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
  if (adminCount === 0) {
    return NextResponse.json(
      { error: '尚未创建管理员账号，无法标记设置完成' },
      { status: 400 }
    );
  }

  await prisma.siteSetting.upsert({
    where: { key: 'setup_complete' },
    update: { value: 'true' },
    create: { key: 'setup_complete', value: 'true' },
  });

  return NextResponse.json({ success: true, message: '初始设置已完成！' });
}
