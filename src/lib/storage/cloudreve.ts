// src/lib/storage/cloudreve.ts
// Cloudreve V4 OAuth 应用集成

import path from 'path';
import { getSiteSettings } from '@/lib/siteSettings';
import { sanitizePath } from '@/lib/security';

const STORAGE_CATEGORIES = ['recordings', 'transcripts', 'summaries', 'reports'] as const;
const DEFAULT_CLOUDREVE_OAUTH_SCOPE = 'offline_access Files.Read Files.Write';

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

interface CloudreveOAuthConfigSource {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

/** 内存中的 token 缓存 */
let tokenCache: CloudreveTokenSet | null = null;

/* ------------------------------------------------------------------ */
/*  公共判断函数                                                       */
/* ------------------------------------------------------------------ */

/**
 * 判断 Cloudreve V4 OAuth 是否已配置（client_id + client_secret + base_url）
 */
export async function isCloudreveConfigured(): Promise<boolean> {
  return Boolean(await resolveCloudreveOAuthConfigSource());
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

function trimConfigValue(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

async function resolveCloudreveOAuthConfigSource(): Promise<CloudreveOAuthConfigSource | null> {
  const envConfig = {
    baseUrl: trimConfigValue(process.env.CLOUDREVE_BASE_URL),
    clientId: trimConfigValue(process.env.CLOUDREVE_CLIENT_ID),
    clientSecret: trimConfigValue(process.env.CLOUDREVE_CLIENT_SECRET),
  };

  if (envConfig.baseUrl && envConfig.clientId && envConfig.clientSecret) {
    return envConfig;
  }

  try {
    const settings = await getSiteSettings();
    const siteConfig = {
      baseUrl: trimConfigValue(settings.cloudreve_url),
      clientId: trimConfigValue(settings.cloudreve_client_id),
      clientSecret: trimConfigValue(settings.cloudreve_client_secret),
    };

    if (
      settings.storage_mode === 'cloudreve' &&
      siteConfig.baseUrl &&
      siteConfig.clientId &&
      siteConfig.clientSecret
    ) {
      return siteConfig;
    }
  } catch {
    return null;
  }

  return null;
}

async function getCloudreveOAuthConfig(): Promise<CloudreveOAuthConfig> {
  const source = await resolveCloudreveOAuthConfigSource();
  if (!source) {
    throw new Error('Cloudreve OAuth 未配置');
  }

  return {
    baseUrl: validateCloudreveBaseUrl(source.baseUrl),
    clientId: source.clientId,
    clientSecret: source.clientSecret,
  };
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
  const { baseUrl, clientId } = await getCloudreveOAuthConfig();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
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
  const { baseUrl, clientId, clientSecret } = await getCloudreveOAuthConfig();

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
  const payload = data.data ?? data;

  const tokenSet: CloudreveTokenSet = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: resolveExpiresAt(payload, ['expires_in', 'access_expires']),
  };

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
  const payload = data.data ?? data;

  const tokenSet: CloudreveTokenSet = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? currentRefreshToken,
    expiresAt: resolveExpiresAt(payload, ['access_expires', 'expires_in']),
  };

  tokenCache = tokenSet;
  return tokenSet;
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
 * 清除缓存的 token
 */
export function clearCachedTokens() {
  tokenCache = null;
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
  private config: CloudreveOAuthConfig | null = null;

  private async getConfig(): Promise<CloudreveOAuthConfig> {
    if (this.config) {
      return this.config;
    }

    this.config = await getCloudreveOAuthConfig();
    return this.config;
  }

  /**
   * 获取有效的 access_token，必要时自动从数据库恢复或刷新
   */
  private async getAccessToken(): Promise<string> {
    // 缓存中有且未过期（预留 60s 缓冲）
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.accessToken;
    }

    // 有 refresh_token 则刷新
    if (tokenCache?.refreshToken) {
      const config = await this.getConfig();
      const refreshed = await refreshAccessToken(
        config.baseUrl,
        tokenCache.refreshToken
      );
      // 触发异步持久化（不阻塞当前请求）
      this.persistTokensAsync(refreshed);
      return refreshed.accessToken;
    }

    // 尝试从数据库恢复 token
    await this.loadTokensFromDb();

    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.accessToken;
    }

    if (tokenCache?.refreshToken) {
      const config = await this.getConfig();
      const refreshed = await refreshAccessToken(
        config.baseUrl,
        tokenCache.refreshToken
      );
      this.persistTokensAsync(refreshed);
      return refreshed.accessToken;
    }

    throw new Error(
      'Cloudreve 未授权：请在管理面板完成 OAuth 授权'
    );
  }

  /**
   * 异步将刷新后的 token 持久化到数据库
   */
  private persistTokensAsync(tokens: CloudreveTokenSet) {
    // 动态导入避免循环依赖
    import('@/lib/prisma').then(({ prisma }) => {
      const entries = [
        { key: 'cloudreve_access_token', value: tokens.accessToken },
        { key: 'cloudreve_refresh_token', value: tokens.refreshToken },
        { key: 'cloudreve_token_expires_at', value: String(tokens.expiresAt) },
      ];
      return prisma.$transaction(
        entries.map((entry) =>
          prisma.siteSetting.upsert({
            where: { key: entry.key },
            update: { value: entry.value },
            create: entry,
          })
        )
      );
    }).catch((err) => {
      console.error('[Cloudreve] token 持久化失败:', err);
    });
  }

  /**
   * 从数据库加载 token 到内存缓存
   */
  private async loadTokensFromDb(): Promise<void> {
    try {
      const { prisma } = await import('@/lib/prisma');
      const keys = ['cloudreve_access_token', 'cloudreve_refresh_token', 'cloudreve_token_expires_at'];
      const rows = await prisma.siteSetting.findMany({
        where: { key: { in: keys } },
      });

      const map = new Map(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
      const accessToken = map.get('cloudreve_access_token');
      const refreshToken = map.get('cloudreve_refresh_token');
      const expiresAt = map.get('cloudreve_token_expires_at');

      if (refreshToken) {
        tokenCache = {
          accessToken: accessToken ?? '',
          refreshToken,
          expiresAt: expiresAt ? Number(expiresAt) : 0,
        };
      }
    } catch (err) {
      console.error('[Cloudreve] 从数据库恢复 token 失败:', err);
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
   * 确保目录存在
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    const uri = this.toFileUri(dirPath);
    try {
      const response = await this.authedFetch('/api/v4/directory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri }),
      });
      // 目录已存在也是正常的
      if (!response.ok && response.status !== 409) {
        console.warn(`[Cloudreve] 创建目录 ${dirPath} 返回: ${response.status}`);
      }
    } catch {
      // 忽略目录创建错误，后续上传时 V4 也会自动创建
    }
  }

  /** 上传文件（V4 分片上传流程） */
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

    // 步骤 1：创建上传会话
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
      upload_urls: string[];
      credential?: string;
    }> = await sessionResponse.json();

    const session = assertApiSuccess(sessionResult, '上传会话创建');

    if (session.upload_urls.length === 0) {
      throw new Error('Cloudreve 未返回上传地址');
    }

    // 步骤 2：上传分片
    const chunkSize = session.chunk_size || bodyBytes.byteLength;
    const totalChunks = Math.ceil(bodyBytes.byteLength / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, bodyBytes.byteLength);
      const chunk = bodyBytes.slice(start, end);
      const uploadUrl = session.upload_urls[i] ?? session.upload_urls[0];
      const config = await this.getConfig();

      // upload_url 可能是相对路径或绝对 URL
      const fullUrl = uploadUrl.startsWith('http')
        ? uploadUrl
        : `${config.baseUrl}${uploadUrl}`;

      const token = await this.getAccessToken();
      const chunkResponse = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.byteLength),
        },
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

    // V4: 获取文件内容
    const response = await this.authedFetch(
      `/api/v4/file/content?uri=${encodeURIComponent(fileUri)}`
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Cloudreve 下载失败 (${response.status}): ${errorText}`
      );
    }

    const contentType = response.headers.get('content-type') ?? '';

    // V4 可能返回 JSON（包含下载链接）或直接返回文件内容
    if (contentType.includes('application/json')) {
      const result: CloudreveApiResponse<{ url?: string }> = await response.json();
      const downloadData = assertApiSuccess(result, '获取下载链接');

      if (downloadData.url) {
        const fileResponse = await fetch(downloadData.url);
        if (!fileResponse.ok) {
          throw new Error(`Cloudreve 文件下载失败 (${fileResponse.status})`);
        }
        return Buffer.from(await fileResponse.arrayBuffer());
      }

      throw new Error('Cloudreve 未返回下载链接');
    }

    return Buffer.from(await response.arrayBuffer());
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
