// src/app/api/setup/route.ts
// 初始部署设置向导 API — 检查状态 & 完成各步骤配置

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { UserPayload } from '@/lib/auth';
import { getNextQuotaResetAt } from '@/lib/billing';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  describeLlmEndpointForAudit,
  validateLlmProviderBaseUrl,
} from '@/lib/llm/outboundPolicy';
import { requireLlmAdminCurrentPassword } from '@/lib/llm/adminReauth';
import { writeLlmSecurityAudit } from '@/lib/llm/securityAudit';
// P6-4：与 admin/soniox/route.ts 共用同一份实现，避免「同一防护只装在一条路径上」重演。
import {
  validateSonioxRestUrl,
  validateSonioxWsUrl,
} from '@/lib/sonioxUrlValidation';
import bcrypt from 'bcryptjs';
import { guardAuthMutationRequest } from '@/lib/publicAuth';

// 「首个管理员已被认领」的 CAS 键。SiteSetting.key 上有唯一索引，create 抢锁天然原子；
// MySQL 表达不了「role=ADMIN 只能一行」，findFirst + create 之间的空档足够并发造出
// 第二个隐藏管理员（还会被 setAuthCookie 直接登录）。
const ADMIN_CLAIM_KEY = 'setup_admin_claimed';
const MIN_BOOTSTRAP_TOKEN_BYTES = 32;

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

    // M24（本轮降级为 low）：这里原本会在「db+admin+llm+soniox 全就绪」时顺手
    // upsert setup_complete='true'。报告说的「匿名者抢先锁死向导」不成立
    // （hasAdmin 是硬前提，没有管理员根本不写），但残留一个真实的观感问题：
    // 管理员刚建好、向导还没点「完成」时，任意一次并发 GET 都可能抢先置位，
    // 于是 step=complete 拿到 403「初始设置已完成，无法重复执行」。
    //
    // GET 是**读**接口，不该有写副作用。置位只保留在 step=complete
    // （handleCompleteSetup，要求已有管理员且通过 requireSetupAuthorization）。
    // 「已有部署升级后首次访问」的兼容路径由 src/app/page.tsx 的 SSR 检查承担。
    if (!setupComplete && dbConnected && hasAdmin && hasLlmProvider && hasSoniox) {
      // 只在返回值里体现，不落库
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

/**
 * L7：显示名归一化 —— trim + 截断。schema 里 `displayName String` 映射成 TEXT，
 * 没有任何长度约束，未截断就落库意味着管理后台/审计日志/会话列表都会被超大字符串放大。
 * 64 字符对真实姓名/昵称绰绰有余。
 */
// 注：route.ts 只允许导出 Next 认识的路由符号，故这里不 export；
// auth/register/route.ts 里有一份同口径的实现。
const MAX_DISPLAY_NAME_LENGTH = 64;

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
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
 * 授权随实例状态单向切换，不存在两把可长期并用的钥匙：
 *  1. 库里没有管理员时，必须用至少 32 字节的 `SETUP_BOOTSTRAP_TOKEN`，且它只能调用
 *     step=admin；缺配置、弱配置、错 token 全部关闭失败。
 *  2. 首个管理员的 CAS 创建成功后，bootstrap token 立即失去全部能力，后续步骤只认
 *     已登录 ADMIN。即使部署环境仍保留 token，也不会形成隐藏的长期管理凭据。
 */
type SetupAuthorization =
  | { mode: 'bootstrap'; response: null }
  | { mode: 'admin'; user: UserPayload; response: null }
  | { mode: null; response: NextResponse };

function readBootstrapToken(): string | null {
  const token = process.env.SETUP_BOOTSTRAP_TOKEN?.trim();
  if (!token || Buffer.byteLength(token, 'utf8') < MIN_BOOTSTRAP_TOKEN_BYTES) {
    return null;
  }
  return token;
}

async function requireSetupAuthorization(req: Request): Promise<SetupAuthorization> {
  let adminCount = 0;
  try {
    adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
  } catch (error) {
    // 表还没建好（P2021）时按「全新库」处理，否则 schema 未同步就永远进不了向导。
    if (!isMissingTableError(error)) throw error;
    adminCount = 0;
  }

  // 首个管理员只能由部署侧的一次性秘密认领。缺少/弱配置必须 fail-closed；否则把
  // 服务启动在公网到管理员真正创建之间的窗口交给了最快发请求的人。
  if (adminCount === 0) {
    const bootstrapToken = readBootstrapToken();
    if (!bootstrapToken) {
      return {
        mode: null,
        response: NextResponse.json(
          {
            error:
              '服务器未配置有效的 SETUP_BOOTSTRAP_TOKEN（至少 32 字节），已拒绝首次管理员认领',
          },
          { status: 503 }
        ),
      };
    }

    const provided = req.headers.get('x-setup-token')?.trim() ?? '';
    if (!provided || !secretsMatch(provided, bootstrapToken)) {
      return {
        mode: null,
        response: NextResponse.json(
          { error: '缺少或错误的部署引导密钥（x-setup-token）' },
          { status: 401 }
        ),
      };
    }
    return { mode: 'bootstrap', response: null };
  }

  // 管理员一旦存在，引导密钥立即永久失去授权能力。即使环境变量仍保留、甚至泄露，
  // 也不能被拿来改写 LLM/Soniox 配置或提前完成向导；后续步骤只认当前 ADMIN 会话。
  const { verifyAuth } = await import('@/lib/auth');
  const user = await verifyAuth(req);
  if (!user || user.role !== 'ADMIN') {
    return {
      mode: null,
      response: NextResponse.json(
        { error: '实例已有管理员，请以管理员身份登录后再继续设置' },
        { status: 403 }
      ),
    };
  }
  return { mode: 'admin', user, response: null };
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

    // L55：四个部署状态布尔（数据库/管理员/LLM/Soniox 是否就绪）属于内部信息，
    // 不该对任意匿名者公开 —— 它能告诉攻击者「现在是不是无管理员的首次部署窗口」。
    // 已完成设置后更是纯泄露（向导再也用不到它）。
    // 只在以下两种情况给明细：① 通过门禁（引导密钥 / 已登录 ADMIN）；
    // ② 真正的首次部署窗口（库里零管理员且没配引导密钥）—— 此时向导本来就是匿名的。
    if (status.setupComplete) {
      return NextResponse.json({ setupComplete: true });
    }

    let detailed = false;
    try {
      // 只读状态查询复用同一套门禁：通过（引导密钥 / 已登录 ADMIN）才给明细。
      const outcome = await requireSetupAuthorization(req);
      detailed = outcome.response === null;
    } catch {
      detailed = false;
    }

    if (!detailed) {
      return NextResponse.json({
        setupComplete: false,
        error: '实例已有管理员，请以管理员身份登录后再查看设置状态',
      });
    }

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
  const requestGuard = guardAuthMutationRequest(req, { requireJson: true });
  if (requestGuard) return requestGuard;
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

  // L53：`await req.json()` 原本裸在 try/catch 之外，畸形 JSON 会冒泡成框架默认 500。
  // 客户端错误就该是 400。解析必须排在门禁之前——门禁要按 step 收窄（见下）。
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON 对象' }, { status: 400 });
  }

  const { step } = body as { step?: unknown };

  // 门禁失败 fail-closed：判定不了就别放行（判定本身要查库）。
  let authorization: SetupAuthorization;
  try {
    authorization = await requireSetupAuthorization(req);
  } catch (error) {
    console.error('Setup authorization check failed:', error);
    return NextResponse.json({ error: getSetupErrorMessage(error) }, { status: 500 });
  }
  if (authorization.response) {
    return authorization.response;
  }

  // bootstrap token 的唯一权限是原子认领首个管理员。数据库检查、服务配置与 complete
  // 都必须等管理员登录后执行，避免 token 变成长生命周期的隐形管理凭据。
  if (authorization.mode === 'bootstrap' && step !== 'admin') {
    return NextResponse.json(
      { error: '部署引导密钥仅可用于创建首个管理员账号' },
      { status: 403 }
    );
  }

  try {
    switch (step) {
      case 'database':
        return handleDatabaseCheck();
      case 'admin':
        return handleCreateAdmin(body as Parameters<typeof handleCreateAdmin>[0]);
      case 'llm':
        // bootstrap 模式只能走 step=admin，已在上方统一拒绝；LLM 创建必须绑定
        // 当前已认证管理员，供 inline password proof 与拒绝审计使用。
        if (authorization.mode !== 'admin') {
          return NextResponse.json({ error: 'LLM 配置需要管理员会话' }, { status: 403 });
        }
        return await handleConfigureLlm(req, body, authorization.user);
      case 'soniox':
        return handleConfigureSoniox(
          body as Parameters<typeof handleConfigureSoniox>[0]
        );
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
    getAuthTokenSessionBinding,
    issueAuthToken,
    setAuthCookie,
    CLIENT_SESSION_TOKEN,
    validatePassword,
  } = await import('@/lib/auth');
  const { email, password } = body;
  // L7：displayName 与注册路由同口径 —— 先 trim 再截断，避免超大字符串直接落库
  // （schema 里 displayName 是 TEXT，没有长度约束）。
  const displayName = normalizeDisplayName(body.displayName);

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
  const token = await issueAuthToken({
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
    sessionBinding: getAuthTokenSessionBinding(token),
  });
  setAuthCookie(response, token);
  response.headers.set('Clear-Site-Data', '"cache"');
  return response;
}

/** Step 3: 配置 LLM Provider */
async function handleConfigureLlm(req: Request, body: {
  currentPassword?: unknown;
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
}, admin: UserPayload) {
  const { encrypt } = await import('@/lib/crypto');
  const { providers } = body;
  if (!providers || providers.length === 0) {
    return NextResponse.json(
      { error: '请至少配置一个 LLM 供应商' },
      { status: 400 }
    );
  }

  // 先验证整批，再做一次 password proof，之后才允许任何 provider 落库。
  // 这既避免第二个 provider 拒绝时留下半批数据，也保证审计失败不会发生部分写入。
  const validatedProviders: Array<{
    provider: NonNullable<typeof providers>[number];
    normalizedApiBase: string;
  }> = [];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p.name || !p.apiKey || !p.apiBase) {
      return NextResponse.json(
        { error: `供应商 ${i + 1}: 名称、API Key 和 API 地址必填` },
        { status: 400 }
      );
    }

    // SEC-034：setup 与日常管理必须使用同一份精确 origin allowlist；否则向导会成为
    // 绕过后台出站策略、直接落库任意 provider 地址的第二写入口。
    let normalizedApiBase: string;
    try {
      normalizedApiBase = await validateLlmProviderBaseUrl(p.apiBase);
    } catch {
      await writeLlmSecurityAudit(req, 'llm-provider.create-rejected', {
        user: admin,
        detail: {
          reason: 'setup_outbound_origin_policy',
          setup: true,
          providerIndex: i,
          endpoint: describeLlmEndpointForAudit(p.apiBase),
        },
      });
      return NextResponse.json(
        { error: `供应商 ${i + 1}: API 地址不在服务端 LLM origin 允许列表中` },
        { status: 400 }
      );
    }

    validatedProviders.push({ provider: p, normalizedApiBase });
  }

  const reauth = await requireLlmAdminCurrentPassword(
    req,
    admin.id,
    body.currentPassword
  );
  if (!reauth.ok) {
    await writeLlmSecurityAudit(req, 'llm-provider.create-rejected', {
      user: admin,
      detail: {
        reason: `setup_reauth_${reauth.reason}`,
        setup: true,
        providerCount: validatedProviders.length,
        endpoints: validatedProviders.map(({ normalizedApiBase }) =>
          describeLlmEndpointForAudit(normalizedApiBase)
        ),
      },
    });
    return reauth.response;
  }

  // Provider、registry 和用途路由是一份高敏配置的单一逻辑批次。即使 allowlist 与
  // reauth 已全部通过，任一后续数据库写失败也不能留下前半批凭据/端点，因此整批同进同退。
  const created = await prisma.$transaction(
    async (tx) => {
      const staged: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < validatedProviders.length; i++) {
        const { provider: p, normalizedApiBase } = validatedProviders[i];

        // 加密 API Key 后存入数据库
        const encryptedKey = encrypt(p.apiKey);

        const provider = await tx.llmProvider.create({
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
              const registry = await tx.llmRegistryModel.create({
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
            await tx.llmModel.create({
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

        staged.push({ id: provider.id, name: provider.name });
      }
      return staged;
    },
    // L54：供应商 × 模型可能有十几行写入，默认 5s 事务超时偏紧。
    { timeout: 20_000 }
  );

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
  // C02/P6-4：这是全仓唯一允许写 setup_complete 的位置，且 POST 外层已经验证当前
  // 请求是 ADMIN 会话。首页与公开 GET /api/setup 都只读，不能替操作者提前封闭向导。
  // 再检查管理员确实存在，避免异常状态下写入不可恢复的完成标记。
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
