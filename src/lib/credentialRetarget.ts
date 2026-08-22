// src/lib/credentialRetarget.ts
// 「改端点必须重填凭据」规则的唯一实现（纯函数，无依赖）。
//
// 威胁模型：后台对已保存的密钥/口令/token 一律只回脱敏占位（GET 拿不到明文），防的是「读回来」。
// 但凭据是**绑定在端点上**的：只要允许「只改地址、密钥留空 = 沿用旧值」，攻击者就能反手让
// 服务端把解密后的真实凭据主动投递到新地址 —— SMTP 的 AUTH LOGIN、worker / LLM 的
// Authorization: Bearer 都是一次握手就送出去。这条反向通道绕的正是脱敏，从 GET 侧堵不住。
//
// 适用范围：SMTP 和 LLM provider 的写入边界使用本规则。其他自建 worker/存储
// 端点是否强制重绑凭据，必须在各自路由上按威胁模型明确决定；不得把本 helper
// 不在某路由使用解读为“旧凭据可以安全发往新主机”。
//
// 保留 SMTP 的理由：邮件服务商地址几乎不变（改它基本只有换靶一种解释），而 SMTP 口令常常就是
// 邮箱账号本身的密码、在别处复用，外带出去破坏面最大；且管理员一定知道这个口令，重填成本≈0。

/** 脱敏占位符。GET 回传它表示「已配置但隐藏」；PUT 收到它表示「保持原值」。 */
export const SECRET_MASK = '********';

/**
 * 端点比较的归一：trim + 去 URL pathname 尾斜杠。
 * 落库时本来就按去尾斜杠存（parseWorkerUrls / validateSonioxRestUrl / worker baseUrl），
 * 这里对齐口径，避免管理员原样回填 `https://x/` 被误判成「改靶」而白挨一个 400。
 */
export function normalizeCredentialEndpoint(value: unknown): string {
  if (value === undefined || value === null) return '';
  const trimmed = String(value).trim();

  // 不能对整个 URL 做 `/\\/+$/`：斜杠可以属于 query 值，例如
  // `?tenant=a///`。把它们抹掉会把真实不同的落库/请求目标判成相同，
  // 从而绕过“换靶必须重填密钥”。对 HTTP(S) 只归一 pathname，完整保留
  // search/hash；非 URL 端点（SMTP host、端口等）继续沿用原有行为。
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const pathname = parsed.pathname.replace(/\/+$/, '');
      const auth = parsed.username
        ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
        : '';
      // 显式按 URL 分量重建，不能再对 serialized URL 做尾斜杠替换；
      // 否则 search/hash 最后一个 `/` 仍会被误删。
      return `${parsed.protocol}//${auth}${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // 非 URL 分量由下方的通用归一处理。
  }

  return trimmed.replace(/\/+$/, '');
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
      next !== undefined &&
      normalizeCredentialEndpoint(current) !== normalizeCredentialEndpoint(next)
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
  const allowed = new Set(saved.map(normalizeCredentialEndpoint));
  return requested.filter(
    (url) => !allowed.has(normalizeCredentialEndpoint(url))
  );
}

/** 统一错误文案（面向管理员，说清为什么必须重填）。 */
export function retargetErrorMessage(
  endpointLabel: string,
  secretLabel: string
): string {
  return `更换${endpointLabel}后必须重新填写${secretLabel}，不会沿用已保存的凭据`;
}
