import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { validatePassword } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  consumeEmailToken,
  invalidateUserEmailTokens,
  peekEmailToken,
} from '@/lib/email/tokens';
import { sendSecurityAlertEmail } from '@/lib/email';

// 事务内用于回滚的哨兵错误（事务回调只能靠抛错回滚，返回值一律提交）。
const TOKEN_INVALID = 'reset-password:token-invalid';
const ACCOUNT_UNAVAILABLE = 'reset-password:account-unavailable';

/**
 * POST /api/auth/reset-password  body: { token, password }
 * 消费重置令牌 → 校验新密码强度 → 改密 + tokenVersion++（吊销全部旧会话）→ 发改密安全提醒。
 * 不自动登录：重置成功后要求用新密码重新登录（更保守，且重置常发生在异设备）。
 */
export async function POST(req: Request) {
  const siteSettings = await getSiteSettings().catch(() => null);

  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const limited = await enforceRateLimit(req, {
      scope: 'auth:reset-password:ip',
      limit: 20,
      windowMs: 15 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (limited) return limited;
  }

  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!token || !password) {
    return NextResponse.json({ error: '缺少令牌或新密码' }, { status: 400 });
  }

  const passwordError = validatePassword(password, {
    minLength: siteSettings?.password_min_length,
  });
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  // 只读探一次令牌：明显无效就直接拒，别为垃圾令牌白跑一次 bcrypt（rounds 上限 15，
  // 单次可达秒级）。这不是认领——真正的原子认领在下面的事务里。
  if (!(await peekEmailToken({ rawToken: token, type: 'RESET_PASSWORD' }))) {
    return NextResponse.json(
      { error: '重置链接无效或已过期，请重新申请' },
      { status: 400 }
    );
  }

  // bcrypt 放事务外：rounds=15 时单次哈希约数秒，塞进事务会白占连接和行锁，
  // 还可能撞上 Prisma 交互式事务 5s 默认超时把重置整个搞挂。
  const passwordHash = await bcrypt.hash(password, siteSettings?.bcrypt_rounds ?? 12);

  // 认领与改密同事务：先烧后用的话，认领成功后任何一步抛错都会留下一枚已 consumedAt
  // 但没生效的令牌 → 链接永久报废，而用户还可能撞在重发限流里干等。
  let user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
  try {
    user = await prisma.$transaction(async (tx) => {
      const consumed = await consumeEmailToken({
        rawToken: token,
        type: 'RESET_PASSWORD',
        db: tx,
      });
      if (!consumed) throw new Error(TOKEN_INVALID);

      const found = await tx.user.findUnique({ where: { id: consumed.userId } });
      // 账号已删除/封禁：回滚认领，令牌留着（解封后仍在 TTL 内就还能用）。
      if (!found || found.status !== 1) throw new Error(ACCOUNT_UNAVAILABLE);

      // 改密即收回全部外发凭据。本次 RESET_PASSWORD 令牌上面已认领，真正兜住的是未用的
      // VERIFY_EMAIL 令牌——verify-email 消费后直接签发会话，留着等于一枚免密登录链接。
      await invalidateUserEmailTokens(found.id, { db: tx });
      await tx.user.update({
        where: { id: found.id },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 }, // 吊销所有已签发会话
          // 借重置完成同时视为邮箱已验证（能收到重置邮件即证明邮箱可达）。
          emailVerifiedAt: found.emailVerifiedAt ?? new Date(),
        },
      });
      return found;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === TOKEN_INVALID) {
      return NextResponse.json(
        { error: '重置链接无效或已过期，请重新申请' },
        { status: 400 }
      );
    }
    if (message === ACCOUNT_UNAVAILABLE) {
      return NextResponse.json({ error: '账号不可用' }, { status: 400 });
    }
    // 其余（DB 故障等）：令牌已随事务回滚，可安全重试同一链接。
    console.error('Reset password error:', error);
    return NextResponse.json({ error: '重置失败，请稍后重试' }, { status: 500 });
  }

  logAction(req, 'user.password.reset', {
    user: { id: user.id, email: user.email, role: user.role },
    userName: user.displayName,
  });

  // 改密安全提醒（事务类，fire-and-forget）
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  void sendSecurityAlertEmail(
    { id: user.id, email: user.email, displayName: user.displayName },
    { kind: 'password_changed', ip: clientIp === 'unknown' ? null : clientIp, when },
    { settings: siteSettings ?? undefined }
  );

  return NextResponse.json({ ok: true, message: '密码已重置，请用新密码登录' });
}
