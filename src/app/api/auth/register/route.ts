import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  CLIENT_SESSION_TOKEN,
  getAuthTokenSessionBinding,
  getJwtExpiryConfig,
  registerWithOptions,
  setAuthCookie,
  validatePassword,
} from '@/lib/auth';
import {
  enforcePublicAuthPrelude,
  publicAuthAccountKey,
  readPublicAuthJson,
  rejectMalformedStringFields,
} from '@/lib/publicAuth';
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

/**
 * L7：显示名归一化 —— trim + 截断。与 `app/api/setup/route.ts` 里的同名实现同口径
 * （route.ts 只允许导出 Next 认识的路由符号，故两处各留一份而非跨文件 import）。
 */
const MAX_DISPLAY_NAME_LENGTH = 64;

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/**
 * P2002 的 meta.target 形状随数据库而异：PostgreSQL / SQLite 给字段数组（['email']），
 * MySQL 给索引名字符串（'User_email_key'，个别版本带表名前缀 'User.User_email_key'）。
 * 本项目跑 MySQL——旧实现只认数组，于是「邮箱已存在」永远落进 400 分支，
 * L6 的「与成功响应完全一致」在生产上从未生效（注册接口仍是一个精确的邮箱枚举器）。
 */
function isEmailUniqueTarget(target: unknown): boolean {
  if (Array.isArray(target)) {
    return target.some(
      (field) => typeof field === 'string' && field.toLowerCase() === 'email'
    );
  }
  return typeof target === 'string' && /(^|[._])email([._]|$)/i.test(target);
}

/** 需邮箱验证时注册的唯一对外响应：新建账号与邮箱已存在两条路径必须逐字节一致（L6）。 */
function verificationPendingResponse(email: string): NextResponse {
  return NextResponse.json(
    {
      verificationRequired: true,
      email,
      message: '注册成功，请前往邮箱完成验证后再登录',
    },
    { status: 201 }
  );
}

export async function POST(req: Request) {
  const prelude = await enforcePublicAuthPrelude(req, {
    scope: 'register',
    endpointIpLimit: 25,
    endpointWindowMs: 10 * 60_000,
  });
  if (prelude.response) return prelude.response;

  const parsed = await readPublicAuthJson<{
    email?: string;
    password?: string;
    displayName?: string;
  }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  // 非字符串 email 会让下面 try 之外的 normalizeEmail 抛 TypeError → 框架 500。
  const malformed = rejectMalformedStringFields(body, ['email']);
  if (malformed) return malformed;
  const siteSettings = await getSiteSettings().catch(() => null);

  const authLimit = siteSettings?.rate_limit_auth ?? 5;
  // 安全：按 email 维度限流。若退回纯 IP 桶，在 trusted_proxy=false（默认）下所有请求
  // 共用同一个 ip:unknown 全局桶，单一匿名攻击者发几次即可打满、锁死全站注册（自愈但可持续）。
  const emailKey = normalizeEmail(body.email ?? '').slice(0, 255);
  const rateLimited = emailKey
    ? await enforceRateLimit(req, {
        scope: 'auth:register',
        limit: authLimit,
        windowMs: 10 * 60_000,
        key: publicAuthAccountKey('email', emailKey),
      })
    : null;
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

  // L6：邮箱枚举防护要在 catch 里用到它，故提到 try 之外。
  let verificationRequired = false;
  let normalizedEmailForResponse = '';

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

    const { password } = body;
    // L7：displayName 原本未 trim 未截断直接落库，而 schema 里 `displayName String`
    // 映射成 TEXT（无长度约束）—— 一条注册请求就能塞进 64KB 字符串，随后在管理后台、
    // 审计日志、会话列表等处被反复放大传输。setup/route.ts 里有同口径的一份实现。
    const displayName = normalizeDisplayName(body.displayName);
    const email = normalizeEmail(body.email ?? '');
    normalizedEmailForResponse = email;

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
      // 白名单配置坏了（强制开着但一条都没解析出来）：这是站点配置故障，不是用户的错。
      // 换任何邮箱都注册不了，所以既不能说"请换用符合要求的邮箱"，也不能静默放行 ——
      // 报 503 让它在监控里可见，并把丢弃的原始条目写进日志供管理员按图索骥。
      if (domainCheck.reason === 'allowlist_misconfigured') {
        logger.error(
          { invalidEntries: policy.allowlistInvalid },
          '[register] 域名白名单强制开启但无一条有效条目，注册已 fail-closed；请修正 email_domain_allowlist'
        );
        return NextResponse.json(
          { error: '注册域名白名单配置有误，请联系管理员' },
          { status: 503 }
        );
      }
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
    verificationRequired = siteSettings.email_verification && emailReady;

    const jwtConfig = getJwtExpiryConfig(siteSettings.jwt_expiry);
    const { user, token } = await registerWithOptions(email, password, displayName, {
      role: resolvePublicRegistrationRole(siteSettings.default_group),
      bcryptRounds: siteSettings.bcrypt_rounds,
      jwtExpiryDays: jwtConfig.expiresInDays,
      emailVerified: !verificationRequired,
      // 需验证时不当场签会话：既不留孤儿 family 行，也不比「邮箱已存在」路径多一次写库。
      issueSession: !verificationRequired,
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
      // 刻意不 await（同 forgot-password / resend-verification）：SMTP 往返 200ms~3s，
      // 而「邮箱已存在」路径在 P2002 处立即返回——等发信就等于给枚举者一个时序侧信道，
      // 通用响应文案挡不住它。代价是发信失败不再能当场告诉用户（旧的 emailSendFailed）：
      // 失败以 error 级别落日志供运维排查；用户在「去邮箱查收」页仍有「重新发送」入口。
      // 依旧**不** fail-open 放行（把账号标成已验证）——那会让打爆 SMTP 的人绕过验证门禁。
      void sendVerificationEmail(user, {
        settings: siteSettings,
        requestIp: prelude.clientIp === 'unknown' ? null : prelude.clientIp,
      })
        .then((sendResult) => {
          if (!sendResult.ok) {
            logger.error(
              { userId: user.id, error: sendResult.error },
              '[register] 验证邮件发送失败，账号已创建但用户无法完成验证；请检查 SMTP 配置'
            );
          }
        })
        .catch((err) => {
          logger.error(
            { err: serializeError(err), userId: user.id },
            '[register] 发送验证邮件失败'
          );
        });
      return verificationPendingResponse(user.email);
    }

    if (!token) {
      // issueSession 只在 verificationRequired 时为 false，走到这里必有会话；防御性兜底。
      throw new Error('Registration session was not issued');
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
        sessionBinding: getAuthTokenSessionBinding(token),
      },
      { status: 201 }
    );

    // 设置 HttpOnly cookie（使用数据库配置的过期天数）
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });
    response.headers.set('Clear-Site-Data', '"cache"');

    return response;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // L6：邮箱已注册时返回 400、成功时返回 201 —— 单看状态码就能枚举「这个邮箱
      // 有没有注册过」，与 forgot-password 的「恒定响应」标准不一致。
      //
      // 开了邮箱验证时可以做到真正不可区分：成功注册也只回一句「请去邮箱查收」，
      // 那么邮箱已存在时回**完全相同**的 201（不建账号、不发信）即可，攻击者无从分辨。
      //
      // 没开邮箱验证时无法隐藏：成功路径必须下发会话 cookie，注册流程结构上就会
      // 泄露这一位信息（这是注册接口的固有性质，不是本处的疏漏）。此时维持 400，
      // 但文案保持中性、不点名邮箱。
      if (isEmailUniqueTarget(error.meta?.target) && verificationRequired) {
        return verificationPendingResponse(normalizedEmailForResponse);
      }

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
