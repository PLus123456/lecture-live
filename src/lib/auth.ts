import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { JWT_SECRET } from '@/lib/serverSecrets';
import { getRedisClient } from '@/lib/redis';
import {
  normalizeUserRole,
  resolveRoleQuotas,
  resolveRoleStorageBytesLimit,
} from '@/lib/userRoles';
import { getNextQuotaResetAt } from '@/lib/billing';

const DEFAULT_JWT_EXPIRY_DAYS = 7;
const COOKIE_NAME = 'lecture-live-token';
const ABSOLUTE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BLACKLIST_PREFIX = 'auth:blacklist:';
// 刷新幂等宽限窗：旧 jti 被 rotate 后，把「旧 jti → 刚 rotate 出的新原始 token」
// 短暂记一份。并发第二个 Tab（丢包、或还没收到新 cookie）带着刚 rotate 的旧 jti 再来刷新时，
// 返回同一个新 token 而非 401——两个 Tab 收敛到同一个 cookie。
// 宽限窗一过记录即失效，旧 jti 仍在黑名单里（TTL=剩余寿命），重放保护完全不变。
// 返回前对新 token 走一次完整 verifyAuthToken（签名/绝对上限/黑名单/tokenVersion/status），
// 故改密/封禁/版本递增的即时吊销一律不受宽限影响。
const TOKEN_REFRESH_GRACE_PREFIX = 'auth:refresh-grace:';
const TOKEN_REFRESH_GRACE_TTL_MS = 30 * 1000;
export const CLIENT_SESSION_TOKEN = '__cookie_session__';
const DUMMY_PASSWORD_HASH =
  '$2a$12$l8o61N0Huak0dRlwugeWR.BFVvNTyaqygzfgFHhPLBBEPtvQY9z..';

// 用户不存在时用于恒定时间比较的哑 hash。真实用户 hash 的 cost = siteSettings.bcrypt_rounds；
// 若哑 hash（固定 cost 12）与之不一致，bcrypt.compare 的耗时差异会重新暴露"账号是否存在"的侧信道。
// 故按 rounds 缓存一份 cost 匹配的哑 hash（每个 rounds 值只生成一次）。
const dummyHashByRounds = new Map<number, string>();
function getDummyPasswordHash(rounds?: number): string {
  if (rounds == null || rounds === 12) return DUMMY_PASSWORD_HASH;
  let h = dummyHashByRounds.get(rounds);
  if (!h) {
    h = bcrypt.hashSync('lecture-live-dummy-password', rounds);
    dummyHashByRounds.set(rounds, h);
  }
  return h;
}

interface TokenBlacklistEntry {
  expiresAt: number;
}

const TOKEN_BLACKLIST_STORE_KEY = '__lectureLiveTokenBlacklistStore';

type TokenBlacklistGlobal = typeof globalThis & {
  [TOKEN_BLACKLIST_STORE_KEY]?: Map<string, TokenBlacklistEntry>;
};

interface RefreshGraceEntry {
  token: string;
  expiresAt: number;
}

const TOKEN_REFRESH_GRACE_STORE_KEY = '__lectureLiveTokenRefreshGraceStore';

type TokenRefreshGraceGlobal = typeof globalThis & {
  [TOKEN_REFRESH_GRACE_STORE_KEY]?: Map<string, RefreshGraceEntry>;
};

export interface UserPayload {
  id: string;
  email: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
}

export interface AuthTokenPayload extends jwt.JwtPayload, UserPayload {
  tokenVersion: number;
  sessionStartedAt: number;
  jti: string;
}

export interface AuthSession {
  user: UserPayload;
  token: AuthTokenPayload;
  rawToken: string;
}

type TokenUserPayload = UserPayload & {
  tokenVersion: number;
};

// --------------- Password validation ---------------

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128; // bcrypt 截断到 72 字节，128 字符留足余量

/**
 * 校验密码强度：
 * - 长度 8~128
 * - 至少包含一个字母和一个数字
 * 返回错误消息或 null（通过）
 */
export function validatePassword(
  password: string,
  options?: {
    minLength?: number;
  }
): string | null {
  if (typeof password !== 'string') {
    return '密码格式无效';
  }
  const minLength = Math.max(
    PASSWORD_MIN_LENGTH,
    Math.min(PASSWORD_MAX_LENGTH, options?.minLength ?? PASSWORD_MIN_LENGTH)
  );
  if (password.length < minLength) {
    return `密码至少 ${minLength} 个字符`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`;
  }
  if (!/[a-zA-Z]/.test(password)) {
    return '密码必须包含至少一个字母';
  }
  if (!/\d/.test(password)) {
    return '密码必须包含至少一个数字';
  }
  return null;
}

// --------------- Token helpers ---------------

function isClientSessionToken(token: string): boolean {
  return token === CLIENT_SESSION_TOKEN;
}

function getTokenBlacklistStore(): Map<string, TokenBlacklistEntry> {
  const globalState = globalThis as TokenBlacklistGlobal;
  if (!globalState[TOKEN_BLACKLIST_STORE_KEY]) {
    globalState[TOKEN_BLACKLIST_STORE_KEY] = new Map<string, TokenBlacklistEntry>();
  }
  return globalState[TOKEN_BLACKLIST_STORE_KEY] as Map<string, TokenBlacklistEntry>;
}

function pruneExpiredBlacklistedTokens(store: Map<string, TokenBlacklistEntry>) {
  const now = Date.now();
  store.forEach((entry, jti) => {
    if (entry.expiresAt <= now) {
      store.delete(jti);
    }
  });
}

function getTokenExpiryDate(payload: AuthTokenPayload): Date {
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    return new Date(payload.exp * 1000);
  }
  return new Date(Date.now() + DEFAULT_JWT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

function isValidRole(role: unknown): role is UserPayload['role'] {
  return role === 'ADMIN' || role === 'PRO' || role === 'FREE';
}

function isValidTokenPayload(payload: unknown): payload is AuthTokenPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Partial<AuthTokenPayload>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.email === 'string' &&
    isValidRole(candidate.role) &&
    Number.isInteger(candidate.tokenVersion) &&
    typeof candidate.sessionStartedAt === 'number' &&
    Number.isFinite(candidate.sessionStartedAt) &&
    typeof candidate.jti === 'string' &&
    candidate.jti.length > 0
  );
}

async function isTokenRevoked(jti: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      const exists = await redis.exists(`${TOKEN_BLACKLIST_PREFIX}${jti}`);
      return exists === 1;
    } catch {
      // Fall back to in-memory blacklist when Redis is unavailable.
    }
  }

  const store = getTokenBlacklistStore();
  pruneExpiredBlacklistedTokens(store);
  const entry = store.get(jti);
  if (!entry) {
    return false;
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(jti);
    return false;
  }

  return true;
}

export async function revokeToken(
  payload: Pick<AuthTokenPayload, 'jti' | 'exp'>
): Promise<void> {
  const expiresAt = getTokenExpiryDate(payload as AuthTokenPayload).getTime();
  const ttlSeconds = Math.max(
    1,
    Math.ceil((expiresAt - Date.now()) / 1000)
  );

  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      await redis.set(
        `${TOKEN_BLACKLIST_PREFIX}${payload.jti}`,
        '1',
        'EX',
        ttlSeconds
      );
      return;
    } catch {
      // Fall back to in-memory blacklist when Redis is unavailable.
    }
  }

  const store = getTokenBlacklistStore();
  pruneExpiredBlacklistedTokens(store);
  store.set(payload.jti, { expiresAt });
}

// --------------- Refresh idempotency (grace window) ---------------

function getRefreshGraceStore(): Map<string, RefreshGraceEntry> {
  const globalState = globalThis as TokenRefreshGraceGlobal;
  if (!globalState[TOKEN_REFRESH_GRACE_STORE_KEY]) {
    globalState[TOKEN_REFRESH_GRACE_STORE_KEY] = new Map<string, RefreshGraceEntry>();
  }
  return globalState[TOKEN_REFRESH_GRACE_STORE_KEY] as Map<string, RefreshGraceEntry>;
}

function pruneExpiredGraceEntries(store: Map<string, RefreshGraceEntry>) {
  const now = Date.now();
  store.forEach((entry, jti) => {
    if (entry.expiresAt <= now) {
      store.delete(jti);
    }
  });
}

/**
 * 记录一次刷新 rotation：旧 jti → 刚 rotate 出的新原始 token，短 TTL（默认 30s）。
 * 仅用于让并发/丢包的第二个 Tab 幂等拿到同一个新 token；不影响任何吊销逻辑。
 * Redis 优先，不可用时回落进程内存（与黑名单同构）。
 */
export async function recordRefreshGrace(
  oldJti: string,
  newToken: string
): Promise<void> {
  const ttlSeconds = Math.ceil(TOKEN_REFRESH_GRACE_TTL_MS / 1000);

  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      await redis.set(
        `${TOKEN_REFRESH_GRACE_PREFIX}${oldJti}`,
        newToken,
        'EX',
        ttlSeconds
      );
      return;
    } catch {
      // Fall back to in-memory grace store when Redis is unavailable.
    }
  }

  const store = getRefreshGraceStore();
  pruneExpiredGraceEntries(store);
  store.set(oldJti, {
    token: newToken,
    expiresAt: Date.now() + TOKEN_REFRESH_GRACE_TTL_MS,
  });
}

/**
 * 查一个（已被 rotate 的）旧 jti 是否有仍在宽限窗内的新 token。
 * 命中返回该新原始 token（调用方仍需对它走完整 verifyAuthToken 再放行）；
 * 未命中/已过期返回 null。
 */
export async function lookupRefreshGrace(oldJti: string): Promise<string | null> {
  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      return await redis.get(`${TOKEN_REFRESH_GRACE_PREFIX}${oldJti}`);
    } catch {
      // Fall back to in-memory grace store when Redis is unavailable.
    }
  }

  const store = getRefreshGraceStore();
  pruneExpiredGraceEntries(store);
  const entry = store.get(oldJti);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    store.delete(oldJti);
    return null;
  }
  return entry.token;
}

export function extractTokenFromCookieHeader(
  cookieHeader: string | null | undefined
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`)
  );
  return match?.[1] ?? null;
}

/** Extract token from Authorization header OR cookie */
export function extractToken(req: Request): string | null {
  // 1. Try Authorization header first
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (!isClientSessionToken(bearerToken)) {
      return bearerToken;
    }
  }
  // 2. Fallback to cookie
  return extractTokenFromCookieHeader(req.headers.get('Cookie'));
}

async function verifyToken(token: string): Promise<AuthSession | null> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as AuthTokenPayload;
    if (!isValidTokenPayload(decoded)) {
      return null;
    }

    if (decoded.sessionStartedAt + ABSOLUTE_SESSION_LIFETIME_MS < Date.now()) {
      return null;
    }

    if (await isTokenRevoked(decoded.jti)) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        role: true,
        tokenVersion: true,
        status: true,
      },
    });

    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return null;
    }

    // 被禁用用户（status !== 1）的旧 token 立即失效——一处生效全域。
    if (user.status !== 1) {
      return null;
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      token: decoded,
      rawToken: token,
    };
  } catch {
    return null;
  }
}

/**
 * 只校验签名、载荷结构与绝对上限，返回 jti——不查黑名单、不查 DB。
 * 用于刷新幂等：当 verifyAuthSession 因「旧 jti 已入黑名单」而拒绝时，
 * 仍需拿到这个（真实签发过的）jti 去查宽限记录。伪造/过期/篡改 token 一律返回 null，
 * 故不会放宽任何伪造保护——攻击者没有签名密钥就构造不出匹配的 jti。
 */
export function peekTokenJti(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
    }) as AuthTokenPayload;
    if (!isValidTokenPayload(decoded)) {
      return null;
    }
    if (decoded.sessionStartedAt + ABSOLUTE_SESSION_LIFETIME_MS < Date.now()) {
      return null;
    }
    return decoded.jti;
  } catch {
    return null;
  }
}

/** Verify JWT and return session data, reading from header or cookie */
export async function verifyAuthSession(req: Request): Promise<AuthSession | null> {
  const token = extractToken(req);
  if (!token) {
    return null;
  }

  return verifyToken(token);
}

/** Verify JWT and return user payload, reading from header or cookie */
export async function verifyAuth(req: Request): Promise<UserPayload | null> {
  const session = await verifyAuthSession(req);
  return session?.user ?? null;
}

/** Verify a raw JWT token string */
export async function verifyAuthToken(token: string): Promise<AuthSession | null> {
  if (!token || isClientSessionToken(token)) {
    return null;
  }

  return verifyToken(token);
}

/** Sign a new JWT for the given user payload */
export function signToken(
  payload: TokenUserPayload,
  options?: {
    sessionStartedAt?: number;
    jti?: string;
    expiresInDays?: number;
  }
): string {
  const sessionStartedAt = options?.sessionStartedAt ?? Date.now();
  const days = options?.expiresInDays ?? DEFAULT_JWT_EXPIRY_DAYS;
  return jwt.sign(
    {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      tokenVersion: payload.tokenVersion,
      sessionStartedAt,
      jti: options?.jti ?? crypto.randomUUID(),
    },
    JWT_SECRET,
    { expiresIn: `${days}d` }
  );
}

/** 获取 JWT 过期天数和对应的 Cookie maxAge */
export function getJwtExpiryConfig(jwtExpiryDays?: number) {
  // 会话最长绝对存活 = ABSOLUTE_SESSION_LIFETIME_MS（30 天，verifyToken 硬性拦截）；
  // admin 把 jwt_expiry 配到更大（可达 365 天）只会让 JWT exp/cookie maxAge 与真实存活期不符、
  // 误导用户。这里把生效值钳到绝对上限，让 cookie/JWT 与实际登出时机一致。
  const absoluteDays = ABSOLUTE_SESSION_LIFETIME_MS / (24 * 60 * 60 * 1000);
  const days = Math.min(jwtExpiryDays ?? DEFAULT_JWT_EXPIRY_DAYS, absoluteDays);
  return {
    expiresInDays: days,
    cookieMaxAge: days * 24 * 60 * 60,
  };
}

// --------------- Cookie helpers ---------------

/** Set HttpOnly auth cookie on a NextResponse */
export function setAuthCookie(
  response: NextResponse,
  token: string,
  options?: { maxAge?: number }
): NextResponse {
  const isProduction = process.env.NODE_ENV === 'production';
  const maxAge = options?.maxAge ?? DEFAULT_JWT_EXPIRY_DAYS * 24 * 60 * 60;
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,                     // JS 不可读，防 XSS
    secure: isProduction,               // 生产环境仅 HTTPS
    sameSite: 'lax',                    // 防 CSRF（阻止跨站 POST 携带 cookie）
    path: '/',                          // 全站可用
    maxAge,
  });
  return response;
}

/** Clear auth cookie (logout) — 双重清除确保兼容性 */
export function clearAuthCookie(response: NextResponse): NextResponse {
  // 同时设置 maxAge=0 和 expires 为过去时间，确保所有浏览器都能正确删除 cookie
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0), // 1970-01-01，确保立即过期
  });
  return response;
}

/** Get cookie name (for middleware to read) */
export function getAuthCookieName(): string {
  return COOKIE_NAME;
}

// --------------- Auth operations ---------------

export async function register(email: string, password: string, displayName: string) {
  return registerWithOptions(email, password, displayName);
}

export async function registerWithOptions(
  email: string,
  password: string,
  displayName: string,
  options?: {
    role?: UserPayload['role'];
    bcryptRounds?: number;
    jwtExpiryDays?: number;
  }
) {
  const role = normalizeUserRole(options?.role, 'FREE');
  const passwordHash = await bcrypt.hash(password, options?.bcryptRounds ?? 12);
  // U46：转录/存储/模型配额按角色从 SiteSetting.group_config_<role> 解析（缺失回落硬编码默认），
  // 字节上限同样从 SiteSetting 解析（覆盖 schema 默认 100MB），让 admin 的用户组配置对新用户真正生效。
  const [quotas, storageBytesLimit] = await Promise.all([
    resolveRoleQuotas(role),
    resolveRoleStorageBytesLimit(role),
  ]);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName,
      role,
      quotaResetAt: getNextQuotaResetAt(),
      ...quotas,
      storageBytesLimit,
    },
  });
  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  }, { expiresInDays: options?.jwtExpiryDays });
  return { user, token };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  options?: {
    bcryptRounds?: number;
  }
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new Error('Current password is incorrect');
  }
  const passwordHash = await bcrypt.hash(newPassword, options?.bcryptRounds ?? 12);
  return prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      tokenVersion: { increment: 1 },
    },
    select: {
      id: true,
      email: true,
      role: true,
      tokenVersion: true,
    },
  });
}

export async function login(
  email: string,
  password: string,
  options?: { jwtExpiryDays?: number; bcryptRounds?: number }
) {
  const user = await prisma.user.findUnique({ where: { email } });

  // 用户不存在时也执行一次固定成本的 bcrypt.compare，避免账户枚举时间侧信道。
  // 哑 hash 的 cost 需与当前 bcrypt_rounds 匹配，否则耗时差异仍会泄露账号是否存在。
  const passwordMatches = await bcrypt.compare(
    password,
    user?.passwordHash ?? getDummyPasswordHash(options?.bcryptRounds)
  );

  if (!user || !passwordMatches) {
    throw new Error('Invalid credentials');
  }
  // 被禁用用户（status !== 1）即使密码正确也不得登录；复用同一错误避免账户枚举侧信道
  // （不向调用方泄露"该账号存在但被封"）。verifyToken 同步拦截其旧 token。
  if (user.status !== 1) {
    throw new Error('Invalid credentials');
  }
  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  }, { expiresInDays: options?.jwtExpiryDays });
  return { user, token };
}
