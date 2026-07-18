// src/lib/email/templates.ts
// 品牌化邮件模板：统一返回 { subject, html, text }。所有用户可控文本（displayName、IP、
// UA、金额等）经 escapeHtml 转义后再进 HTML，杜绝邮件 XSS/注入。营销/通知类带退订页脚。
//
// 布局用内联样式（邮件客户端不吃 <style>/外链 CSS），配色沿用应用 rust/charcoal/cream 基调。

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = {
  rust: '#C0552F',
  charcoal: '#2B2B2B',
  muted: '#6B6B6B',
  cream: '#FAF7F2',
  border: '#E7DFD5',
};

/** HTML 转义：邮件正文里任何用户/外部数据都必须经它。 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface LayoutParams {
  siteName: string;
  siteUrl: string;
  heading: string;
  bodyHtml: string; // 已转义/可信的 HTML 片段
  cta?: { url: string; label: string };
  footerNote?: string; // 追加说明（如「链接 24 小时内有效」）
  unsubscribeUrl?: string; // 存在则渲染退订页脚（通知/营销类）
}

function button(url: string, label: string): string {
  const safeUrl = escapeHtml(url);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="border-radius:8px;background:${BRAND.rust};">
          <a href="${safeUrl}" target="_blank"
             style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;
                    color:#ffffff;text-decoration:none;border-radius:8px;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function renderLayout(params: LayoutParams): string {
  const { siteName, siteUrl, heading, bodyHtml, cta, footerNote, unsubscribeUrl } = params;
  const safeSite = escapeHtml(siteName);
  const year = ''; // 不注入当前时间（保持模板纯函数、可测）；版权年由 siteName 承载即可
  void year;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px 32px;">
          <div style="font-size:18px;font-weight:700;color:${BRAND.rust};letter-spacing:0.2px;">
            ${safeSite}
          </div>
        </td></tr>
        <tr><td style="padding:8px 32px 0 32px;">
          <h1 style="margin:0 0 12px 0;font-size:20px;font-weight:700;color:${BRAND.charcoal};">
            ${escapeHtml(heading)}
          </h1>
          <div style="font-size:15px;line-height:1.6;color:${BRAND.charcoal};">
            ${bodyHtml}
          </div>
          ${cta ? button(cta.url, cta.label) : ''}
          ${
            footerNote
              ? `<p style="font-size:13px;line-height:1.6;color:${BRAND.muted};margin:8px 0 0 0;">${escapeHtml(
                  footerNote
                )}</p>`
              : ''
          }
        </td></tr>
        <tr><td style="padding:24px 32px 28px 32px;">
          <hr style="border:none;border-top:1px solid ${BRAND.border};margin:0 0 16px 0;">
          <p style="font-size:12px;line-height:1.6;color:${BRAND.muted};margin:0;">
            此邮件由 <a href="${escapeHtml(siteUrl)}" style="color:${BRAND.rust};text-decoration:none;">${safeSite}</a> 自动发送。
            ${
              unsubscribeUrl
                ? `如不想再收到此类通知，可<a href="${escapeHtml(
                    unsubscribeUrl
                  )}" style="color:${BRAND.rust};text-decoration:none;">点此退订</a>。`
                : '这是与你账号安全/服务相关的重要通知。'
            }
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** 纯文本兜底：拼接正文行 + CTA URL + 退订链接。 */
function renderText(lines: string[], opts?: { ctaUrl?: string; unsubscribeUrl?: string; siteName?: string }): string {
  const out = [...lines];
  if (opts?.ctaUrl) {
    out.push('', opts.ctaUrl);
  }
  out.push('', '——', opts?.siteName ?? 'LectureLive');
  if (opts?.unsubscribeUrl) {
    out.push(`退订此类通知：${opts.unsubscribeUrl}`);
  }
  return out.join('\n');
}

interface BrandCtx {
  siteName: string;
  siteUrl: string;
}

// ─────────────────────────── 事务类（恒发） ───────────────────────────

export function verificationEmail(
  ctx: BrandCtx,
  params: { displayName: string; verifyUrl: string }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">感谢注册 ${escapeHtml(ctx.siteName)}。请点击下方按钮验证你的邮箱地址，完成后即可登录使用。</p>`;
  return {
    subject: `验证你的邮箱 · ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: '验证你的邮箱',
      bodyHtml,
      cta: { url: params.verifyUrl, label: '验证邮箱' },
      footerNote: '链接 24 小时内有效。如果这不是你本人操作，请忽略此邮件。',
    }),
    text: renderText(
      [
        `你好 ${params.displayName}，`,
        '',
        `感谢注册 ${ctx.siteName}。请打开以下链接验证你的邮箱（24 小时内有效）：`,
      ],
      { ctaUrl: params.verifyUrl, siteName: ctx.siteName }
    ),
  };
}

export function passwordResetEmail(
  ctx: BrandCtx,
  params: { displayName: string; resetUrl: string }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">我们收到了重置你账号密码的请求。点击下方按钮设置新密码。若非你本人操作，请忽略此邮件，你的密码不会被更改。</p>`;
  return {
    subject: `重置密码 · ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: '重置你的密码',
      bodyHtml,
      cta: { url: params.resetUrl, label: '设置新密码' },
      footerNote: '链接 1 小时内有效，且只能使用一次。重置成功后，你在其它设备的登录状态都会失效。',
    }),
    text: renderText(
      [
        `你好 ${params.displayName}，`,
        '',
        '点击以下链接重置密码（1 小时内有效，单次使用）。若非你本人操作请忽略：',
      ],
      { ctaUrl: params.resetUrl, siteName: ctx.siteName }
    ),
  };
}

export function welcomeEmail(
  ctx: BrandCtx,
  params: { displayName: string }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">你的邮箱已验证成功，欢迎加入 ${escapeHtml(ctx.siteName)}！现在就可以开始你的实时课堂转录之旅了。</p>`;
  return {
    subject: `欢迎加入 ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: `欢迎加入 ${ctx.siteName}`,
      bodyHtml,
      cta: { url: ctx.siteUrl, label: '进入应用' },
    }),
    text: renderText(
      [`你好 ${params.displayName}，`, '', `你的邮箱已验证成功，欢迎加入 ${ctx.siteName}！`],
      { ctaUrl: ctx.siteUrl, siteName: ctx.siteName }
    ),
  };
}

/** 安全告警：改密成功 / 新设备登录。事务类，恒发。 */
export function securityAlertEmail(
  ctx: BrandCtx,
  params: {
    displayName: string;
    kind: 'password_changed' | 'new_device_login';
    ip?: string | null;
    when?: string | null; // 已格式化的时间字符串（调用方注入，保持模板纯函数）
    userAgent?: string | null;
  }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const isPwd = params.kind === 'password_changed';
  const title = isPwd ? '你的密码已被修改' : '检测到新设备登录';
  const lead = isPwd
    ? '你的账号密码刚刚被修改。如果是你本人操作，无需理会此邮件。'
    : '你的账号刚刚在一个新的设备或位置登录。如果是你本人操作，无需理会此邮件。';
  const details: string[] = [];
  if (params.when) details.push(`时间：${escapeHtml(params.when)}`);
  if (params.ip) details.push(`IP：${escapeHtml(params.ip)}`);
  if (params.userAgent) details.push(`设备：${escapeHtml(params.userAgent)}`);
  const detailHtml = details.length
    ? `<div style="margin:12px 0;padding:12px 14px;background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:8px;font-size:13px;color:${BRAND.muted};">${details
        .map((d) => `<div>${d}</div>`)
        .join('')}</div>`
    : '';
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">${lead}</p>
    ${detailHtml}
    <p style="margin:12px 0 0 0;">如果<strong>不是你本人</strong>，请立即重置密码并检查账号安全。</p>`;
  return {
    subject: `${title} · ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: title,
      bodyHtml,
      cta: { url: `${ctx.siteUrl}/settings`, label: '检查账号安全' },
    }),
    text: renderText(
      [
        `你好 ${params.displayName}，`,
        '',
        lead,
        ...details,
        '',
        '如果不是你本人操作，请立即重置密码。',
      ],
      { ctaUrl: `${ctx.siteUrl}/settings`, siteName: ctx.siteName }
    ),
  };
}

// ─────────────────────────── 通知类（受偏好/总开关约束，带退订） ───────────────────────────

export function subscriptionSuccessEmail(
  ctx: BrandCtx,
  params: {
    displayName: string;
    planName: string;
    amountLabel?: string | null; // 如 "¥39.00"
    expiresLabel?: string | null; // 如 "2026-08-18" 或 "永久有效"
    unsubscribeUrl: string;
  }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const rows: string[] = [`套餐：${escapeHtml(params.planName)}`];
  if (params.amountLabel) rows.push(`金额：${escapeHtml(params.amountLabel)}`);
  if (params.expiresLabel) rows.push(`有效期至：${escapeHtml(params.expiresLabel)}`);
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">你的订阅/购买已成功，感谢支持！</p>
    <div style="margin:12px 0;padding:12px 14px;background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:8px;font-size:14px;">
      ${rows.map((r) => `<div>${r}</div>`).join('')}
    </div>`;
  return {
    subject: `订阅成功 · ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: '订阅成功',
      bodyHtml,
      cta: { url: ctx.siteUrl, label: '进入应用' },
      unsubscribeUrl: params.unsubscribeUrl,
    }),
    text: renderText(
      [`你好 ${params.displayName}，`, '', '你的订阅/购买已成功：', ...rows],
      { ctaUrl: ctx.siteUrl, unsubscribeUrl: params.unsubscribeUrl, siteName: ctx.siteName }
    ),
  };
}

export function expiryReminderEmail(
  ctx: BrandCtx,
  params: {
    displayName: string;
    planName: string;
    expiresLabel: string;
    daysLeft: number;
    unsubscribeUrl: string;
  }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">你的 <strong>${escapeHtml(params.planName)}</strong> 会员将于
      <strong>${escapeHtml(params.expiresLabel)}</strong>（约 ${escapeHtml(
        String(params.daysLeft)
      )} 天后）到期。为避免服务中断，请及时续订。</p>`;
  return {
    subject: `会员即将到期 · ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: '会员即将到期',
      bodyHtml,
      cta: { url: `${ctx.siteUrl}/settings`, label: '立即续订' },
      unsubscribeUrl: params.unsubscribeUrl,
    }),
    text: renderText(
      [
        `你好 ${params.displayName}，`,
        '',
        `你的 ${params.planName} 会员将于 ${params.expiresLabel}（约 ${params.daysLeft} 天后）到期，请及时续订。`,
      ],
      { ctaUrl: `${ctx.siteUrl}/settings`, unsubscribeUrl: params.unsubscribeUrl, siteName: ctx.siteName }
    ),
  };
}

export function quotaAlertEmail(
  ctx: BrandCtx,
  params: {
    displayName: string;
    quotaLabel: string; // 如 "转录分钟"
    usedLabel: string; // 如 "57 / 60 分钟"
    percentLabel: string; // 如 "95%"
    unsubscribeUrl: string;
  }
): RenderedEmail {
  const name = escapeHtml(params.displayName);
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">你好 ${name}，</p>
    <p style="margin:0;">你本月的 <strong>${escapeHtml(params.quotaLabel)}</strong> 配额已使用
      <strong>${escapeHtml(params.percentLabel)}</strong>（${escapeHtml(params.usedLabel)}）。
      用尽后相关功能将暂停，直到下个周期重置或升级/充值。</p>`;
  return {
    subject: `${params.quotaLabel}配额即将用尽 · ${ctx.siteName}`,
    html: renderLayout({
      ...ctx,
      heading: '配额即将用尽',
      bodyHtml,
      cta: { url: `${ctx.siteUrl}/settings`, label: '查看用量 / 升级' },
      unsubscribeUrl: params.unsubscribeUrl,
    }),
    text: renderText(
      [
        `你好 ${params.displayName}，`,
        '',
        `你本月的${params.quotaLabel}配额已使用 ${params.percentLabel}（${params.usedLabel}）。`,
      ],
      { ctaUrl: `${ctx.siteUrl}/settings`, unsubscribeUrl: params.unsubscribeUrl, siteName: ctx.siteName }
    ),
  };
}

/** 通用通知/公告/促销（管理员自定义主题与正文）。bodyText 会被转义。 */
export function genericNotificationEmail(
  ctx: BrandCtx,
  params: {
    subject: string;
    heading: string;
    bodyText: string; // 纯文本，按段落换行渲染（转义）
    cta?: { url: string; label: string };
    unsubscribeUrl: string;
  }
): RenderedEmail {
  const paragraphs = params.bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    subject: params.subject,
    html: renderLayout({
      ...ctx,
      heading: params.heading,
      bodyHtml: paragraphs,
      cta: params.cta,
      unsubscribeUrl: params.unsubscribeUrl,
    }),
    text: renderText([params.bodyText], {
      ctaUrl: params.cta?.url,
      unsubscribeUrl: params.unsubscribeUrl,
      siteName: ctx.siteName,
    }),
  };
}

/** 管理员 SMTP 连通性测试邮件。 */
export function testEmail(ctx: BrandCtx): RenderedEmail {
  const bodyHtml = `
    <p style="margin:0 0 12px 0;">这是一封来自 ${escapeHtml(ctx.siteName)} 的测试邮件。</p>
    <p style="margin:0;">如果你收到了它，说明你的 SMTP 发信配置工作正常。 ✅</p>`;
  return {
    subject: `SMTP 测试邮件 · ${ctx.siteName}`,
    html: renderLayout({ ...ctx, heading: 'SMTP 测试邮件', bodyHtml }),
    text: renderText(
      [`这是一封来自 ${ctx.siteName} 的测试邮件。`, '', '如果你收到了它，说明 SMTP 发信配置工作正常。'],
      { siteName: ctx.siteName }
    ),
  };
}
