import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  CLIENT_SESSION_TOKEN,
  getJwtExpiryConfig,
  registerWithOptions,
  setAuthCookie,
  validatePassword,
} from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { logAction } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import { getSiteSettings } from '@/lib/siteSettings';
import { resolvePublicRegistrationRole } from '@/lib/userRoles';
import {
  buildDomainPolicy,
  checkRegistrationEmail,
  normalizeEmail,
} from '@/lib/email/domains';
import { isEmailEnabled, sendVerificationEmail } from '@/lib/email';

export async function POST(req: Request) {
  const siteSettings = await getSiteSettings().catch(() => null);

  let body: { email?: string; password?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const authLimit = siteSettings?.rate_limit_auth ?? 5;
  // 安全：按 email 维度限流。若退回纯 IP 桶，在 trusted_proxy=false（默认）下所有请求
  // 共用同一个 ip:unknown 全局桶，单一匿名攻击者发几次即可打满、锁死全站注册（自愈但可持续）。
  const emailKey = normalizeEmail(body.email ?? '').slice(0, 255);
  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:register',
    limit: authLimit,
    windowMs: 10 * 60_000,
    ...(emailKey ? { key: `email:${emailKey}` } : {}),
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 额外按真实来源 IP 限流（仅当 IP 可确定时；trusted_proxy=false 时为 'unknown' 则跳过，
  // 避免再退化成全局桶）。用于挡同一来源批量注册不同 email。
  const clientIp = resolveRequestClientIp(req);
  if (clientIp !== 'unknown') {
    const ipLimited = await enforceRateLimit(req, {
      scope: 'auth:register:ip',
      limit: authLimit * 5,
      windowMs: 10 * 60_000,
      key: `ip:${clientIp}`,
    });
    if (ipLimited) {
      return ipLimited;
    }
  }

  try {
    if (!siteSettings) {
      throw new Error('Site settings unavailable');
    }

    if (!siteSettings.allow_registration) {
      return NextResponse.json(
        { error: 'Registration is disabled' },
        { status: 403 }
      );
    }

    const { password, displayName } = body;
    const email = normalizeEmail(body.email ?? '');

    if (!email || !password || !displayName) {
      return NextResponse.json(
        { error: 'email, password, and displayName are required' },
        { status: 400 }
      );
    }

    // 域名管控：格式校验 + 一次性邮箱拦截 + 教育白名单强制。给出可读中文原因（此处非登录，
    // 暴露"域名不合规"不构成账户枚举）。isEducation 仅用于打标/收集，不影响放行。
    const policy = buildDomainPolicy(siteSettings);
    const domainCheck = checkRegistrationEmail(email, policy);
    if (!domainCheck.ok) {
      const reasonMessage =
        domainCheck.reason === 'disposable_blocked'
          ? '不支持使用一次性/临时邮箱注册，请换用常用邮箱'
          : domainCheck.reason === 'not_allowlisted'
            ? '当前仅允许指定域名（如院校邮箱）注册，请换用符合要求的邮箱'
            : '邮箱地址格式不正确';
      return NextResponse.json({ error: reasonMessage }, { status: 400 });
    }

    const passwordError = validatePassword(password, {
      minLength: siteSettings.password_min_length,
    });
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // 是否要求邮箱验证：站点开关开启 **且** 邮件系统可用（SMTP 已配置或测试捕获模式）。
    // 开关开了但 SMTP 没配则「fail-open」创建已验证账号，避免把注册/登录彻底锁死
    // （admin 设置页会就此告警）。
    const emailReady = await isEmailEnabled(siteSettings);
    const verificationRequired = siteSettings.email_verification && emailReady;

    const jwtConfig = getJwtExpiryConfig(siteSettings.jwt_expiry);
    const { user, token } = await registerWithOptions(email, password, displayName, {
      role: resolvePublicRegistrationRole(siteSettings.default_group),
      bcryptRounds: siteSettings.bcrypt_rounds,
      jwtExpiryDays: jwtConfig.expiresInDays,
      emailVerified: !verificationRequired,
    });

    logAction(req, 'user.register', {
      user: { id: user.id, email: user.email, role: user.role },
      userName: user.displayName,
    });
    // 教育邮箱收集：单独审计一条，便于管理员回顾并把院校域名纳入白名单。
    if (domainCheck.isEducation) {
      logAction(req, 'user.register.education', {
        user: { id: user.id, email: user.email, role: user.role },
        userName: user.displayName,
        detail: `教育邮箱注册: ${user.email}`,
      });
    }

    // 需要验证：不签发会话，改发验证邮件，前端进入「去邮箱查收」态。
    if (verificationRequired) {
      const sendResult = await sendVerificationEmail(user, {
        settings: siteSettings,
        requestIp: clientIp === 'unknown' ? null : clientIp,
      }).catch((err) => {
        logger.error({ err: serializeError(err) }, '[register] 发送验证邮件失败');
        return { ok: false as const, error: 'send failed' };
      });
      if (!sendResult.ok) {
        // 账号已创建但邮件没发出去：提示用户稍后在登录页重发，不算致命错误。
        logger.warn('[register] 验证邮件未成功发送，用户需稍后重发');
      }
      return NextResponse.json(
        {
          verificationRequired: true,
          email: user.email,
          message: '注册成功，请前往邮箱完成验证后再登录',
        },
        { status: 201 }
      );
    }

    const response = NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
        },
        token: CLIENT_SESSION_TOKEN,
      },
      { status: 201 }
    );

    // 设置 HttpOnly cookie（使用数据库配置的过期天数）
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });

    return response;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'Registration failed' },
        { status: 400 }
      );
    }
    console.error('Register error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
