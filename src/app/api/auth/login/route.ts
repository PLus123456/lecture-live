import { NextResponse } from 'next/server';
import {
  CLIENT_SESSION_TOKEN,
  EMAIL_NOT_VERIFIED_ERROR,
  LOGIN_THROTTLED_ERROR,
  getAuthTokenSessionBinding,
  getJwtExpiryConfig,
  login,
  setAuthCookie,
} from '@/lib/auth';
import {
  enforcePublicAuthPrelude,
  publicAuthAccountKey,
  readPublicAuthJson,
  rejectMalformedStringFields,
} from '@/lib/publicAuth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { isLoginEmailCandidate, normalizeEmail } from '@/lib/email/domains';
import { isEmailEnabled } from '@/lib/email';
import { maybeNotifyNewDeviceLogin } from '@/lib/email/loginAlert';

function invalidCredentialsResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Invalid email or password' },
    { status: 401 }
  );
}

export async function POST(req: Request) {
  const prelude = await enforcePublicAuthPrelude(req, {
    scope: 'login',
    endpointIpLimit: 50,
    endpointWindowMs: 60_000,
  });
  if (prelude.response) return prelude.response;

  const parsed = await readPublicAuthJson<{ email?: unknown; password?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const malformed = rejectMalformedStringFields(body, ['email', 'password']);
  if (malformed) return malformed;
  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // 站点设置读不出来时绝不能「按默认值」放行：旧实现 catch → null 后 requireEmailVerified
  // 恒为 false，DB 一抖未验证账号就能登录，账号桶也悄悄换成硬编码默认值。与 register 同口径
  // fail-closed（503 不触发前端登出，用户稍后重试即可）。
  const siteSettings = await getSiteSettings().catch(() => null);
  if (!siteSettings) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  // 按 email 维度限流，避免共享 IP 环境下误伤其他用户（针对单账号的暴破被节流）。
  const authLimit = siteSettings.rate_limit_auth;
  const emailKey = normalizeEmail(rawEmail).slice(0, 255);
  const rateLimited = emailKey
    ? await enforceRateLimit(req, {
        scope: 'auth:login',
        limit: authLimit,
        windowMs: 60_000,
        key: publicAuthAccountKey('email', emailKey),
      })
    : null;
  if (rateLimited) {
    return rateLimited;
  }

  // 账号级桶命中时由 beforePasswordCheck 写入，catch 里原样回给客户端（带 Retry-After）。
  const accountThrottle: { response: NextResponse | null } = { response: null };

  try {
    const email = normalizeEmail(rawEmail);

    if (!email || !password) {
      return NextResponse.json(
        { error: 'email and password are required' },
        { status: 400 }
      );
    }

    // 非可打印 ASCII 的写法（重音字母、全角、控制 / 零宽字符）在 utf8mb4_unicode_ci 下会与真实
    // 账号「排序规则相等」，却各自哈希出新的 email 桶——借此绕过上面的按账号限流。合法注册
    // 只收 ASCII，这类入参不可能对应正常账号：不查库、不跑 bcrypt，直接回通用 401。
    if (!isLoginEmailCandidate(email)) {
      logAction(req, 'user.login.failed', { detail: `邮箱: ${emailKey || 'unknown'}` });
      return invalidCredentialsResponse();
    }

    const jwtConfig = getJwtExpiryConfig(siteSettings.jwt_expiry);
    // 邮箱验证硬门禁：站点开关开启且邮件系统可用时，未验证账号即使口令正确也拒绝登录。
    const requireEmailVerified =
      !!siteSettings.email_verification && (await isEmailEnabled(siteSettings));
    const { user, token } = await login(email, password, {
      jwtExpiryDays: jwtConfig.expiresInDays,
      bcryptRounds: siteSettings.bcrypt_rounds,
      requireEmailVerified,
      // 账号级第二道桶：按 login() 解析出的 user.id 计数，在 bcrypt 之前判定。
      // email 桶按入参字符串计，任何未预见的「不同写法 → 同一账号」都会让它失效；
      // 按 id 记的桶对所有写法共享同一份额度。
      beforePasswordCheck: async (userId) => {
        accountThrottle.response = await enforceRateLimit(req, {
          scope: 'auth:login:user',
          limit: authLimit,
          windowMs: 60_000,
          key: `user:${userId}`,
        });
        return accountThrottle.response === null;
      },
    });

    logAction(req, 'user.login', {
      user: { id: user.id, email: user.email, role: user.role },
      userName: user.displayName,
    });

    // 新设备/异地登录安全提醒（best-effort，非阻塞；仅 Redis 可用时生效，首登只播种不提醒）。
    void maybeNotifyNewDeviceLogin(
      { id: user.id, email: user.email, displayName: user.displayName, emailPreferences: user.emailPreferences },
      req,
      siteSettings
    );

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      token: CLIENT_SESSION_TOKEN,
      sessionBinding: getAuthTokenSessionBinding(token),
    });

    // 设置 HttpOnly cookie（使用数据库配置的过期天数）
    setAuthCookie(response, token, { maxAge: jwtConfig.cookieMaxAge });
    response.headers.set('Clear-Site-Data', '"cache"');

    return response;
  } catch (error) {
    // 未验证：密码已核对正确才会走到这里（不泄露账号存在性）。返回 403 + needsVerification，
    // 前端据此提示「去邮箱验证 / 重发验证邮件」。
    if (error instanceof Error && error.message === EMAIL_NOT_VERIFIED_ERROR) {
      logAction(req, 'user.login.unverified', { detail: `邮箱: ${emailKey || 'unknown'}` });
      return NextResponse.json(
        {
          error: '邮箱尚未验证，请先完成邮箱验证',
          needsVerification: true,
          email: emailKey,
        },
        { status: 403 }
      );
    }
    if (error instanceof Error && error.message === 'Invalid credentials') {
      logAction(req, 'user.login.failed', { detail: `邮箱: ${emailKey || 'unknown'}` });
      return invalidCredentialsResponse();
    }
    if (
      error instanceof Error &&
      error.message === LOGIN_THROTTLED_ERROR &&
      accountThrottle.response
    ) {
      return accountThrottle.response;
    }
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
