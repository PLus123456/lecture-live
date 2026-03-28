// src/app/api/setup/route.ts
// 初始部署设置向导 API — 检查状态 & 完成各步骤配置

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getNextQuotaResetAt } from '@/lib/billing';
import { enforceRateLimit } from '@/lib/rateLimit';
import bcrypt from 'bcryptjs';

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

  // 检查是否已有 admin
  const existingAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });
  if (existingAdmin) {
    return NextResponse.json(
      { error: '管理员账号已存在' },
      { status: 409 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName,
      role: 'ADMIN',
      quotaResetAt: getNextQuotaResetAt(),
      transcriptionMinutesLimit: 999999,
      storageHoursLimit: 999999,
      allowedModels: 'local,gpt,claude,deepseek',
    },
  });

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

    // 加密 API Key 后存入数据库
    const encryptedKey = encrypt(p.apiKey);

    const provider = await prisma.llmProvider.create({
      data: {
        name: p.name,
        apiKey: encryptedKey,
        apiBase: p.apiBase,
        isAnthropic: p.isAnthropic ?? false,
        sortOrder: i,
      },
    });

    // 创建模型配置
    if (p.models && p.models.length > 0) {
      for (let j = 0; j < p.models.length; j++) {
        const m = p.models[j];
        await prisma.llmModel.create({
          data: {
            providerId: provider.id,
            modelId: m.modelId,
            displayName: m.displayName,
            purpose: (m.purpose as 'CHAT' | 'REALTIME_SUMMARY' | 'FINAL_SUMMARY' | 'KEYWORD_EXTRACTION') || 'CHAT',
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

  // 逐区域加密存储
  for (const [region, config] of Object.entries(regions)) {
    if (!['us', 'eu', 'jp'].includes(region)) continue;
    if (!config.apiKey) continue;

    const upper = region.toUpperCase();

    // 加密 API Key
    await prisma.siteSetting.upsert({
      where: { key: `soniox_${upper}_api_key` },
      update: { value: encrypt(config.apiKey) },
      create: { key: `soniox_${upper}_api_key`, value: encrypt(config.apiKey) },
    });

    // 存储 URL（不需要加密）
    if (config.wsUrl) {
      await prisma.siteSetting.upsert({
        where: { key: `soniox_${upper}_ws_url` },
        update: { value: config.wsUrl },
        create: { key: `soniox_${upper}_ws_url`, value: config.wsUrl },
      });
    }
    if (config.restUrl) {
      await prisma.siteSetting.upsert({
        where: { key: `soniox_${upper}_rest_url` },
        update: { value: config.restUrl },
        create: { key: `soniox_${upper}_rest_url`, value: config.restUrl },
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
  await prisma.siteSetting.upsert({
    where: { key: 'setup_complete' },
    update: { value: 'true' },
    create: { key: 'setup_complete', value: 'true' },
  });

  return NextResponse.json({ success: true, message: '初始设置已完成！' });
}
