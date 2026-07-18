import { test, expect, type Page } from '@playwright/test';
import { fulfillJson, installBrowserStubs } from './helpers';

// 邮箱验证 / 忘记密码 / 重置密码的前端 UX e2e。
// 说明：e2e webServer 指向不可达 DB（无真库），认证真链路（令牌/发信/DB）够不到，
// 故这里用 page.route mock 认证端点，专测新前端页面的交互与状态流转。断言中英双语兜底（默认 en）。

const publicUser = {
  id: 'u1',
  email: 'newuser@example.com',
  displayName: 'New User',
  role: 'FREE',
};

/** 通用路由：site-config + 其余端点良性兜底；各测试再各自覆盖具体 auth 端点。 */
async function baseRoutes(page: Page) {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/api/site-config') {
      return fulfillJson(route, {
        site_name: 'LectureLive QA',
        allow_registration: true,
        password_min_length: 8,
      });
    }
    return fulfillJson(route, {});
  });
}

test('注册开启邮箱验证：进入「去邮箱查收」态并可重发', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'QA', allow_registration: true, password_min_length: 8 });
    }
    if (p === '/api/auth/register' && method === 'POST') {
      return fulfillJson(
        route,
        { verificationRequired: true, email: publicUser.email, message: 'verify your email' },
        201
      );
    }
    if (p === '/api/auth/resend-verification' && method === 'POST') {
      // 服务端真实响应：message 恒为硬编码中文。前端必须忽略它、渲染自己的 i18n 文案。
      return fulfillJson(route, { ok: true, message: '如果该邮箱待验证，我们已重新发送验证邮件。' });
    }
    return fulfillJson(route, {});
  });

  await page.goto('/register');
  await page.locator('input[type="text"]').first().fill('New User');
  await page.locator('input[type="email"]').fill(publicUser.email);
  await page.locator('input[type="password"]').fill('password123');
  await page.locator('button[type="submit"]').first().click();

  // 「去邮箱查收」卡片 + 邮箱地址
  await expect(page.getByText(/Check your email|请查收验证邮件/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(publicUser.email)).toBeVisible();

  // 重发按钮 → 显示回执
  await page.getByRole('button', { name: /Resend verification email|重新发送验证邮件/i }).click();
  await expect(
    page.getByText(/we have resent the verification email|已重新发送验证邮件/i)
  ).toBeVisible({ timeout: 10_000 });
});

test('登录未验证：403 needsVerification → 展示重发入口', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'QA', allow_registration: true });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return fulfillJson(
        route,
        { error: 'email not verified', needsVerification: true, email: publicUser.email },
        403
      );
    }
    if (p === '/api/auth/resend-verification' && method === 'POST') {
      // 服务端真实响应：message 恒为硬编码中文。前端必须忽略它、渲染自己的 i18n 文案。
      return fulfillJson(route, { ok: true, message: '如果该邮箱待验证，我们已重新发送验证邮件。' });
    }
    return fulfillJson(route, {});
  });

  await page.goto('/login');
  await page.locator('input[type="email"]').fill(publicUser.email);
  await page.locator('input[type="password"]').fill('password123');
  await page.locator('button[type="submit"]').first().click();

  // 未验证 → 出现重发按钮（重发入口是关键 UX，断言它无歧义）
  const resendBtn = page.getByRole('button', {
    name: /Resend verification email|重新发送验证邮件/i,
  });
  await expect(resendBtn).toBeVisible({ timeout: 15_000 });
  await resendBtn.click();
  await expect(
    page.getByText(/we have resent the verification email|已重新发送验证邮件/i)
  ).toBeVisible({ timeout: 10_000 });
});

test('登录页有「忘记密码」链接跳到 /forgot-password', async ({ page }) => {
  await baseRoutes(page);
  await page.goto('/login');
  const link = page.getByRole('link', { name: /Forgot password|忘记密码/i });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await expect(page.getByText(/Reset your password|找回密码/i)).toBeVisible();
});

test('忘记密码：提交后进入通用成功态（防枚举）', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/site-config') return fulfillJson(route, { site_name: 'QA' });
    if (p === '/api/auth/forgot-password' && method === 'POST') {
      return fulfillJson(route, {
        ok: true,
        message: '如果该邮箱对应一个账号，我们已发送密码重置邮件，请查收。',
      });
    }
    return fulfillJson(route, {});
  });

  await page.goto('/forgot-password');
  await page.locator('input[type="email"]').fill('whoever@example.com');
  await page.locator('button[type="submit"]').first().click();
  await expect(
    page.getByText(/if that email matches an account|我们已发送密码重置邮件/i)
  ).toBeVisible({ timeout: 15_000 });
});

// 回归：限流响应只有 { error }、没有 message。早先前端写 `data?.message ?? t('已发送')`，
// 于是第 4 次点「发送重置邮件」会显示绿色的「已发送」，用户干等一封永远不会来的信。
test('忘记密码：限流 429 必须显示限流提示，而不是「已发送」', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/site-config') return fulfillJson(route, { site_name: 'QA' });
    if (p === '/api/auth/forgot-password' && method === 'POST') {
      return fulfillJson(route, { error: 'Too many requests' }, 429);
    }
    return fulfillJson(route, {});
  });

  await page.goto('/forgot-password');
  await page.locator('input[type="email"]').fill('whoever@example.com');
  await page.locator('button[type="submit"]').first().click();

  await expect(
    page.getByText(/too many attempts|操作过于频繁/i)
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/if that email matches an account|我们已发送密码重置邮件/i)
  ).toHaveCount(0);
  // 表单要留在原地，用户能改邮箱重试
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('重置密码：密码不一致拦截；一致则成功', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/site-config') return fulfillJson(route, { password_min_length: 8 });
    if (p === '/api/auth/reset-password' && method === 'POST') {
      return fulfillJson(route, { ok: true, message: '密码已重置，请用新密码登录' });
    }
    return fulfillJson(route, {});
  });

  await page.goto('/reset-password?token=fake-token');
  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });

  // 不一致：前端拦截
  await pwInputs.nth(0).fill('password123');
  await pwInputs.nth(1).fill('password999');
  await page.locator('button[type="submit"]').first().click();
  await expect(page.getByText(/do not match|不一致/i)).toBeVisible();

  // 一致：成功态
  await pwInputs.nth(1).fill('password123');
  await page.locator('button[type="submit"]').first().click();
  await expect(page.getByText(/Password reset|密码已重置/i)).toBeVisible({ timeout: 15_000 });
});

test('验证邮件页：挂载即验证，成功显示回执', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === '/api/site-config') return fulfillJson(route, {});
    if (p === '/api/auth/verify-email' && method === 'POST') {
      return fulfillJson(route, { verified: true, user: publicUser, token: '__cookie_session__' });
    }
    // /home 外壳兜底（成功后会跳转）
    if (p === '/api/auth/refresh') return fulfillJson(route, { user: publicUser, token: '__cookie_session__' });
    return fulfillJson(route, {});
  });

  await page.goto('/verify-email?token=fake-token');
  await expect(page.getByText(/Email verified|邮箱验证成功/i)).toBeVisible({ timeout: 15_000 });
});

test('验证邮件页：无 token 直接报错', async ({ page }) => {
  await baseRoutes(page);
  await page.goto('/verify-email');
  await expect(page.getByText(/Missing verification token|缺少验证令牌/i)).toBeVisible({ timeout: 15_000 });
});

// ───────────── 以下为审计 #10 / #11 / #19 的回归 ─────────────

// #11：账号建好了但验证信没发出去。旧实现照样显示绿色的「请查收验证邮件」，
// 用户会一直等一封根本不存在的邮件，而邮箱已被占用（重注册 P2002、登录 403）。
test('注册：验证邮件发送失败时显示告警态，而不是「请查收」', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'QA', allow_registration: true, password_min_length: 8 });
    }
    if (p === '/api/auth/register' && method === 'POST') {
      return fulfillJson(
        route,
        {
          verificationRequired: true,
          emailSendFailed: true,
          email: publicUser.email,
          message: '账号已创建，但验证邮件发送失败，请稍后重试发送',
        },
        201
      );
    }
    return fulfillJson(route, {});
  });

  await page.goto('/register');
  await page.locator('input[type="text"]').first().fill('New User');
  await page.locator('input[type="email"]').fill(publicUser.email);
  await page.locator('input[type="password"]').fill('password123');
  await page.locator('button[type="submit"]').first().click();

  await expect(
    page.getByText(/could not be sent|验证邮件发送失败/i)
  ).toBeVisible({ timeout: 15_000 });
  // 绝不能再显示「请查收」——那正是这个 bug 的谎言
  await expect(page.getByText(/^Check your email$|^请查收验证邮件$/i)).toHaveCount(0);
  // 自助恢复入口仍在
  await expect(
    page.getByRole('button', { name: /Resend verification email|重新发送验证邮件/i })
  ).toBeVisible();
});

// #19：链接里没有 token 时，旧实现渲染一个按钮被 disabled 钉死的表单，
// 提交不了也不解释（缺 token 的报错分支因 disabled 根本走不到）。
test('重置密码页：无 token 时给出解释与重新申请入口，而不是死表单', async ({ page }) => {
  await baseRoutes(page);
  await page.goto('/reset-password');

  await expect(
    page.getByText(/Open this page from the link|需要从密码重置邮件里的链接打开/i)
  ).toBeVisible({ timeout: 15_000 });
  // 死表单不该再出现
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Reset your password|找回密码/i })).toBeVisible();
});

// #19：一次性令牌页必须 replace 而非 push，否则后退键重放已消费的链接，
// 对刚改完密码的用户弹「链接已失效」。
test('重置密码成功后按后退不会回到已消费的令牌页', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (p === '/api/site-config') return fulfillJson(route, { password_min_length: 8 });
    if (p === '/api/auth/reset-password' && method === 'POST') {
      return fulfillJson(route, { ok: true, message: '密码已重置' });
    }
    return fulfillJson(route, {});
  });

  // 先落在 /login，再进重置页，这样「后退」有个明确的去处可断言
  await page.goto('/login');
  await page.goto('/reset-password?token=fake-token');
  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs.first()).toBeVisible({ timeout: 15_000 });
  await pwInputs.nth(0).fill('password123');
  await pwInputs.nth(1).fill('password123');
  await page.locator('button[type="submit"]').first().click();
  await expect(page.getByText(/Password reset|密码已重置/i)).toBeVisible({ timeout: 15_000 });

  // 等自动跳转到 /login（replace 会把 /reset-password 从历史里顶掉）
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  await page.goBack();
  // 后退应回到最初的 /login，而不是带 token 的重置页
  await expect(page).not.toHaveURL(/reset-password/, { timeout: 15_000 });
});

// #10：白名单强制开着但管理员填的条目一条都没解析出来 → 服务端 fail-closed 回 503。
// 前端必须把这个配置故障如实显示出来，而不是静默放行或显示成功。
test('注册：域名白名单配置错误时显示服务端拒绝原因', async ({ page }) => {
  await installBrowserStubs(page);
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (p === '/api/site-config') {
      return fulfillJson(route, { site_name: 'QA', allow_registration: true, password_min_length: 8 });
    }
    if (p === '/api/auth/register' && method === 'POST') {
      return fulfillJson(route, { error: '注册域名白名单配置有误，请联系管理员' }, 503);
    }
    return fulfillJson(route, {});
  });

  await page.goto('/register');
  await page.locator('input[type="text"]').first().fill('New User');
  await page.locator('input[type="email"]').fill(publicUser.email);
  await page.locator('input[type="password"]').fill('password123');
  await page.locator('button[type="submit"]').first().click();

  await expect(page.getByText(/白名单配置有误|请联系管理员/i)).toBeVisible({ timeout: 15_000 });
  // 不得进入「注册成功」的任何形态
  await expect(page.getByText(/Check your email|请查收验证邮件/i)).toHaveCount(0);
});
