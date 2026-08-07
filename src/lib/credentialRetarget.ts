// src/lib/credentialRetarget.ts
// 「改端点必须重填凭据」规则的唯一实现（纯函数，无依赖）。
//
// 威胁模型：后台对已保存的密钥/口令/token 一律只回脱敏占位（GET 拿不到明文），防的是「读回来」。
// 但凭据是**绑定在端点上**的：只要允许「只改地址、密钥留空 = 沿用旧值」，攻击者就能反手让
// 服务端把解密后的真实凭据主动投递到新地址 —— SMTP 的 AUTH LOGIN、worker / LLM 的
// Authorization: Bearer 都是一次握手就送出去。这条反向通道绕的正是脱敏，从 GET 侧堵不住。
//
// ⚠️ 适用范围：**当前只有 SMTP 一处在用**（admin/settings 的 smtp_host/port/user → smtp_password）。
// Cloudreve / 音频增强 worker / 翻译 worker / LLM apiBase / Soniox 都已刻意放开：那些是自建服务，
// 机器 IP 一变就得改地址，却要求重填一把可能根本取不回来的密钥（LLM 厂商的 key 多数只在创建时
// 显示一次），代价大于收益。这是个明确的范围决定，各路由的测试都把它固化住了。
// 想再加行之前先读 admin/settings/route.ts 里 retargetGuards 上方那段说明（含残余风险与收口方向）。
//
// 保留 SMTP 的理由：邮件服务商地址几乎不变（改它基本只有换靶一种解释），而 SMTP 口令常常就是
// 邮箱账号本身的密码、在别处复用，外带出去破坏面最大；且管理员一定知道这个口令，重填成本≈0。

/** 脱敏占位符。GET 回传它表示「已配置但隐藏」；PUT 收到它表示「保持原值」。 */
export const SECRET_MASK = '********';

/**
 * 端点比较的归一：trim + 去尾斜杠。
 * 落库时本来就按去尾斜杠存（parseWorkerUrls / validateSonioxRestUrl / worker baseUrl），
 * 这里对齐口径，避免管理员原样回填 `https://x/` 被误判成「改靶」而白挨一个 400。
 */
function normalizeEndpoint(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/\/+$/, '');
}

/** 本次请求是否**真的**给出了新凭据。非字符串 / 空串 / 纯空白 / 脱敏占位 都算「没给」。 */
export function hasFreshSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== SECRET_MASK;
}

/** 端点的「已存值 → 本次提交值」；next 为 undefined = 本次没提交这一项，不算改。 */
export interface EndpointChange {
  current: unknown;
  next: unknown;
}

/** 端点是否被改写（任一分量变化即算）。 */
export function isEndpointRetargeted(changes: EndpointChange[]): boolean {
  return changes.some(
    ({ current, next }) =>
      next !== undefined && normalizeEndpoint(current) !== normalizeEndpoint(next)
  );
}

export interface SecretReentryInput {
  /** 端点各分量的变化。 */
  endpoint: EndpointChange[];
  /** 库里是否已有一份可被外带的凭据。没有 = 没东西可泄露，放行。 */
  hasStoredSecret: boolean;
  /** 本次请求提交的凭据原值（空/掩码 = 想沿用已存值）。 */
  suppliedSecret: unknown;
}

/** 该拒绝这次请求吗？true = 改了端点却想沿用已存凭据。 */
export function requiresSecretReentry(input: SecretReentryInput): boolean {
  if (!input.hasStoredSecret) return false;
  if (hasFreshSecret(input.suppliedSecret)) return false;
  return isEndpointRetargeted(input.endpoint);
}

/**
 * 多端点（一份凭据配一组地址）场景：找出本次要访问的、**不在已保存集合里**的地址。
 * 用集合而不是整串比对，是为了让「只调换顺序 / 只探测其中一台」不被误拒。
 */
export function findUnsavedEndpoints(
  requested: readonly string[],
  saved: readonly string[]
): string[] {
  const allowed = new Set(saved.map(normalizeEndpoint));
  return requested.filter((url) => !allowed.has(normalizeEndpoint(url)));
}

/** 统一错误文案（面向管理员，说清为什么必须重填）。 */
export function retargetErrorMessage(
  endpointLabel: string,
  secretLabel: string
): string {
  return `更换${endpointLabel}后必须重新填写${secretLabel}，不会沿用已保存的凭据`;
}
