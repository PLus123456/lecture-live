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
