import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
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
// 直接引 tokens 而非 @/lib/email 桶文件：桶会拉进 mailer/模板（含 nodemailer），
// 而 auth 是几乎所有路由的公共依赖，没必要为一句 updateMany 背上整个发信栈。
import { invalidateUserEmailTokens } from '@/lib/email/tokens';
import {
  AUTH_SESSION_BINDING_HEADER,
  CLIENT_SESSION_TOKEN,
} from '@/lib/authProtocol';
export {
  AUTH_SESSION_BINDING_HEADER,
  CLIENT_SESSION_TOKEN,
} from '@/lib/authProtocol';

const DEFAULT_JWT_EXPIRY_DAYS = 7;
const COOKIE_NAME = 'lecture-live-token';
const ABSOLUTE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_SESSION_REVOCATION_CAPABILITY_VERSION = 'v1';
const AUTH_SESSION_REVOCATION_PURPOSE = 'auth-family-revoke';
const AUTH_SESSION_REVOCATION_MAX_LENGTH = 2_048;
const TOKEN_BLACKLIST_PREFIX = 'auth:blacklist:';
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
// 内存黑名单现在是无条件双写的（见 revokeToken），故必须有上界，否则高频登出的站点
// 会在进程里堆积最长 30 天的条目。超限时优先丢「最快过期」的那些——它们离自然失效最近，
// 且 Redis 里仍有同一份记录。
// L8：从 20k 抬到 100k（每条 ≈ 50B → 约 5MB 上界），并在真的驱逐未过期条目时告警，
// 见 pruneExpiredBlacklistedTokens。
const TOKEN_BLACKLIST_MAX_ENTRIES = 100_000;

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
  /** 新令牌必有；升级前签发的 legacy cookie 两项都不存在。 */
  familyId?: string;
  generation?: number;
}

export interface AuthSession {
  user: UserPayload;
  token: AuthTokenPayload;
  rawToken: string;
}

type TokenUserPayload = UserPayload & {
  tokenVersion: number;
};

class AuthVerificationInfrastructureError extends Error {
  constructor() {
    super('Auth verification persistence unavailable');
    this.name = 'AuthVerificationInfrastructureError';
  }
}

export type RotateAuthTokenResult =
  | { status: 'rotated'; token: string }
  | { status: 'reused' };

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

/**
 * L8：超限驱逐会丢掉**尚未过期**的吊销记录 —— Redis 不可用期间，高频登出/刷新
 * 累计超过上限后，部分「已登出」的 token 会在内存黑名单里复活（上限 = 该 JWT 的
 * 剩余寿命，最长 7 天）。
 *
 * 这里做两件事，不改 fail-open 的总体姿态（内存兜底本就是降级态，改成 fail-closed
 * 会让 Redis 抖动直接把全站登出，代价更大 —— 那属于 C4 的范畴，需要单独决策）：
 *  1. 上限抬高一个数量级（条目 ≈ 40B jti + 8B 时间戳，10 万条也就几 MB），
 *     让「撑爆」变成需要真正异常的流量才会发生；
 *  2. **一旦真的驱逐了未过期条目就告警**。原实现是静默的，吊销保护静悄悄失效、
 *     运维完全无从察觉；有这条日志才能被发现并去修 Redis。
 */
const blacklistEvictionLogger = {
  lastWarnAt: 0,
};
const BLACKLIST_EVICTION_WARN_INTERVAL_MS = 60_000;

function pruneExpiredBlacklistedTokens(store: Map<string, TokenBlacklistEntry>) {
  const now = Date.now();
  store.forEach((entry, jti) => {
    if (entry.expiresAt <= now) {
      store.delete(jti);
    }
  });

  if (store.size <= TOKEN_BLACKLIST_MAX_ENTRIES) {
    return;
  }
  const byExpiry = Array.from(store.entries()).sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt
  );
  const evictCount = byExpiry.length - TOKEN_BLACKLIST_MAX_ENTRIES;
  let evictedUnexpired = 0;
  for (let i = 0; i < evictCount; i += 1) {
    // 上面已经清掉所有过期条目，所以这里驱逐的**全部是未过期的**
    if (byExpiry[i][1].expiresAt > now) evictedUnexpired += 1;
    store.delete(byExpiry[i][0]);
  }

  if (
    evictedUnexpired > 0 &&
    now - blacklistEvictionLogger.lastWarnAt >= BLACKLIST_EVICTION_WARN_INTERVAL_MS
  ) {
    blacklistEvictionLogger.lastWarnAt = now;
    console.error(
      `[auth] 内存令牌黑名单超限，已驱逐 ${evictedUnexpired} 条**未过期**的吊销记录 ` +
        `(cap=${TOKEN_BLACKLIST_MAX_ENTRIES})：这些 token 会在剩余寿命内复活。` +
        '请检查 Redis —— 内存黑名单只是 Redis 不可用时的降级兜底。'
    );
  }
}

function getTokenExpiryDate(payload: AuthTokenPayload): Date {
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    return new Date(payload.exp * 1000);
  }
  return new Date(Date.now() + DEFAULT_JWT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

function hashTokenJti(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

function getFamilyExpiryDate(sessionStartedAt: number): Date {
  return new Date(sessionStartedAt + ABSOLUTE_SESSION_LIFETIME_MS);
}

function hasTokenFamily(
  payload: AuthTokenPayload
): payload is AuthTokenPayload & { familyId: string; generation: number } {
  return (
    typeof payload.familyId === 'string' &&
    payload.familyId.length > 0 &&
    Number.isInteger(payload.generation) &&
    (payload.generation as number) >= 0
  );
}

function isValidRole(role: unknown): role is UserPayload['role'] {
  return role === 'ADMIN' || role === 'PRO' || role === 'FREE';
}

function isValidTokenPayload(payload: unknown): payload is AuthTokenPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Partial<AuthTokenPayload>;
  const hasFamilyId = candidate.familyId !== undefined;
  const hasGeneration = candidate.generation !== undefined;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.email === 'string' &&
    isValidRole(candidate.role) &&
    Number.isInteger(candidate.tokenVersion) &&
    typeof candidate.sessionStartedAt === 'number' &&
    Number.isFinite(candidate.sessionStartedAt) &&
    typeof candidate.jti === 'string' &&
    candidate.jti.length > 0 &&
    hasFamilyId === hasGeneration &&
    (!hasFamilyId ||
      (typeof candidate.familyId === 'string' &&
        candidate.familyId.length > 0 &&
        Number.isInteger(candidate.generation) &&
        (candidate.generation as number) >= 0))
  );
}

interface AuthSessionRevocationCapabilityPayload {
  purpose: typeof AUTH_SESSION_REVOCATION_PURPOSE;
  familyId: string;
  userId: string;
  absoluteExpiresAt: number;
}

export type RevokeAuthSessionByBindingResult =
  | {
      status: 'revoked' | 'already_invalid';
      familyId: string;
      userId: string;
    }
  | { status: 'invalid' };

function getAuthSessionRevocationSigningInput(payloadSegment: string): string {
  return `${AUTH_SESSION_REVOCATION_CAPABILITY_VERSION}.${payloadSegment}`;
}

function decodeCanonicalBase64Url(
  value: string,
  maxDecodedBytes: number
): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (
      decoded.length === 0 ||
      decoded.length > maxDecodedBytes ||
      decoded.toString('base64url') !== value
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function parseAuthSessionRevocationCapability(
  binding: string
): AuthSessionRevocationCapabilityPayload | null {
  if (
    typeof binding !== 'string' ||
    binding.length === 0 ||
    binding.length > AUTH_SESSION_REVOCATION_MAX_LENGTH
  ) {
    return null;
  }

  const parts = binding.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== AUTH_SESSION_REVOCATION_CAPABILITY_VERSION
  ) {
    return null;
  }
  const payloadBytes = decodeCanonicalBase64Url(parts[1], 1_024);
  const suppliedMac = decodeCanonicalBase64Url(parts[2], 32);
  if (!payloadBytes || !suppliedMac || suppliedMac.length !== 32) return null;

  const expectedMac = createHmac('sha256', JWT_SECRET)
    .update(getAuthSessionRevocationSigningInput(parts[1]), 'utf8')
    .digest();
  if (!timingSafeEqual(suppliedMac, expectedMac)) return null;

  try {
    const candidate = JSON.parse(payloadBytes.toString('utf8')) as Record<
      string,
      unknown
    >;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }
    const keys = Object.keys(candidate).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== 'absoluteExpiresAt' ||
      keys[1] !== 'familyId' ||
      keys[2] !== 'purpose' ||
      keys[3] !== 'userId' ||
      candidate.purpose !== AUTH_SESSION_REVOCATION_PURPOSE ||
      typeof candidate.familyId !== 'string' ||
      candidate.familyId.length === 0 ||
      candidate.familyId.length > 512 ||
      typeof candidate.userId !== 'string' ||
      candidate.userId.length === 0 ||
      candidate.userId.length > 512 ||
      !Number.isSafeInteger(candidate.absoluteExpiresAt) ||
      (candidate.absoluteExpiresAt as number) <= 0 ||
      (candidate.absoluteExpiresAt as number) > 8_640_000_000_000_000
    ) {
      return null;
    }
    return candidate as unknown as AuthSessionRevocationCapabilityPayload;
  } catch {
    return null;
  }
}

/**
 * 浏览器可见、只能撤销指定 token family 的能力。载荷固定绑定 family/user/绝对过期时刻/
 * purpose，HMAC 使用 JWT_SECRET 域隔离签名；它不含 JWT、jti 或其他可用于数据授权的秘密。
 */
export function getAuthSessionBinding(
  payload: AuthTokenPayload
): string | null {
  if (
    !hasTokenFamily(payload) ||
    payload.familyId.length > 512 ||
    payload.id.length === 0 ||
    payload.id.length > 512
  ) {
    return null;
  }
  const absoluteExpiresAt = getFamilyExpiryDate(
    payload.sessionStartedAt
  ).getTime();
  if (!Number.isSafeInteger(absoluteExpiresAt)) return null;

  const capability: AuthSessionRevocationCapabilityPayload = {
    purpose: AUTH_SESSION_REVOCATION_PURPOSE,
    familyId: payload.familyId,
    userId: payload.id,
    absoluteExpiresAt,
  };
  const payloadSegment = Buffer.from(
    JSON.stringify(capability),
    'utf8'
  ).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET)
    .update(getAuthSessionRevocationSigningInput(payloadSegment), 'utf8')
    .digest('base64url');
  return `${AUTH_SESSION_REVOCATION_CAPABILITY_VERSION}.${payloadSegment}.${signature}`;
}

/**
 * 从签名 JWT 派生 revoke-only session capability；不查询 DB，也不接受伪造 JWT。
 *
 * 这里有意忽略 leaf 的自然过期：旧 leaf 在 family 绝对寿命内仍应生成同一 capability，
 * 供 refresh 竞态后的持久撤销重试。
 * 返回值绝不能作为数据授权或 family 存活证明。
 */
export function getAuthTokenSessionBinding(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    }) as AuthTokenPayload;
    if (!isValidTokenPayload(decoded)) return null;
    return getAuthSessionBinding(decoded);
  } catch {
    return null;
  }
}

function isTokenRevokedInMemory(jti: string): boolean {
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

async function isTokenRevoked(jti: string): Promise<boolean> {
  // 两个存储都查，任一命中即视为已吊销。
  // 旧实现在 redis.status === 'ready' 时直接早退，于是「Redis 断连期间写进内存表的吊销」
  // 会在 Redis 恢复的那一刻集体失效（登出/踢人白做）。内存表命中优先，成本是一次 Map 查找。
  if (isTokenRevokedInMemory(jti)) {
    return true;
  }

  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      const exists = await redis.exists(`${TOKEN_BLACKLIST_PREFIX}${jti}`);
      return exists === 1;
    } catch {
      // Redis 查询失败：内存表已经查过且未命中，按未吊销处理（与降级前口径一致）。
    }
  }

  return false;
}

type PersistentFamilyRevocationStatus =
  | 'revoked'
  | 'already_invalid'
  | 'mismatch';

/**
 * DB 是 family 撤销的权威真源。updateMany 的 count=0 也可能只是并发请求已经先撤销；
 * 因此必须复查，而不是把安全的幂等重试误报成基础设施故障。
 */
async function persistentlyRevokeAuthTokenFamily(input: {
  familyId: string;
  userId: string;
  reason: string;
  expectedAbsoluteExpiresAt?: number;
}): Promise<PersistentFamilyRevocationStatus> {
  const now = new Date();
  if (
    input.expectedAbsoluteExpiresAt !== undefined &&
    input.expectedAbsoluteExpiresAt <= now.getTime()
  ) {
    return 'already_invalid';
  }
  const revoked = await prisma.authTokenFamily.updateMany({
    where: {
      id: input.familyId,
      userId: input.userId,
      revokedAt: null,
      expiresAt:
        input.expectedAbsoluteExpiresAt === undefined
          ? { gt: now }
          : {
              equals: new Date(input.expectedAbsoluteExpiresAt),
              gt: now,
            },
    },
    data: {
      revokedAt: now,
      revokedReason: input.reason.slice(0, 64),
    },
  });
  if (revoked.count === 1) return 'revoked';
  if (revoked.count !== 0) {
    throw new Error('Unexpected auth token family revocation result');
  }

  // 并发赢家、自然过期、用户删除级联/维护清理都已不可能继续授权，视为幂等成功。
  // 活跃且完全匹配的行仍在却 update=0 则不可证明已撤销，必须失败关闭。
  const family = await prisma.authTokenFamily.findUnique({
    where: { id: input.familyId },
    select: {
      userId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!family) return 'already_invalid';
  if (
    family.userId !== input.userId ||
    (input.expectedAbsoluteExpiresAt !== undefined &&
      family.expiresAt.getTime() !== input.expectedAbsoluteExpiresAt)
  ) {
    return 'mismatch';
  }
  if (family.revokedAt !== null || family.expiresAt.getTime() <= Date.now()) {
    return 'already_invalid';
  }
  throw new Error('Auth token family could not be persistently revoked');
}

export async function revokeToken(
  payload: Pick<
    AuthTokenPayload,
    'id' | 'jti' | 'exp' | 'sessionStartedAt' | 'familyId' | 'generation'
  >,
  options?: { reason?: string }
): Promise<void> {
  const reason = (options?.reason ?? 'logout').slice(0, 64);

  // DB 是撤销真源：先持久化，失败就向上传播。这样 web / 独立 WS 进程即便 Redis
  // 故障、重启或被淘汰，也不会把已经 logout 的单设备 family 重新放行。
  if (
    typeof payload.familyId !== 'string' ||
    payload.familyId.length === 0 ||
    !Number.isInteger(payload.generation)
  ) {
    throw new Error('Legacy auth tokens require reauthentication');
  }
  const persistentStatus = await persistentlyRevokeAuthTokenFamily({
    familyId: payload.familyId,
    userId: payload.id,
    reason,
  });
  if (persistentStatus === 'mismatch') {
    throw new Error('Auth token family could not be persistently revoked');
  }

  const expiresAt = getTokenExpiryDate(payload as AuthTokenPayload).getTime();
  const ttlSeconds = Math.max(
    1,
    Math.ceil((expiresAt - Date.now()) / 1000)
  );

  // 内存/Redis 只是拒绝路径的快速辅助索引，不再承担安全真源职责。
  const store = getTokenBlacklistStore();
  pruneExpiredBlacklistedTokens(store);
  store.set(payload.jti, { expiresAt });

  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      await redis.set(
        `${TOKEN_BLACKLIST_PREFIX}${payload.jti}`,
        '1',
        'EX',
        ttlSeconds
      );
    } catch {
      // 内存表已写入，降级为进程本地吊销。
    }
  }
}

/**
 * 验证 revoke-only binding 后，仅撤销其中被 HMAC 绑定的 family。无论当前浏览器 Cookie
 * 属于谁，都不会把它当成撤销目标；DB 读写失败会抛出，调用方必须返回非 2xx。
 */
export async function revokeAuthSessionByBinding(
  binding: string,
  options?: { reason?: string }
): Promise<RevokeAuthSessionByBindingResult> {
  const capability = parseAuthSessionRevocationCapability(binding);
  if (!capability) return { status: 'invalid' };

  // 先权威确认 capability 绑定的 user/绝对寿命。这个读取只决定“能否撤销”，不返回或
  // 授权任何用户数据；查询失败直接向上传播。并发请求随后仍由 update+复查闭合竞态。
  const family = await prisma.authTokenFamily.findUnique({
    where: { id: capability.familyId },
    select: {
      userId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!family) {
    return {
      status: 'already_invalid',
      familyId: capability.familyId,
      userId: capability.userId,
    };
  }
  if (
    family.userId !== capability.userId ||
    family.expiresAt.getTime() !== capability.absoluteExpiresAt
  ) {
    return { status: 'invalid' };
  }
  if (family.revokedAt !== null || family.expiresAt.getTime() <= Date.now()) {
    return {
      status: 'already_invalid',
      familyId: capability.familyId,
      userId: capability.userId,
    };
  }

  // capability 到期后绝不再执行写操作。理论上它与 family.expiresAt 精确相等，因此上面
  // 已覆盖正常过期；这里保留显式闸门，防止时钟跨界或未来 schema 变化误把过期能力用于撤销。
  if (capability.absoluteExpiresAt <= Date.now()) {
    return { status: 'invalid' };
  }

  const status = await persistentlyRevokeAuthTokenFamily({
    familyId: capability.familyId,
    userId: capability.userId,
    expectedAbsoluteExpiresAt: capability.absoluteExpiresAt,
    reason: options?.reason ?? 'logout',
  });
  if (status === 'mismatch') return { status: 'invalid' };
  return {
    status,
    familyId: capability.familyId,
    userId: capability.userId,
  };
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

async function verifyToken(
  token: string,
  options?: {
    allowConsumedLeaf?: boolean;
    ignoreLeafExpiration?: boolean;
    throwOnInfrastructureError?: boolean;
  }
): Promise<AuthSession | null> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: options?.ignoreLeafExpiration === true,
    }) as AuthTokenPayload;
    if (!isValidTokenPayload(decoded)) {
      return null;
    }

    if (decoded.sessionStartedAt + ABSOLUTE_SESSION_LIFETIME_MS < Date.now()) {
      return null;
    }

    // 安全 cutover：部署前的 legacy JWT 没有 familyId，其历史撤销只可能存在于
    // Redis/单进程内存。Redis miss、故障或淘汰后无法证明它未被撤销，因此一律要求
    // 重新登录。不能把“查不到 legacy 撤销记录”解释为仍然有效。
    if (!hasTokenFamily(decoded)) {
      return null;
    }

    if (await isTokenRevoked(decoded.jti)) {
      return null;
    }

    const jtiHash = hashTokenJti(decoded.jti);
    let user;
    let family;
    try {
      [user, family] = await Promise.all([
        prisma.user.findUnique({
          where: { id: decoded.id },
          select: {
            id: true,
            email: true,
            role: true,
            tokenVersion: true,
            status: true,
          },
        }),
        prisma.authTokenFamily.findUnique({
          where: { id: decoded.familyId },
          select: {
            id: true,
            userId: true,
            currentJtiHash: true,
            generation: true,
            expiresAt: true,
            revokedAt: true,
          },
        }),
      ]);
    } catch {
      throw new AuthVerificationInfrastructureError();
    }

    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return null;
    }

    // 被禁用用户（status !== 1）的旧 token 立即失效——一处生效全域。
    if (user.status !== 1) {
      return null;
    }

    // 新 token 的 DB family 是权威状态。缺行、跨用户、过期或 revoked 一律拒绝；
    // DB 查询本身抛错也会由外层 catch 失败关闭，Redis 不再能让它恢复有效。
    if (
      !family ||
      family.userId !== decoded.id ||
      family.revokedAt !== null ||
      family.expiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    if (
      !options?.allowConsumedLeaf &&
      (family.generation !== decoded.generation ||
        family.currentJtiHash !== jtiHash)
    ) {
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
  } catch (error) {
    if (
      options?.throwOnInfrastructureError &&
      error instanceof AuthVerificationInfrastructureError
    ) {
      throw error;
    }
    return null;
  }
}

/**
 * 只校验签名、载荷结构与绝对上限并返回 jti，不参与授权、不查 DB。
 * 主要供测试/诊断；伪造、过期或篡改 token 一律返回 null。
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

/**
 * 仅供“握手时已经用 verifyAuthToken 严格认证成功”的既有长连接复核身份。
 * routine refresh 后旧 leaf 不再是 current，但同一未撤销、未过期 family 内的既有连接
 * 仍可继续工作；登出、重放撤族、账号版本/状态变化或 DB 故障仍然失败关闭。
 *
 * 禁止用于 HTTP 授权或新的 WebSocket 握手；这些入口必须继续使用 verifyAuthToken。
 */
export async function verifyEstablishedAuthFamilyToken(
  token: string
): Promise<AuthSession | null> {
  if (!token || isClientSessionToken(token)) {
    return null;
  }

  return verifyToken(token, { allowConsumedLeaf: true });
}

export type EstablishedAuthFamilyDiagnosis =
  | { status: 'valid'; session: AuthSession }
  | { status: 'leaf_expired' }
  | { status: 'revoked' };

/**
 * 仅供已严格握手成功的既有长连接决定“自然 leaf exp 后是否值得做一次 strict 新握手”。
 * leaf_expired 只忽略 raw JWT 的 exp；签名、payload、绝对寿命、黑名单、用户版本/状态及
 * 持久 family 的 user/revokedAt/expiresAt 仍完整验证。legacy、DB 故障和任何其他失败均
 * 归为 revoked。返回 leaf_expired 不携带 session，绝不能据此继续授权或完成新握手。
 */
export async function diagnoseEstablishedAuthFamilyToken(
  token: string
): Promise<EstablishedAuthFamilyDiagnosis> {
  if (!token || isClientSessionToken(token)) return { status: 'revoked' };

  const valid = await verifyToken(token, { allowConsumedLeaf: true });
  if (valid) return { status: 'valid', session: valid };

  const expiredOnly = await verifyToken(token, {
    allowConsumedLeaf: true,
    ignoreLeafExpiration: true,
  });
  if (
    expiredOnly &&
    typeof expiredOnly.token.exp === 'number' &&
    Number.isFinite(expiredOnly.token.exp) &&
    expiredOnly.token.exp * 1000 <= Date.now()
  ) {
    return { status: 'leaf_expired' };
  }
  return { status: 'revoked' };
}

/**
 * refresh 专用：身份、账号状态与 family 存活性仍全部验证，但允许已消费叶子走到 CAS，
 * 由 rotateAuthToken 原子判定并执行 reuse → revoke family。不要用于普通 API 授权。
 */
export async function verifyRefreshAuthToken(
  token: string
): Promise<AuthSession | null> {
  if (!token || isClientSessionToken(token)) {
    return null;
  }
  return verifyToken(token, {
    allowConsumedLeaf: true,
    throwOnInfrastructureError: true,
  });
}

/**
 * logout 专用：允许同一仍存活 family 的已消费 leaf 撤销整族。
 *
 * 这封住“攻击者先用被盗 g0 赢得 refresh CAS→g1，受害者随后拿 g0 logout”竞态；
 * 签名、leaf exp、绝对寿命、用户版本/状态、family 归属/过期/撤销和 DB fail-closed
 * 仍与严格认证一致。不要用于普通 HTTP 授权。
 */
export async function verifyLogoutAuthToken(
  token: string
): Promise<AuthSession | null> {
  if (!token || isClientSessionToken(token)) {
    return null;
  }
  return verifyToken(token, {
    allowConsumedLeaf: true,
    throwOnInfrastructureError: true,
  });
}

export type LogoutAuthTokenResolution =
  | { status: 'active'; session: AuthSession }
  | { status: 'already_invalid'; session: AuthSession }
  | { status: 'invalid' };

/**
 * logout/retry 专用解析：只要签名 family 凭据与持久 family 归属一致，就允许任意旧 leaf
 * 撤整族；若 DB 已确认该 family revoked/过期/已清理，则返回幂等成功依据。
 *
 * 这里不用于任何数据授权。DB 查询失败会抛出而不是把“不可判定”伪装成已登出。
 */
export async function resolveLogoutAuthToken(
  token: string
): Promise<LogoutAuthTokenResolution> {
  if (!token || isClientSessionToken(token)) return { status: 'invalid' };
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    }) as AuthTokenPayload;
    if (!isValidTokenPayload(decoded) || !hasTokenFamily(decoded)) {
      return { status: 'invalid' };
    }

    let family;
    try {
      family = await prisma.authTokenFamily.findUnique({
        where: { id: decoded.familyId },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
    } catch {
      throw new AuthVerificationInfrastructureError();
    }

    const session: AuthSession = {
      user: { id: decoded.id, email: decoded.email, role: decoded.role },
      token: decoded,
      rawToken: token,
    };
    // 行已被安全维护任务清理，或已明确 revoked/绝对过期：任何 successor 都不可能再授权，
    // 可对“DB 已成功撤销但 200 丢包”的重试给出幂等 2xx。
    if (!family) return { status: 'already_invalid', session };
    if (family.userId !== decoded.id) return { status: 'invalid' };
    if (
      family.revokedAt !== null ||
      family.expiresAt.getTime() <= Date.now() ||
      decoded.sessionStartedAt + ABSOLUTE_SESSION_LIFETIME_MS <= Date.now()
    ) {
      return { status: 'already_invalid', session };
    }
    return { status: 'active', session };
  } catch (error) {
    if (error instanceof AuthVerificationInfrastructureError) throw error;
    return { status: 'invalid' };
  }
}

/** Sign a new JWT for the given user payload */
export function signToken(
  payload: TokenUserPayload,
  options?: {
    sessionStartedAt?: number;
    jti?: string;
    expiresInDays?: number;
    familyId?: string;
    generation?: number;
  }
): string {
  const sessionStartedAt = options?.sessionStartedAt ?? Date.now();
  const days = options?.expiresInDays ?? DEFAULT_JWT_EXPIRY_DAYS;
  // 用秒而不是 `${days}d`：钳到剩余绝对寿命后 days 可能是小数（见 getJwtExpiryConfig），
  // 交给 ms 解析字符串小数没必要也不精确。整数天的老口径结果完全不变（7 → 604800）。
  const expiresInSeconds = Math.max(1, Math.floor(days * 24 * 60 * 60));
  const familyClaims =
    options?.familyId !== undefined && options?.generation !== undefined
      ? {
          familyId: options.familyId,
          generation: options.generation,
        }
      : {};
  return jwt.sign(
    {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      tokenVersion: payload.tokenVersion,
      sessionStartedAt,
      jti: options?.jti ?? randomUUID(),
      ...familyClaims,
    },
    JWT_SECRET,
    { expiresIn: expiresInSeconds }
  );
}

/** 创建一次独立登录 / 设备 family，并签出 generation=0 的首个叶子。 */
export async function issueAuthToken(
  payload: TokenUserPayload,
  options?: {
    sessionStartedAt?: number;
    expiresInDays?: number;
  }
): Promise<string> {
  const sessionStartedAt = options?.sessionStartedAt ?? Date.now();
  const familyId = randomUUID();
  const jti = randomUUID();
  const token = signToken(payload, {
    sessionStartedAt,
    expiresInDays: options?.expiresInDays,
    familyId,
    generation: 0,
    jti,
  });

  await prisma.authTokenFamily.create({
    data: {
      id: familyId,
      userId: payload.id,
      currentJtiHash: hashTokenJti(jti),
      generation: 0,
      sessionStartedAt: new Date(sessionStartedAt),
      expiresAt: getFamilyExpiryDate(sessionStartedAt),
    },
  });

  return token;
}

/**
 * 原子消费一个 family refresh 叶子。成功只更新 current leaf；CAS loser 表示同一旧凭据
 * 被重用，立即持久撤销整族。legacy leaf 不迁移、直接要求重新登录；DB 错误失败关闭。
 */
export async function rotateAuthToken(
  current: AuthTokenPayload,
  user: TokenUserPayload,
  options?: { expiresInDays?: number }
): Promise<RotateAuthTokenResult> {
  const nextJti = randomUUID();
  const nextJtiHash = hashTokenJti(nextJti);

  if (!hasTokenFamily(current)) {
    // 安全 cutover 不迁移 legacy leaf；所有无 family JWT 必须重新登录。
    return { status: 'reused' };
  }

  const nextGeneration = current.generation + 1;
  const nextToken = signToken(user, {
    sessionStartedAt: current.sessionStartedAt,
    expiresInDays: options?.expiresInDays,
    familyId: current.familyId,
    generation: nextGeneration,
    jti: nextJti,
  });
  const rotated = await prisma.authTokenFamily.updateMany({
    where: {
      id: current.familyId,
      userId: current.id,
      currentJtiHash: hashTokenJti(current.jti),
      generation: current.generation,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: {
      currentJtiHash: nextJtiHash,
      generation: { increment: 1 },
    },
  });
  if (rotated.count === 1) {
    return { status: 'rotated', token: nextToken };
  }

  await prisma.authTokenFamily.updateMany({
    where: {
      id: current.familyId,
      userId: current.id,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      revokedReason: 'refresh_reuse',
    },
  });
  return { status: 'reused' };
}

/**
 * 获取 JWT 过期天数和对应的 Cookie maxAge。
 *
 * 传 `sessionStartedAt`（刷新场景：会话起点保持不变）时，额外钳到「剩余绝对寿命」。
 * 不钳的话，jwt_expiry=90 的站点在 day-10 自动刷新会发出 exp=day40 的 cookie，
 * 而 verifyToken 在 sessionStartedAt+30d 处硬杀 → 「cookie 看着有效、用户中途被登出」。
 */
export function getJwtExpiryConfig(
  jwtExpiryDays?: number,
  options?: { sessionStartedAt?: number; now?: number }
) {
  // 会话最长绝对存活 = ABSOLUTE_SESSION_LIFETIME_MS（30 天，verifyToken 硬性拦截）；
  // admin 把 jwt_expiry 配到更大（可达 365 天）只会让 JWT exp/cookie maxAge 与真实存活期不符、
  // 误导用户。这里把生效值钳到绝对上限，让 cookie/JWT 与实际登出时机一致。
  const dayMs = 24 * 60 * 60 * 1000;
  const absoluteDays = ABSOLUTE_SESSION_LIFETIME_MS / dayMs;
  let days = Math.min(jwtExpiryDays ?? DEFAULT_JWT_EXPIRY_DAYS, absoluteDays);

  const sessionStartedAt = options?.sessionStartedAt;
  if (sessionStartedAt != null && Number.isFinite(sessionStartedAt)) {
    const now = options?.now ?? Date.now();
    const remainingMs = sessionStartedAt + ABSOLUTE_SESSION_LIFETIME_MS - now;
    days = Math.min(days, Math.max(0, remainingMs) / dayMs);
  }

  return {
    expiresInDays: days,
    cookieMaxAge: Math.max(0, Math.floor(days * 24 * 60 * 60)),
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
  // Set-Cookie 在 body 解析前已生效。把同一个非授权 family binding 放进稳定响应头，
  // 客户端即使遇到截断 JSON 也能在全局 cookie lock 内撤销刚写入但未 commit 的 family。
  const sessionBinding = getAuthTokenSessionBinding(token);
  if (sessionBinding) {
    response.headers.set(AUTH_SESSION_BINDING_HEADER, sessionBinding);
  }
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
    // 邮箱是否视为已验证。开启站点级邮箱验证硬门禁时，注册路由传 false，
    // 让新账号 emailVerifiedAt=null（未验证不得登录）；默认 true 保持历史行为。
    emailVerified?: boolean;
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
  const emailVerified = options?.emailVerified !== false;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName,
      role,
      quotaResetAt: getNextQuotaResetAt(),
      emailVerifiedAt: emailVerified ? new Date() : null,
      ...quotas,
      storageBytesLimit,
    },
  });
  const token = await issueAuthToken(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    },
    { expiresInDays: options?.jwtExpiryDays }
  );
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
  // 改密与「作废该用户全部未消费邮件令牌」必须同进同退：只改密不作废，一封没用过的
  // 重置链接就能在 1h 内把刚改的密码再改回去（tokenVersion++ 踢掉的会话拦不住它）。
  return prisma.$transaction(async (tx) => {
    await invalidateUserEmailTokens(userId, { db: tx });
    return tx.user.update({
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
  });
}

/** login() 在「密码正确但邮箱未验证」时抛出的哨兵错误，供路由映射到「需验证」响应。 */
export const EMAIL_NOT_VERIFIED_ERROR = 'Email not verified';

export async function login(
  email: string,
  password: string,
  options?: { jwtExpiryDays?: number; bcryptRounds?: number; requireEmailVerified?: boolean }
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
  // 邮箱验证硬门禁：站点开启验证且此账号未验证时拒绝登录。此检查在密码校验**之后**，
  // 只有已知正确口令者才会看到这个错误，故不构成账户枚举侧信道（合法本人需要它来触发重发）。
  if (options?.requireEmailVerified && user.emailVerifiedAt == null) {
    throw new Error(EMAIL_NOT_VERIFIED_ERROR);
  }
  const token = await issueAuthToken(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    },
    { expiresInDays: options?.jwtExpiryDays }
  );
  return { user, token };
}
