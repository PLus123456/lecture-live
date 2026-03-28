import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { JWT_SECRET } from '@/lib/serverSecrets';
import { getRedisClient } from '@/lib/redis';
import { getDefaultQuotasForRole, normalizeUserRole } from '@/lib/userRoles';
import { getNextQuotaResetAt } from '@/lib/billing';

const DEFAULT_JWT_EXPIRY_DAYS = 7;
const COOKIE_NAME = 'lecture-live-token';
const ABSOLUTE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BLACKLIST_PREFIX = 'auth:blacklist:';
export const CLIENT_SESSION_TOKEN = '__cookie_session__';
const DUMMY_PASSWORD_HASH =
  '$2a$12$l8o61N0Huak0dRlwugeWR.BFVvNTyaqygzfgFHhPLBBEPtvQY9z..';

interface TokenBlacklistEntry {
  expiresAt: number;
}

const TOKEN_BLACKLIST_STORE_KEY = '__lectureLiveTokenBlacklistStore';

type TokenBlacklistGlobal = typeof globalThis & {
  [TOKEN_BLACKLIST_STORE_KEY]?: Map<string, TokenBlacklistEntry>;
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
      },
    });

    if (!user || user.tokenVersion !== decoded.tokenVersion) {
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
  const days = jwtExpiryDays ?? DEFAULT_JWT_EXPIRY_DAYS;
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
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName,
      role,
      quotaResetAt: getNextQuotaResetAt(),
      ...getDefaultQuotasForRole(role),
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
  options?: { jwtExpiryDays?: number }
) {
  const user = await prisma.user.findUnique({ where: { email } });

  // 用户不存在时也执行一次固定成本的 bcrypt.compare，避免账户枚举时间侧信道。
  const passwordMatches = await bcrypt.compare(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH
  );

  if (!user || !passwordMatches) {
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
