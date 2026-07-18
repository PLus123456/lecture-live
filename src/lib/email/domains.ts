// src/lib/email/domains.ts
// 邮箱地址校验 + 域名管控：一次性/临时邮箱黑名单、教育邮箱识别、注册白名单强制。
// 纯函数、无 IO，便于单测；站点配置（黑白名单）由调用方从 SiteSettings 传入。

/**
 * 邮箱地址格式校验。刻意比 `<input type=email>` 更严一点，但不追求 RFC 5322 全量
 * （那反而会放过/误杀边缘用例）：单个 @，本地部分与域名非空，域名含点且各标签合法，
 * 无空白、无连续点、总长受限。够挡住绝大多数无效/注入型输入。
 */
export function isValidEmailAddress(email: string): boolean {
  if (typeof email !== 'string') return false;
  const value = email.trim();
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;

  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) return false;

  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);

  // 本地部分：1~64 字符，允许常见可打印字符，禁止首尾点与连续点。
  if (local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return false;
  }
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;

  return isValidDomain(domain);
}

/** 域名合法性：至少两段、各标签 1~63 字符且只含字母数字连字符、不以连字符开头结尾。 */
export function isValidDomain(domain: string): boolean {
  if (typeof domain !== 'string') return false;
  const value = domain.trim().toLowerCase();
  if (value.length === 0 || value.length > 253) return false;
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    return false;
  }
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-')
  );
}

/** 归一化邮箱：去空白 + 小写。存库与限流 key 统一走它。 */
export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

/** 取邮箱域名（已小写）；非法邮箱返回 null。 */
export function getEmailDomain(email: string): string | null {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;
  return normalized.slice(atIndex + 1);
}

export interface DomainListParse {
  valid: string[];   // 归一化后的合法域名（小写、去重、去 @ 前缀与尾点）
  invalid: string[]; // 无法解析的原始条目（保留用户输入原文，用于报错回显）
}

/**
 * 解析逗号/换行/空格分隔的域名列表，**同时返回被丢弃的条目**。
 * 丢弃项必须能被调用方看见：静默吞掉 `*.edu.cn` 这类通配写法会让管理员以为白名单已生效，
 * 而实际解析结果为空 —— 强制开关随即变成"谁都能注册"（见 checkRegistrationEmail 的 fail-closed）。
 */
export function parseDomainListDetailed(
  raw: string | null | undefined
): DomainListParse {
  if (!raw) return { valid: [], invalid: [] };
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalidSeen = new Set<string>();
  const invalid: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const original = piece.trim();
    if (!original) continue;
    let d = original.toLowerCase();
    // 容错：用户可能粘贴 "@edu.cn" 或 "user@edu.cn"
    const at = d.lastIndexOf('@');
    if (at >= 0) d = d.slice(at + 1);
    d = d.replace(/\.+$/, '');
    if (!isValidDomain(d)) {
      // 回显原文（而非清洗后的残渣），管理员才认得出自己填的是哪一条
      if (!invalidSeen.has(original)) {
        invalidSeen.add(original);
        invalid.push(original);
      }
      continue;
    }
    if (seen.has(d)) continue;
    seen.add(d);
    valid.push(d);
  }
  return { valid, invalid };
}

/** 解析逗号/换行/空格分隔的域名列表：小写、去 @ 前缀、去重、丢弃非法项。 */
export function parseDomainList(raw: string | null | undefined): string[] {
  return parseDomainListDetailed(raw).valid;
}

/**
 * 域名是否匹配列表中某一项（含子域）：列表项 "edu.cn" 命中 "edu.cn" 与 "pku.edu.cn"；
 * 列表项 "stanford.edu" 命中 "stanford.edu" 与 "cs.stanford.edu"。用于白名单与黑名单统一匹配。
 */
export function domainMatchesList(domain: string, list: string[]): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  return list.some((entry) => d === entry || d.endsWith(`.${entry}`));
}

/**
 * 内置一次性/临时邮箱域名黑名单（常见批量注册来源）。非穷举——管理员可通过
 * disposable_email_extra 追加。匹配走 domainMatchesList（含子域）。
 */
export const BUILTIN_DISPOSABLE_DOMAINS: readonly string[] = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamail.biz',
  'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com',
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'temp-mail.org', 'tempmail.com',
  'tempmailo.com', 'tempr.email', 'tempmail.net', 'tmpmail.org', 'tmpmail.net', 'tmpeml.com',
  'throwawaymail.com', 'throwaway.email', 'getnada.com', 'nada.email', 'maildrop.cc',
  'mailnesia.com', 'mailcatch.com', 'trashmail.com', 'trashmail.de', 'trashmail.net',
  'wegwerfmail.de', 'wegwerfmail.net', 'yopmail.com', 'yopmail.net', 'yopmail.fr',
  'cool.fr.nf', 'jetable.org', 'jetable.com', 'spam4.me', 'dispostable.com', 'fakeinbox.com',
  'fakemailgenerator.com', 'emailondeck.com', 'mohmal.com', 'mytemp.email', 'moakt.com',
  'mailtemp.net', 'mail-temp.com', 'inboxbear.com', 'burnermail.io', 'mailsac.com',
  'mail7.io', 'mailpoof.com', 'harakirimail.com', 'discard.email', 'discardmail.com',
  'spamgourmet.com', 'mvrht.com', 'mailexpire.com', 'mail.tm', 'linshiyouxiang.net',
  'chacuo.net', 'bccto.me', '027168.com', '0815.ru', 'anonbox.net', 'einrot.com',
  'incognitomail.org', 'mailismagic.com', 'no-spam.ws', 'objectmail.com', 'proxymail.eu',
  'rcpt.at', 'safetymail.info', 'sogetthis.com', 'spambog.com', 'spambox.us', 'tempinbox.com',
  'temporaryemail.net', 'trbvm.com', 'wh4f.org', 'willselfdestruct.com', 'wuzup.net',
  'emailfake.com', 'fakermail.com', 'luxusmail.org', 'vomoto.com', 'byom.de',
];

export interface DomainPolicy {
  blockDisposable: boolean;
  disposableExtra: string[]; // 额外黑名单域名（已 parseDomainList）
  allowlist: string[];       // 白名单/教育域名（已 parseDomainList）
  allowlistEnforce: boolean; // true=只有白名单域名能注册
  /**
   * 白名单里被丢弃的非法条目（原文）。非空 + allowlist 为空 = 管理员填了内容但一条都没解析出来，
   * 此时强制开关必须 fail-closed，否则等于静默失效。手工构造 policy 时可省略。
   */
  allowlistInvalid?: string[];
}

/** 从 SiteSettings 的原始字段构造域名策略。 */
export function buildDomainPolicy(settings: {
  block_disposable_email: boolean;
  disposable_email_extra: string;
  email_domain_allowlist: string;
  email_domain_allowlist_enforce: boolean;
}): DomainPolicy {
  const allowlistParsed = parseDomainListDetailed(settings.email_domain_allowlist);
  return {
    blockDisposable: settings.block_disposable_email,
    disposableExtra: parseDomainList(settings.disposable_email_extra),
    allowlist: allowlistParsed.valid,
    allowlistInvalid: allowlistParsed.invalid,
    allowlistEnforce: settings.email_domain_allowlist_enforce,
  };
}

/** 是否一次性/临时邮箱（内置 + 额外黑名单）。 */
export function isDisposableEmail(email: string, policy: DomainPolicy): boolean {
  const domain = getEmailDomain(email);
  if (!domain) return false;
  return (
    domainMatchesList(domain, BUILTIN_DISPOSABLE_DOMAINS as string[]) ||
    domainMatchesList(domain, policy.disposableExtra)
  );
}

/**
 * 是否教育邮箱：命中管理员白名单，或匹配通用教育域名模式（.edu / .edu.<国> / .ac.<国>）。
 * 即便白名单为空也能识别常见 .edu，满足「收集教育邮箱」的开箱诉求；白名单可扩充本地院校域名。
 */
export function isEducationEmail(email: string, policy: DomainPolicy): boolean {
  const domain = getEmailDomain(email);
  if (!domain) return false;
  if (domainMatchesList(domain, policy.allowlist)) return true;
  return (
    domain === 'edu' ||
    domain.endsWith('.edu') ||
    /\.edu\.[a-z]{2,}$/.test(domain) ||
    /\.ac\.[a-z]{2,}$/.test(domain)
  );
}

export type RegistrationEmailRejection =
  | 'invalid_format'
  | 'disposable_blocked'
  | 'not_allowlisted'
  | 'allowlist_misconfigured';

export interface RegistrationEmailCheck {
  ok: boolean;
  reason?: RegistrationEmailRejection;
  isEducation: boolean;
}

/**
 * 注册邮箱综合准入：格式 → 一次性拦截 → 白名单强制。返回是否放行、拒绝原因、是否教育邮箱
 * （用于打标/统计，不影响放行）。防枚举的措辞由调用方决定，这里只给机器可读的原因码。
 */
export function checkRegistrationEmail(
  email: string,
  policy: DomainPolicy
): RegistrationEmailCheck {
  const isEducation = isEducationEmail(email, policy);

  if (!isValidEmailAddress(email)) {
    return { ok: false, reason: 'invalid_format', isEducation: false };
  }
  if (policy.blockDisposable && isDisposableEmail(email, policy)) {
    return { ok: false, reason: 'disposable_blocked', isEducation };
  }
  if (policy.allowlistEnforce) {
    if (policy.allowlist.length === 0) {
      // 白名单整体解析失败（管理员填了 "*.edu.cn" 之类，一条都不合法）。放行所有人等于
      // 静默架空他显式开启的强制开关，故 fail-closed 并让调用方把配置错误报出来。
      // 与「白名单本就为空」区分：那是有意的"不限制"，保持放行。
      if ((policy.allowlistInvalid?.length ?? 0) > 0) {
        return { ok: false, reason: 'allowlist_misconfigured', isEducation };
      }
    } else {
      const domain = getEmailDomain(email);
      if (!domain || !domainMatchesList(domain, policy.allowlist)) {
        return { ok: false, reason: 'not_allowlisted', isEducation };
      }
    }
  }
  return { ok: true, isEducation };
}
