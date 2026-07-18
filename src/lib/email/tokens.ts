// src/lib/email/tokens.ts
// 邮件令牌（邮箱验证 / 密码重置）的生成、存储与消费。
// 安全模型：
//  - raw token = 32 字节 CSPRNG 随机 → base64url（仅出现在邮件链接里，从不落库）。
//  - 库里只存 sha256(raw) 的十六进制（tokenHash，唯一索引）→ 库泄露也无法反推链接。
//  - 校验时对入参哈希后按唯一索引直接查找（等价常量时间，规避逐字节比较的时序侧信道）。
//  - 单次使用：消费走带 consumedAt=null 守卫的原子 updateMany，count===1 才算认领成功，
//    并发重放天然只有一个成功。短 TTL；同用户同类型新令牌签发时作废旧令牌。

import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export type EmailTokenType = 'VERIFY_EMAIL' | 'RESET_PASSWORD';

/**
 * 可选 Prisma 客户端：默认用全局 `prisma`；调用方可传入 `$transaction` 的 tx，
 * 让令牌作废与改密在同一事务里原子提交。PrismaClient 是 TransactionClient 的超集。
 */
type EmailTokenDbClient = Prisma.TransactionClient;

/** 各类型令牌有效期（毫秒）。 */
export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenType, number> = {
  VERIFY_EMAIL: 24 * 60 * 60 * 1000, // 24 小时
  RESET_PASSWORD: 60 * 60 * 1000, // 1 小时
};

/** 生成 raw token（base64url，无填充）。仅返回给发信侧放进链接，不落库。 */
export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 对 raw token 取 sha256 十六进制。存库与查找统一走它。 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * 为用户签发一枚指定类型的令牌：先作废该用户同类型所有未消费令牌（一次只留一枚有效，
 * 重发即失效旧链接），再落库新令牌哈希，返回 raw token。
 */
export async function createEmailToken(params: {
  userId: string;
  type: EmailTokenType;
  requestIp?: string | null;
}): Promise<{ rawToken: string; expiresAt: Date }> {
  const { userId, type, requestIp } = params;
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const expiresAt = new Date(now + EMAIL_TOKEN_TTL_MS[type]);

  // 作废旧的未消费令牌（幂等；不删除以保留审计轨迹）。
  await prisma.emailToken.updateMany({
    where: { userId, type, consumedAt: null },
    data: { consumedAt: new Date(now) },
  });

  await prisma.emailToken.create({
    data: {
      userId,
      type,
      tokenHash,
      expiresAt,
      requestIp: requestIp ?? null,
    },
  });

  return { rawToken, expiresAt };
}

/**
 * 只读探查一枚令牌当下是否可用（存在 / 类型相符 / 未消费 / 未过期），不做任何写入。
 *
 * 仅用于「在昂贵操作（bcrypt 哈希）之前快速拒掉明显无效的令牌」这一优化：拿不到它就得
 * 先无条件哈希再验令牌，等于给任何人一个免费的 CPU 放大器。不构成 TOCTOU 风险——
 * 真正的认领仍然只能走 `consumeEmailToken` 的原子 updateMany，这里探到"可用"也不代表
 * 稍后一定能认领成功（并发重放照样只有一个赢家）。
 */
export async function peekEmailToken(params: {
  rawToken: string;
  type: EmailTokenType;
  db?: EmailTokenDbClient;
}): Promise<{ userId: string } | null> {
  const { rawToken, type } = params;
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;

  const db = params.db ?? prisma;
  const row = await db.emailToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { userId: true, type: true, consumedAt: true, expiresAt: true },
  });
  if (!row || row.type !== type || row.consumedAt !== null || row.expiresAt <= new Date()) {
    return null;
  }
  return { userId: row.userId };
}

/**
 * 消费一枚令牌：按类型 + 未消费 + 未过期原子认领（consumedAt=null 守卫，count===1 才成功）。
 * 成功返回 userId，失败（不存在/类型不符/已用/过期/并发被抢）返回 null。
 *
 * 传 `db`（`$transaction` 的 tx）可让「认领」与它授权的那步写入同进同退：不这么做的话，
 * 认领成功后紧接着的一步一旦抛错（瞬时 DB 故障等），令牌已 consumedAt 但事情没办成，
 * 链接就永久报废了——而用户往往还撞在重发限流里，只能干等。
 */
export async function consumeEmailToken(params: {
  rawToken: string;
  type: EmailTokenType;
  db?: EmailTokenDbClient;
}): Promise<{ userId: string } | null> {
  const { rawToken, type } = params;
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;

  const db = params.db ?? prisma;
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  // 先取行拿 userId（哈希唯一索引，O(1)）。存在但类型/状态不符则视为失败。
  const row = await db.emailToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, type: true, consumedAt: true, expiresAt: true },
  });
  if (!row || row.type !== type || row.consumedAt !== null || row.expiresAt <= now) {
    return null;
  }

  // 原子认领：仅当仍未消费且未过期时置位，防并发重放。
  const claimed = await db.emailToken.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return null;

  return { userId: row.userId };
}

/**
 * 作废用户名下所有未消费的邮件令牌（可按类型过滤），返回作废条数。
 *
 * 供改密路径调用：改密是「收回全部外发凭据」的动作，和 `tokenVersion++` 吊销所有会话
 * 同源。未用的重置链接 1h 内仍能改密（拿到过一封 forgot-password 信的攻击者，在受害者
 * 改密并踢掉所有会话后照样能接管），未用的验证链接则因为 verify-email 消费后直接签发
 * 会话，等价于一枚免密登录凭据——两类都必须随改密一起失效。
 *
 * 与 `createEmailToken` 的「签发即作废旧令牌」一致：写 `consumedAt` 而不删除，保留审计轨迹。
 */
export async function invalidateUserEmailTokens(
  userId: string,
  options?: { types?: EmailTokenType[]; db?: EmailTokenDbClient }
): Promise<number> {
  const db = options?.db ?? prisma;
  const types = options?.types;
  const result = await db.emailToken.updateMany({
    where: {
      userId,
      consumedAt: null,
      ...(types && types.length > 0 ? { type: { in: types } } : {}),
    },
    data: { consumedAt: new Date() },
  });
  return result.count;
}

/** 清理已过期/已消费的历史令牌（供维护任务调用，非必需——查找永远带状态过滤）。 */
export async function pruneExpiredEmailTokens(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await prisma.emailToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }],
    },
  });
  return result.count;
}
