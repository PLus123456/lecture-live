// src/lib/storage/cloudreve.ts
// Cloudreve V4 OAuth 应用集成

import 'server-only';

import path from 'path';
import { prisma } from '@/lib/prisma';
import { getSiteSettings } from '@/lib/siteSettings';
import { sanitizePath } from '@/lib/security';
import { decrypt, encrypt, isEncrypted } from '@/lib/crypto';
import { logger, serializeError } from '@/lib/logger';
import { logSystemEvent } from '@/lib/auditLog';

const cloudreveLogger = logger.child({ component: 'cloudreve-storage' });

const STORAGE_CATEGORIES = ['recordings', 'transcripts', 'summaries', 'reports'] as const;
// Cloudreve V4 用 Files.Write 表示读写权限，请求 Files.Read + Files.Write 组合
// 在部分 Cloudreve 实例上会被同意页拒绝。
const DEFAULT_CLOUDREVE_OAUTH_SCOPE = 'openid offline_access Files.Write';

const TOKEN_DB_KEYS = [
  'cloudreve_access_token',
  'cloudreve_refresh_token',
  'cloudreve_token_expires_at',
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export function isStorageCategory(value: string): value is StorageCategory {
  return STORAGE_CATEGORIES.includes(value as StorageCategory);
}

/* ------------------------------------------------------------------ */
/*  配置                                                              */
/* ------------------------------------------------------------------ */

interface CloudreveOAuthConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

interface CloudreveTokenSet {
  accessToken: string;
  refreshToken: string;
  /** token 过期的绝对时间戳（ms） */
  expiresAt: number;
}

/** 内存中的 token 缓存 */
let tokenCache: CloudreveTokenSet | null = null;

/** 内存中的 OAuth 配置缓存（从数据库加载后缓存） */
let configCache: CloudreveOAuthConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 60_000;

/* ------------------------------------------------------------------ */
/*  配置解析：环境变量优先，数据库 siteSettings 兜底                      */
/* ------------------------------------------------------------------ */

function getConfigFromEnv(): CloudreveOAuthConfig | null {
  const baseUrl = process.env.CLOUDREVE_BASE_URL?.trim();
  const clientId = process.env.CLOUDREVE_CLIENT_ID?.trim();
  const clientSecret = process.env.CLOUDREVE_CLIENT_SECRET?.trim();
  if (baseUrl && clientId && clientSecret) {
    return { baseUrl, clientId, clientSecret };
  }
  return null;
}

async function getConfigFromDb(): Promise<CloudreveOAuthConfig | null> {
  try {
    const settings = await getSiteSettings();
    const baseUrl = settings.cloudreve_url?.trim();
    const clientId = settings.cloudreve_client_id?.trim();
    const clientSecret = settings.cloudreve_client_secret?.trim();

    if (
      settings.storage_mode === 'cloudreve' &&
      baseUrl &&
      clientId &&
      clientSecret
    ) {
      return { baseUrl, clientId, clientSecret };
    }
  } catch {
    // 数据库不可用时静默失败
  }
  return null;
}

/**
 * 解析 Cloudreve OAuth 配置（环境变量优先，数据库兜底，带缓存）
 */
export async function resolveCloudreveConfig(): Promise<CloudreveOAuthConfig | null> {
  // 环境变量优先
  const envConfig = getConfigFromEnv();
  if (envConfig) return envConfig;

  // 内存缓存
  if (configCache && Date.now() - configCacheTime < CONFIG_CACHE_TTL_MS) {
    return configCache;
  }

  const dbConfig = await getConfigFromDb();
  if (dbConfig) {
    configCache = dbConfig;
    configCacheTime = Date.now();
  }
  return dbConfig;
}

/**
 * 清除配置缓存（设置更新后调用）
 */
export function invalidateCloudreveConfigCache() {
  configCache = null;
  configCacheTime = 0;
}

/* ------------------------------------------------------------------ */
/*  公共判断函数                                                       */
/* ------------------------------------------------------------------ */

/**
 * 同步判断 Cloudreve 是否已通过环境变量配置（用于不方便 await 的场景）
 */
export function isCloudreveConfigured(): boolean {
  return getConfigFromEnv() !== null;
}

/**
 * 异步判断 Cloudreve 是否已配置（环境变量或数据库）
 */
export async function isCloudreveConfiguredAsync(): Promise<boolean> {
  const config = await resolveCloudreveConfig();
  return config !== null;
}

/**
 * 判断 Cloudreve 是否已完成 OAuth 授权（有可用的 refresh_token）
 */
export function isCloudreveAuthorized(): boolean {
  return Boolean(tokenCache?.refreshToken);
}

/* ------------------------------------------------------------------ */
/*  路径构建 & 校验                                                    */
/* ------------------------------------------------------------------ */

export function buildCloudreveRemotePath(
  userId: string,
  category: StorageCategory,
  fileName: string
): string {
  const safeName = sanitizePath(path.basename(fileName));
  const safeUserId = sanitizePath(userId);
  return `/${safeUserId}/${category}/${safeName}`;
}

function isPrivateIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const [first, second] = parts.map((part) => Number(part));
  if (first === 10 || first === 127) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

function allowPrivateCloudreveHost(): boolean {
  const configured = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST?.trim().toLowerCase();
  return configured === '1' || configured === 'true' || configured === 'yes';
}

function validateCloudreveBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CLOUDREVE_BASE_URL must be a valid URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('CLOUDREVE_BASE_URL must use HTTP or HTTPS');
  }

  const usesPrivateHost =
    parsed.username ||
    parsed.password ||
    parsed.hostname === 'localhost' ||
    parsed.hostname.endsWith('.local') ||
    parsed.hostname.endsWith('.internal') ||
    parsed.hostname === '::1' ||
    isPrivateIpv4Host(parsed.hostname);

  if (
    usesPrivateHost &&
    !allowPrivateCloudreveHost()
  ) {
    throw new Error('CLOUDREVE_BASE_URL must point to a trusted public host');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateRemotePath(
  remotePath: string,
  expectedUserId?: string
): string {
  const parts = remotePath.split('/').filter(Boolean);
  if (parts.length !== 3) {
    throw new Error('Invalid Cloudreve remote path');
  }

  const [userId, category, fileName] = parts;
  if (sanitizePath(userId) !== userId) {
    throw new Error('Invalid Cloudreve user path');
  }

  if (expectedUserId && userId !== sanitizePath(expectedUserId)) {
    throw new Error('Cloudreve path does not belong to the current user');
  }

  if (!isStorageCategory(category)) {
    throw new Error('Invalid Cloudreve storage category');
  }

  if (sanitizePath(path.basename(fileName)) !== fileName) {
    throw new Error('Invalid Cloudreve file path');
  }

  return `/${userId}/${category}/${fileName}`;
}

function normalizeCloudreveScope(scope: string): string {
  return scope.split(/\s+/).filter(Boolean).join(' ');
}

function resolveExpiresAt(
  payload: Record<string, unknown>,
  preferredKeys: string[]
): number {
  for (const key of preferredKeys) {
    const rawValue = payload[key];
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return Date.now() + rawValue * 1000;
    }

    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        continue;
      }

      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber)) {
        return Date.now() + asNumber * 1000;
      }

      const asDate = Date.parse(trimmed);
      if (!Number.isNaN(asDate)) {
        return asDate;
      }
    }
  }

  return Date.now() + 3600 * 1000;
}

/* ------------------------------------------------------------------ */
/*  OAuth 工具函数                                                     */
/* ------------------------------------------------------------------ */

/**
 * 生成 PKCE code_verifier（43-128 位随机字符串）
 */
export function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const length = 64;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * 根据 code_verifier 生成 code_challenge（S256）
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 构建 Cloudreve V4 OAuth 授权 URL
 */
export async function buildAuthorizeUrl(
  redirectUri: string,
  codeVerifier: string,
  scope = DEFAULT_CLOUDREVE_OAUTH_SCOPE
): Promise<string> {
  const config = await resolveCloudreveConfig();
  if (!config) {
    throw new Error('Cloudreve OAuth 未配置，请先设置 Cloudreve URL、Client ID、Client Secret');
  }

  const baseUrl = validateCloudreveBaseUrl(config.baseUrl);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: normalizeCloudreveScope(scope),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${baseUrl}/session/authorize?${params.toString()}`;
}

/**
 * 用 authorization_code 换取 token
 */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<CloudreveTokenSet> {
  const config = await resolveCloudreveConfig();
  if (!config) {
    throw new Error('Cloudreve OAuth 未配置');
  }

  const baseUrl = validateCloudreveBaseUrl(config.baseUrl);
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;

  const response = await fetch(`${baseUrl}/api/v4/session/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Cloudreve OAuth token 交换失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const tokenSet = parseTokenResponse(data, 'OAuth token 交换', [
    'expires_in',
    'access_expires',
  ]);
  tokenCache = tokenSet;
  return tokenSet;
}

/**
 * 刷新 access_token
 */
async function refreshAccessToken(
  baseUrl: string,
  currentRefreshToken: string
): Promise<CloudreveTokenSet> {
  const response = await fetch(`${baseUrl}/api/v4/session/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: currentRefreshToken }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Cloudreve token 刷新失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const tokenSet = parseTokenResponse(
    data,
    'token 刷新',
    ['access_expires', 'expires_in'],
    currentRefreshToken
  );
  tokenCache = tokenSet;
  return tokenSet;
}

/**
 * 解析 Cloudreve V4 OAuth token 响应。
 * V4 习惯返回 200 + `{ code, msg, data }`，其中 code != 0 即业务失败 —
 * 必须先校验 code 再取字段，否则会把 undefined access_token 写进缓存。
 */
function parseTokenResponse(
  data: unknown,
  action: string,
  expiryKeys: string[],
  fallbackRefreshToken?: string
): CloudreveTokenSet {
  if (!data || typeof data !== 'object') {
    throw new Error(`Cloudreve ${action} 失败：响应不是 JSON 对象`);
  }

  const envelope = data as Record<string, unknown>;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    const msg = typeof envelope.msg === 'string' ? envelope.msg : 'unknown';
    throw new Error(`Cloudreve ${action} 失败：[${envelope.code}] ${msg}`);
  }

  const payload = (envelope.data ?? envelope) as Record<string, unknown>;
  const accessToken =
    typeof payload.access_token === 'string' ? payload.access_token : '';
  const refreshTokenRaw =
    typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
  const refreshToken = refreshTokenRaw || fallbackRefreshToken || '';

  if (!accessToken || !refreshToken) {
    throw new Error(
      `Cloudreve ${action} 失败：响应缺少 access_token 或 refresh_token`
    );
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(payload, expiryKeys),
  };
}

/**
 * 从外部加载 token（用于从数据库恢复 token 到内存缓存）
 */
export function loadTokensIntoCache(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}) {
  tokenCache = { ...tokens };
}

/**
 * 获取当前缓存的 token（用于持久化到数据库）
 */
export function getCachedTokens(): CloudreveTokenSet | null {
  return tokenCache ? { ...tokenCache } : null;
}

/**
 * 清除内存中的 token 缓存（不动数据库）
 */
export function clearCachedTokens() {
  tokenCache = null;
}

/**
 * 清除内存缓存 + 数据库中持久化的所有 token 记录。
 * 用于：refresh_token 失效、配置变更、管理员主动撤销授权。
 */
export async function clearPersistedTokens(): Promise<void> {
  tokenCache = null;
  try {
    await prisma.siteSetting.deleteMany({
      where: { key: { in: [...TOKEN_DB_KEYS] } },
    });
  } catch (err) {
    cloudreveLogger.error(
      { err: serializeError(err) },
      '[Cloudreve] 清除持久化 token 失败'
    );
    throw err;
  }
}

/**
 * 异步检查 Cloudreve 是否完成 OAuth 授权（数据库中存在 refresh_token）。
 * 用于 admin 面板"授权状态"显示，而 isCloudreveAuthorized() 仅看内存。
 */
export async function isCloudreveAuthorizedAsync(): Promise<boolean> {
  if (tokenCache?.refreshToken) {
    return true;
  }

  try {
    const row = await prisma.siteSetting.findUnique({
      where: { key: 'cloudreve_refresh_token' },
    });
    return Boolean(row?.value && row.value.trim());
  } catch {
    return false;
  }
}

/**
 * 获取 Cloudreve 当前授权状态（含 access_token 过期时间），用于 admin UI。
 *
 * **不要走内存缓存**：Next.js 进程和 WebSocket 进程是两个独立 Node 进程，
 * 各自维护各自的 `tokenCache`。token refresh loop 跑在 WS 进程里，刷新后
 * 只更新 WS 进程的内存 + DB；Next.js 进程的 `tokenCache.expiresAt` 永远停在
 * 它自己最后一次刷新时的值，于是 admin 面板会"看到"授权过期，但实际上 DB
 * 里 token 一直是新的。
 *
 * 这是给 UI 显示用的接口，不在热路径上，性能不重要，跨进程一致性才重要。
 */
export async function getCloudreveAuthStatus(): Promise<{
  authorized: boolean;
  expiresAt: number | null;
}> {
  try {
    const rows = await prisma.siteSetting.findMany({
      where: { key: { in: [...TOKEN_DB_KEYS] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const refreshTokenCipher = map.get('cloudreve_refresh_token');
    const expiresAtRaw = map.get('cloudreve_token_expires_at');

    const authorized = Boolean(refreshTokenCipher && refreshTokenCipher.trim());
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null;
    return {
      authorized,
      expiresAt: expiresAt && Number.isFinite(expiresAt) ? expiresAt : null,
    };
  } catch {
    return { authorized: false, expiresAt: null };
  }
}

/* ------------------------------------------------------------------ */
/*  主动刷新（供 WS 进程内的定时维护循环使用）                          */
/* ------------------------------------------------------------------ */

export type CloudreveRefreshSource = 'boot' | 'scheduler' | 'manual';

export type CloudreveRefreshOutcome =
  | { action: 'refreshed'; expiresAt: number }
  | { action: 'skipped_not_due'; msUntilExpiry: number }
  | { action: 'skipped_unauthorized' }
  | { action: 'skipped_unconfigured' };

/**
 * 主动刷新 Cloudreve token。与 getAccessToken 不同，本函数在"未配置 / 未授权 /
 * 仍在有效期"情形下返回 skipped_* 状态而非抛错，方便定时循环安静跳过。
 *
 * - 解密失败：写 AuditLog 'admin.cloudreve.token.decrypt_failed'，清掉 DB token，抛错
 * - refresh API 失败：写 AuditLog 'admin.cloudreve.refresh.failed'，清掉 DB token，抛错
 * - 成功：调用者自行决定是否写 AuditLog（避免每次定时刷成功都污染审计日志）
 */
export async function refreshCloudreveTokenProactively(opts: {
  source: CloudreveRefreshSource;
  /** token 距离过期还有多少 ms 时才触发刷新。默认 0 = 已过期才刷 */
  minTimeToExpiryMs?: number;
}): Promise<CloudreveRefreshOutcome> {
  const minTimeToExpiry = opts.minTimeToExpiryMs ?? 0;

  const config = await resolveCloudreveConfig();
  if (!config) {
    return { action: 'skipped_unconfigured' };
  }

  let refreshToken = tokenCache?.refreshToken ?? '';
  let currentExpiresAt = tokenCache?.expiresAt ?? 0;

  if (!refreshToken) {
    const rows = await prisma.siteSetting.findMany({
      where: { key: { in: [...TOKEN_DB_KEYS] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const refreshTokenRaw = map.get('cloudreve_refresh_token');
    const expiresAtRaw = map.get('cloudreve_token_expires_at');

    if (!refreshTokenRaw) {
      return { action: 'skipped_unauthorized' };
    }

    try {
      refreshToken = decrypt(refreshTokenRaw);
    } catch (err) {
      cloudreveLogger.error(
        { source: opts.source, err: serializeError(err) },
        '[Cloudreve] refresh_token 解密失败，可能 ENCRYPTION_KEY 不匹配'
      );
      logSystemEvent(
        'admin.cloudreve.token.decrypt_failed',
        JSON.stringify({
          source: opts.source,
          hint: 'ENCRYPTION_KEY mismatch suspected',
        })
      );
      await clearPersistedTokens().catch((cleanupErr) => {
        cloudreveLogger.error(
          { err: serializeError(cleanupErr) },
          '[Cloudreve] 解密失败后清除 token 失败'
        );
      });
      throw new Error('Cloudreve refresh_token 解密失败');
    }

    const parsedExpiry = expiresAtRaw ? Number(expiresAtRaw) : 0;
    currentExpiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : 0;
  }

  const msUntilExpiry = currentExpiresAt - Date.now();
  if (currentExpiresAt > 0 && msUntilExpiry > minTimeToExpiry) {
    return { action: 'skipped_not_due', msUntilExpiry };
  }

  const baseUrl = validateCloudreveBaseUrl(config.baseUrl);

  let refreshed: CloudreveTokenSet;
  try {
    refreshed = await refreshAccessToken(baseUrl, refreshToken);
  } catch (err) {
    cloudreveLogger.error(
      { source: opts.source, err: serializeError(err) },
      '[Cloudreve] token 刷新失败，清除持久化 token'
    );
    logSystemEvent(
      'admin.cloudreve.refresh.failed',
      JSON.stringify({
        source: opts.source,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    await clearPersistedTokens().catch((cleanupErr) => {
      cloudreveLogger.error(
        { err: serializeError(cleanupErr) },
        '[Cloudreve] 刷新失败后清除 token 失败'
      );
    });
    throw err;
  }

  // 同步写回 DB —— 不能 fire-and-forget：refresh_token rotation 后若没存上，
  // 下次循环还会用旧的，Cloudreve 端可能已经把它废了。
  try {
    await prisma.$transaction([
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_access_token' },
        update: { value: encrypt(refreshed.accessToken) },
        create: {
          key: 'cloudreve_access_token',
          value: encrypt(refreshed.accessToken),
        },
      }),
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_refresh_token' },
        update: { value: encrypt(refreshed.refreshToken) },
        create: {
          key: 'cloudreve_refresh_token',
          value: encrypt(refreshed.refreshToken),
        },
      }),
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_token_expires_at' },
        update: { value: String(refreshed.expiresAt) },
        create: {
          key: 'cloudreve_token_expires_at',
          value: String(refreshed.expiresAt),
        },
      }),
    ]);
  } catch (err) {
    cloudreveLogger.error(
      { source: opts.source, err: serializeError(err) },
      '[Cloudreve] 刷新后持久化 token 失败 —— 下次循环可能使用已被 rotation 废弃的 refresh_token'
    );
    logSystemEvent(
      'admin.cloudreve.refresh.failed',
      JSON.stringify({
        source: opts.source,
        error:
          'persist_after_refresh: ' +
          (err instanceof Error ? err.message : String(err)),
      })
    );
    throw err;
  }

  return { action: 'refreshed', expiresAt: refreshed.expiresAt };
}

/* ------------------------------------------------------------------ */
/*  V4 API 响应解析                                                    */
/* ------------------------------------------------------------------ */

interface CloudreveApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

function assertApiSuccess<T>(result: CloudreveApiResponse<T>, action: string): T {
  if (result.code !== 0) {
    throw new Error(`Cloudreve ${action} 失败: [${result.code}] ${result.msg}`);
  }
  return result.data;
}

/* ------------------------------------------------------------------ */
/*  CloudreveStorage 类                                               */
/* ------------------------------------------------------------------ */

export class CloudreveStorage {
  private config: CloudreveOAuthConfig;

  /**
   * 构造函数：优先用环境变量，也接受外部传入配置
   */
  constructor(overrideConfig?: CloudreveOAuthConfig) {
    if (overrideConfig) {
      this.config = {
        baseUrl: validateCloudreveBaseUrl(overrideConfig.baseUrl),
        clientId: overrideConfig.clientId,
        clientSecret: overrideConfig.clientSecret,
      };
      return;
    }

    // 尝试从环境变量读取
    const envConfig = getConfigFromEnv();
    if (envConfig) {
      this.config = {
        baseUrl: validateCloudreveBaseUrl(envConfig.baseUrl),
        clientId: envConfig.clientId,
        clientSecret: envConfig.clientSecret,
      };
      return;
    }

    // 同步路径无法读数据库，用占位符；实际调用 API 前会通过 create() 初始化
    this.config = { baseUrl: '', clientId: '', clientSecret: '' };
  }

  /**
   * 异步工厂方法：从环境变量或数据库解析配置后创建实例
   */
  static async create(): Promise<CloudreveStorage> {
    const config = await resolveCloudreveConfig();
    if (!config) {
      throw new Error('Cloudreve is not configured');
    }
    return new CloudreveStorage(config);
  }

  private async getConfig(): Promise<CloudreveOAuthConfig> {
    if (this.config.baseUrl) {
      return this.config;
    }

    const config = await resolveCloudreveConfig();
    if (!config) {
      throw new Error('Cloudreve is not configured');
    }

    this.config = {
      baseUrl: validateCloudreveBaseUrl(config.baseUrl),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
    return this.config;
  }

  /**
   * 获取有效的 access_token，必要时自动从数据库恢复或刷新。
   * refresh_token 被 Cloudreve 拒绝时会清空内存缓存与数据库中的 token 行，
   * 避免下次请求又撞同一份失效 token —— 这是历史"过期不删"bug 的根因。
   */
  private async getAccessToken(): Promise<string> {
    // 缓存中有且未过期（预留 60s 缓冲）
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.accessToken;
    }

    // 缓存为空 或 本进程缓存判定为快过期 —— 先从 DB 重读一次。
    //
    // 关键：WS 进程跑 token refresh loop，刷新后只更新 WS 内存 + DB；
    // Next.js 进程的内存缓存里 expiresAt 还停在本进程上次刷新的旧值。
    // 如果我们直接根据本地 expiresAt 调 refresh API，会和 WS 进程并发刷新，
    // 此时 refresh_token rotation 后某一方拿到的 refresh_token 已被废 ——
    // 两个进程的 OAuth 链路会互相踩。
    //
    // 因此：先重读 DB；若 DB 里 expires_at 仍有效，直接用 DB 的 token
    // 更新本进程缓存，跳过 refresh 调用。
    await this.loadTokensFromDb();

    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.accessToken;
    }

    if (tokenCache?.refreshToken) {
      const config = await this.getConfig();
      try {
        const refreshed = await refreshAccessToken(
          config.baseUrl,
          tokenCache.refreshToken
        );
        // 触发异步持久化（不阻塞当前请求）
        this.persistTokensAsync(refreshed);
        return refreshed.accessToken;
      } catch (err) {
        // refresh_token 失效 / 被吊销 / 配置变更 —— 清干净后让用户重新授权，
        // 否则下一次请求会读到同一份失效 token，永远走不通。
        cloudreveLogger.error(
          { source: 'on_demand', err: serializeError(err) },
          '[Cloudreve] refresh_token 失效，清除持久化 token'
        );
        logSystemEvent(
          'admin.cloudreve.refresh.failed',
          JSON.stringify({
            source: 'on_demand',
            error: err instanceof Error ? err.message : String(err),
          })
        );
        await clearPersistedTokens().catch((cleanupErr) => {
          cloudreveLogger.error(
            { err: serializeError(cleanupErr) },
            '[Cloudreve] 清除失效 token 失败'
          );
        });
        throw new Error(
          'Cloudreve 授权已失效，请在管理面板重新授权'
        );
      }
    }

    throw new Error(
      'Cloudreve 未授权：请在管理面板完成 OAuth 授权'
    );
  }

  /**
   * 异步将刷新后的 token 持久化到数据库（加密存储）。
   * access_token / refresh_token 走 ENCRYPTION_KEY AES-GCM，
   * 与 LlmProvider.apiKey 同一加密体系，DB dump 也无法直接读出。
   */
  private persistTokensAsync(tokens: CloudreveTokenSet) {
    const entries = [
      { key: 'cloudreve_access_token', value: encrypt(tokens.accessToken) },
      { key: 'cloudreve_refresh_token', value: encrypt(tokens.refreshToken) },
      { key: 'cloudreve_token_expires_at', value: String(tokens.expiresAt) },
    ];

    prisma
      .$transaction(
        entries.map((entry) =>
          prisma.siteSetting.upsert({
            where: { key: entry.key },
            update: { value: entry.value },
            create: entry,
          })
        )
      )
      .catch((err) => {
        cloudreveLogger.error(
          { err: serializeError(err) },
          '[Cloudreve] token 持久化失败 —— 下次 refresh 仍会用旧 token，可能因 rotation 而失效'
        );
      });
  }

  /**
   * 从数据库加载 token 到内存缓存。
   * 自动处理向后兼容：旧版本写入的是明文 token（无 enc: 前缀），
   * 此处用 decrypt() 兼容读取，下次刷新时会以加密形式重写回去。
   */
  private async loadTokensFromDb(): Promise<void> {
    try {
      const rows = await prisma.siteSetting.findMany({
        where: { key: { in: [...TOKEN_DB_KEYS] } },
      });

      const map = new Map(rows.map((r) => [r.key, r.value] as const));
      const accessTokenRaw = map.get('cloudreve_access_token');
      const refreshTokenRaw = map.get('cloudreve_refresh_token');
      const expiresAtRaw = map.get('cloudreve_token_expires_at');

      if (!refreshTokenRaw) {
        return;
      }

      let accessToken = '';
      let refreshToken = '';
      try {
        accessToken = accessTokenRaw ? decrypt(accessTokenRaw) : '';
        refreshToken = decrypt(refreshTokenRaw);
      } catch (err) {
        cloudreveLogger.error(
          { err: serializeError(err) },
          '[Cloudreve] token 解密失败，可能 ENCRYPTION_KEY 不匹配'
        );
        logSystemEvent(
          'admin.cloudreve.token.decrypt_failed',
          JSON.stringify({
            source: 'on_demand',
            hint: 'ENCRYPTION_KEY mismatch suspected',
          })
        );
        // 解密失败：把无效记录清掉，让管理员重新授权，避免持续报错
        await clearPersistedTokens().catch(() => {});
        return;
      }

      const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : 0;
      tokenCache = {
        accessToken,
        refreshToken,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      };

      // 兼容老数据：如果 DB 里存的是明文（没有 enc: 前缀），
      // 主动加密重写一次，无需用户重新授权。
      const needsRewrite =
        (accessTokenRaw && !isEncrypted(accessTokenRaw)) ||
        (refreshTokenRaw && !isEncrypted(refreshTokenRaw));
      if (needsRewrite) {
        this.persistTokensAsync(tokenCache);
      }
    } catch (err) {
      cloudreveLogger.error(
        { err: serializeError(err) },
        '[Cloudreve] 从数据库恢复 token 失败'
      );
    }
  }

  /**
   * 带认证头的 fetch 封装
   */
  private async authedFetch(
    urlPath: string,
    init?: RequestInit
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const config = await this.getConfig();
    const url = `${config.baseUrl}${urlPath}`;
    return fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }

  buildRemotePath(
    userId: string,
    category: StorageCategory,
    fileName: string
  ): string {
    return buildCloudreveRemotePath(userId, category, fileName);
  }

  /**
   * 将远程路径转换为 Cloudreve V4 File URI
   * 远程路径: /{userId}/{category}/{fileName}
   * File URI: cloudreve://my/{userId}/{category}/{fileName}
   */
  private toFileUri(remotePath: string): string {
    const safePath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
    return `cloudreve://my${safePath}`;
  }

  /**
   * 确保目录存在（V4: POST /api/v4/file/create）
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    const uri = this.toFileUri(dirPath);
    try {
      const response = await this.authedFetch('/api/v4/file/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uri,
          type: 'folder',
          err_on_conflict: false,
        }),
      });
      // V4 统一返回 200，通过 code 判断
      if (!response.ok) {
        cloudreveLogger.warn(
          { dirPath, status: response.status },
          '[Cloudreve] 创建目录非 2xx 响应'
        );
      }
    } catch {
      // 忽略目录创建错误，上传时会自动创建父目录
    }
  }

  /**
   * 上传文件：小文件使用 PUT /api/v4/file/content 直传，
   * 大文件使用 V4 三步分片上传流程。
   */
  async upload(
    userId: string,
    category: StorageCategory,
    fileName: string,
    data: Buffer | string
  ): Promise<string> {
    const remotePath = this.buildRemotePath(userId, category, fileName);
    const fileUri = this.toFileUri(remotePath);
    const dirPath = `/${sanitizePath(userId)}/${category}`;

    await this.ensureDirectory(dirPath);

    const bodyBytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);

    // 小文件（< 20MB）使用 PUT /api/v4/file/content 直接写入
    const DIRECT_UPLOAD_THRESHOLD = 20 * 1024 * 1024;
    if (bodyBytes.byteLength < DIRECT_UPLOAD_THRESHOLD) {
      return this.uploadDirect(fileUri, bodyBytes, remotePath);
    }

    // 大文件走分片上传
    return this.uploadChunked(fileUri, bodyBytes, fileName, remotePath);
  }

  /**
   * 小文件直传：PUT /api/v4/file/content?uri=...
   */
  private async uploadDirect(
    fileUri: string,
    bodyBytes: Uint8Array,
    remotePath: string
  ): Promise<string> {
    const response = await this.authedFetch(
      `/api/v4/file/content?uri=${encodeURIComponent(fileUri)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bodyBytes.byteLength),
        },
        body: Buffer.from(bodyBytes),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Cloudreve 文件直传失败 (${response.status}): ${errorText}`
      );
    }

    const result = await response.json();
    if (result.code !== 0) {
      throw new Error(`Cloudreve 文件直传失败: [${result.code}] ${result.msg}`);
    }

    return remotePath;
  }

  /**
   * 大文件分片上传（V4 三步流程）
   */
  private async uploadChunked(
    fileUri: string,
    bodyBytes: Uint8Array,
    fileName: string,
    remotePath: string
  ): Promise<string> {
    // 步骤 1：创建上传会话 PUT /api/v4/file/upload
    const sessionResponse = await this.authedFetch('/api/v4/file/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri: fileUri,
        size: bodyBytes.byteLength,
        mime_type: guessMimeType(fileName),
      }),
    });

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text().catch(() => sessionResponse.statusText);
      throw new Error(
        `Cloudreve 上传会话创建失败 (${sessionResponse.status}): ${errorText}`
      );
    }

    const sessionResult: CloudreveApiResponse<{
      session_id: string;
      chunk_size: number;
      upload_urls: string[] | null;
      credential?: string;
    }> = await sessionResponse.json();

    const session = assertApiSuccess(sessionResult, '上传会话创建');
    const chunkSize = session.chunk_size || bodyBytes.byteLength;
    const totalChunks = Math.ceil(bodyBytes.byteLength / chunkSize);

    // 步骤 2：上传分片
    // 本地存储：upload_urls 为空，使用 POST /api/v4/file/upload/{sessionId}/{index}
    // S3 等：upload_urls 包含预签名 URL
    const hasUploadUrls = session.upload_urls && session.upload_urls.length > 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, bodyBytes.byteLength);
      const chunk = bodyBytes.slice(start, end);

      let fullUrl: string;
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(chunk.byteLength),
      };

      if (hasUploadUrls) {
        // S3/OSS 等外部存储：使用预签名 URL
        const uploadUrl = session.upload_urls![i] ?? session.upload_urls![0];
        const config = await this.getConfig();
        fullUrl = uploadUrl.startsWith('http')
          ? uploadUrl
          : `${config.baseUrl}${uploadUrl}`;
      } else {
        // 本地存储：POST /api/v4/file/upload/{sessionId}/{index}
        const config = await this.getConfig();
        fullUrl = `${config.baseUrl}/api/v4/file/upload/${session.session_id}/${i}`;
        const token = await this.getAccessToken();
        headers['Authorization'] = `Bearer ${token}`;
      }

      // 使用 credential 作为认证（远程存储节点）
      if (session.credential && hasUploadUrls) {
        headers['Authorization'] = `Bearer ${session.credential}`;
      } else if (!headers['Authorization']) {
        const token = await this.getAccessToken();
        headers['Authorization'] = `Bearer ${token}`;
      }

      const chunkResponse = await fetch(fullUrl, {
        method: 'POST',
        headers,
        body: chunk,
      });

      if (!chunkResponse.ok) {
        const errorText = await chunkResponse.text().catch(() => chunkResponse.statusText);
        throw new Error(
          `Cloudreve 分片上传失败 (chunk ${i + 1}/${totalChunks}, ${chunkResponse.status}): ${errorText}`
        );
      }
    }

    return remotePath;
  }

  /** 下载文件（V4） */
  async download(
    userId: string,
    category: StorageCategory,
    fileName: string
  ): Promise<Buffer> {
    const remotePath = this.buildRemotePath(userId, category, fileName);
    return this.downloadByRemotePath(remotePath, userId);
  }

  async downloadByRemotePath(
    remotePath: string,
    expectedUserId?: string
  ): Promise<Buffer> {
    const safeRemotePath = validateRemotePath(remotePath, expectedUserId);
    const fileUri = this.toFileUri(safeRemotePath);

    // V4: POST /api/v4/file/url 获取签名下载链接
    const response = await this.authedFetch('/api/v4/file/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uris: [fileUri],
        download: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Cloudreve 获取下载链接失败 (${response.status}): ${errorText}`
      );
    }

    const result: CloudreveApiResponse<{
      urls: Array<{ url: string; stream_saver_display_name?: string }>;
      expires?: string;
    }> = await response.json();

    const downloadData = assertApiSuccess(result, '获取下载链接');

    if (!downloadData.urls || downloadData.urls.length === 0 || !downloadData.urls[0].url) {
      throw new Error('Cloudreve 未返回下载链接');
    }

    const downloadUrl = downloadData.urls[0].url;
    const fileResponse = await fetch(downloadUrl);
    if (!fileResponse.ok) {
      throw new Error(`Cloudreve 文件下载失败 (${fileResponse.status})`);
    }

    return Buffer.from(await fileResponse.arrayBuffer());
  }
}

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4',
    '.m4a': 'audio/mp4',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}
