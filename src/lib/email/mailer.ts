// src/lib/email/mailer.ts
// nodemailer SMTP 传输层：从 SiteSettings 解析配置、缓存 transporter、发送、连通性校验。
// 另含 e2e/dev「捕获模式」测试接缝：EMAIL_CAPTURE_MODE=1 且非生产时，邮件不真正外发，
// 而是进内存 outbox，供测试通过 dev-only 端点取回验证/重置链接（发信是纯服务端，page.route 拦不到）。

import 'server-only';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getSiteSettings, type SiteSettings } from '@/lib/siteSettings';
import { logger, serializeError } from '@/lib/logger';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  captured?: boolean; // true=进了测试 outbox，未真正外发
}

/** 是否处于测试捕获模式（仅非生产 + 显式开关）。生产环境永远 false。 */
export function isCaptureMode(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.EMAIL_CAPTURE_MODE === '1'
  );
}

/** 从站点设置解析发信配置；host 与发件地址缺一不可视为「未配置」。 */
export function resolveEmailConfig(settings: SiteSettings): EmailConfig | null {
  const host = (settings.smtp_host ?? '').trim();
  const fromEmail = (settings.sender_email ?? '').trim() || (settings.smtp_user ?? '').trim();
  if (!host || !fromEmail) return null;
  return {
    host,
    port: settings.smtp_port || 587,
    secure: settings.smtp_secure,
    user: (settings.smtp_user ?? '').trim(),
    password: settings.smtp_password ?? '',
    fromName: (settings.sender_name ?? '').trim() || settings.site_name || 'LectureLive',
    fromEmail,
  };
}

/** 邮件系统是否可用（配置齐全或处于捕获模式）。门禁/发信前用它判断。 */
export async function isEmailEnabled(settings?: SiteSettings): Promise<boolean> {
  if (isCaptureMode()) return true;
  const s = settings ?? (await getSiteSettings().catch(() => null));
  return !!(s && resolveEmailConfig(s));
}

// ── transporter 缓存：按配置签名缓存，配置变更（签名变）自动重建 ──
let cachedTransporter: Transporter | null = null;
let cachedSignature = '';

function configSignature(cfg: EmailConfig): string {
  return [cfg.host, cfg.port, cfg.secure ? 1 : 0, cfg.user, cfg.password].join('|');
}

function buildTransporter(cfg: EmailConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure, // 465 隐式 TLS；否则明文起步
    // 非隐式 TLS 时要求 STARTTLS 升级（拒绝明文投递）。
    // 端口 25 的豁免收窄到「匿名投递」：老式中继确实常不支持 STARTTLS，但那只在不带凭据时成立。
    // 一旦配了 user/password，无条件豁免就意味着中间人剥掉 STARTTLS 通告即可让我们
    // 明文发出 AUTH LOGIN（base64 的账号密码等于明文）—— 有凭据就绝不接受降级。
    requireTLS: !cfg.secure && !(cfg.port === 25 && !cfg.user),
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function getTransporter(cfg: EmailConfig): Transporter {
  const sig = configSignature(cfg);
  if (!cachedTransporter || sig !== cachedSignature) {
    cachedTransporter = buildTransporter(cfg);
    cachedSignature = sig;
  }
  return cachedTransporter;
}

/** 站点设置更新后调用，丢弃缓存的 transporter。 */
export function invalidateMailer(): void {
  cachedTransporter = null;
  cachedSignature = '';
}

function formatFrom(cfg: EmailConfig): string {
  // 显示名里的引号/反斜杠转义，避免破坏 From 头。
  const name = cfg.fromName.replace(/["\\]/g, '');
  return `"${name}" <${cfg.fromEmail}>`;
}

// ── 测试 outbox（仅捕获模式）──
export interface CapturedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  at: number;
}
const OUTBOX_KEY = '__lectureLiveEmailOutbox';
type OutboxGlobal = typeof globalThis & { [OUTBOX_KEY]?: CapturedEmail[] };
function getOutbox(): CapturedEmail[] {
  const g = globalThis as OutboxGlobal;
  if (!g[OUTBOX_KEY]) g[OUTBOX_KEY] = [];
  return g[OUTBOX_KEY] as CapturedEmail[];
}
/** 取某地址最近一封捕获邮件（测试用）。 */
export function getLastCapturedEmail(to: string): CapturedEmail | null {
  const box = getOutbox();
  for (let i = box.length - 1; i >= 0; i--) {
    if (box[i].to.toLowerCase() === to.toLowerCase()) return box[i];
  }
  return null;
}

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/**
 * 发送一封邮件。捕获模式下写入 outbox 并返回 captured=true；否则走 SMTP。
 * 不抛错——失败以 { ok:false, error } 返回，由调用方决定是否影响主流程（多数为 fire-and-forget）。
 */
export async function sendMail(input: SendMailInput): Promise<SendResult> {
  if (isCaptureMode()) {
    const box = getOutbox();
    box.push({ to: input.to, subject: input.subject, html: input.html, text: input.text, at: Date.now() });
    if (box.length > 200) box.splice(0, box.length - 200);
    logger.info({ to: input.to, subject: input.subject }, '[email] 捕获模式：邮件已入 outbox（未外发）');
    return { ok: true, captured: true };
  }

  const settings = await getSiteSettings().catch(() => null);
  const cfg = settings ? resolveEmailConfig(settings) : null;
  if (!cfg) {
    return { ok: false, error: 'SMTP 未配置' };
  }

  try {
    const transporter = getTransporter(cfg);
    const info = await transporter.sendMail({
      from: formatFrom(cfg),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err: serializeError(err), to: input.to }, '[email] 发送失败');
    return { ok: false, error: err instanceof Error ? err.message : '发送失败' };
  }
}

/** 只保留 override 中已定义的键，避免用 undefined 覆盖已保存配置。 */
function cleanOverride(override?: Partial<EmailConfig>): Partial<EmailConfig> {
  const out: Partial<EmailConfig> = {};
  if (!override) return out;
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

type ResolvedConfig =
  | { ok: true; config: EmailConfig }
  | { ok: false; error: string };

/** SMTP 主机名基础格式校验：挡住带协议头/空白/CRLF/路径的输入。 */
function isValidSmtpHost(host: string): boolean {
  if (!host || host.length > 255) return false;
  // 不禁私网：内网中继（10.x 的 Postfix、本机 MTA）是合法且常见的 SMTP 部署，
  // 照搬 validateCloudreveBaseUrl 的「默认禁私网」会把真实用户的配置打死。
  return !/[\s/\\@]|^[a-z]+:/i.test(host);
}

/**
 * 解析「已保存配置 + 临时覆盖」得到发信配置。用于后台测试（可在保存前试）。
 *
 * 安全约束：已保存的 SMTP 密码只在「目的地与账号都没变」时才继承。密码是绑定在
 * (host, port, user) 上的凭据 —— 调用方一旦改了其中任意一项还沿用已存密码，就等于
 * 让本站把自己的 SMTP 口令投递到对方指定的主机上（`transporter.verify()` 会照常
 * 跑 AUTH LOGIN）。GET 接口特意把密码脱敏成 ******** 防读取，这条路径不能反手把明文送出去。
 * 这里不区分恶意与手滑：管理员把 host 打错成抢注域名，后果完全一样。
 */
async function resolveConfigWithOverride(
  override?: Partial<EmailConfig>
): Promise<ResolvedConfig> {
  const settings = await getSiteSettings({ fresh: true }).catch(() => null);
  const base = settings ? resolveEmailConfig(settings) : null;
  const o = cleanOverride(override);

  if (o.host !== undefined && !isValidSmtpHost(o.host)) {
    return { ok: false, error: 'SMTP 主机名格式不正确' };
  }

  if (base) {
    const retargeted =
      (o.host !== undefined && o.host !== base.host) ||
      (o.port !== undefined && o.port !== base.port) ||
      (o.user !== undefined && o.user !== base.user);
    if (retargeted && o.password === undefined && base.password) {
      return {
        ok: false,
        error: '更换 SMTP 主机 / 端口 / 账号后必须重新填写密码，不会沿用已保存的密码',
      };
    }
    return { ok: true, config: { ...base, ...o } };
  }

  if (o.host && (o.fromEmail || o.user)) {
    return {
      ok: true,
      config: {
        host: o.host,
        port: o.port ?? 587,
        secure: o.secure ?? false,
        user: o.user ?? '',
        password: o.password ?? '',
        fromName: o.fromName ?? 'LectureLive',
        fromEmail: o.fromEmail ?? o.user ?? '',
      },
    };
  }
  return { ok: false, error: 'SMTP 未配置' };
}

/**
 * SMTP 连通性校验（transporter.verify）。用于管理后台「测试连接」。
 * 可传入未保存的临时配置（覆盖已存值）；用临时 transporter，不污染发送缓存、不落 outbox。
 */
export async function verifyEmailConnection(
  override?: Partial<EmailConfig>
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveConfigWithOverride(override);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const cfg = resolved.config;
  try {
    const transporter = buildTransporter(cfg);
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '连接失败' };
  }
}

/**
 * 用「已保存 + 临时覆盖」的配置发送一封邮件（管理后台「发送测试邮件」）。
 * 走临时 transporter，绕过发送缓存与 outbox（即便捕获模式也真发，因为这是管理员主动验证）。
 */
export async function sendMailWithConfig(
  override: Partial<EmailConfig> | undefined,
  input: SendMailInput
): Promise<SendResult> {
  const resolved = await resolveConfigWithOverride(override);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const cfg = resolved.config;
  try {
    const transporter = buildTransporter(cfg);
    const info = await transporter.sendMail({
      from: formatFrom(cfg),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });
    transporter.close();
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err: serializeError(err), to: input.to }, '[email] 测试发送失败');
    return { ok: false, error: err instanceof Error ? err.message : '发送失败' };
  }
}
