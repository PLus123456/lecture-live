import { describe, it, expect } from 'vitest';
import {
  isValidEmailAddress,
  isValidDomain,
  normalizeEmail,
  getEmailDomain,
  parseDomainList,
  parseDomainListDetailed,
  domainMatchesList,
  isDisposableEmail,
  isEducationEmail,
  checkRegistrationEmail,
  buildDomainPolicy,
  type DomainPolicy,
} from '@/lib/email/domains';

const emptyPolicy: DomainPolicy = {
  blockDisposable: false,
  disposableExtra: [],
  allowlist: [],
  allowlistEnforce: false,
};

describe('isValidEmailAddress', () => {
  it('接受常规邮箱', () => {
    expect(isValidEmailAddress('user@example.com')).toBe(true);
    expect(isValidEmailAddress('a.b+tag@sub.example.co.uk')).toBe(true);
  });
  it('拒绝非法邮箱', () => {
    for (const bad of [
      '',
      'no-at',
      '@example.com',
      'user@',
      'user@@example.com',
      'user@example',
      'user name@example.com',
      'a..b@example.com',
      '.user@example.com',
      'user@exam ple.com',
    ]) {
      expect(isValidEmailAddress(bad), bad).toBe(false);
    }
  });
  it('拒绝超长本地部分/整体', () => {
    expect(isValidEmailAddress(`${'a'.repeat(65)}@example.com`)).toBe(false);
    expect(isValidEmailAddress(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('isValidDomain', () => {
  it('校验域名标签', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('a.b.c.edu.cn')).toBe(true);
    expect(isValidDomain('example')).toBe(false);
    expect(isValidDomain('-bad.com')).toBe(false);
    expect(isValidDomain('bad-.com')).toBe(false);
    expect(isValidDomain('a..b.com')).toBe(false);
  });
});

describe('normalizeEmail / getEmailDomain', () => {
  it('小写去空白', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });
  it('取域名', () => {
    expect(getEmailDomain('User@Example.com')).toBe('example.com');
    expect(getEmailDomain('bad')).toBeNull();
  });
});

describe('parseDomainList', () => {
  it('解析逗号/换行/空格，去 @ 前缀、去重、丢非法', () => {
    const list = parseDomainList('edu.cn, @stanford.edu\n user@pku.edu.cn ; edu.cn , bad');
    expect(list).toEqual(['edu.cn', 'stanford.edu', 'pku.edu.cn']);
  });
  it('空输入返回空数组', () => {
    expect(parseDomainList('')).toEqual([]);
    expect(parseDomainList(null)).toEqual([]);
  });
});

describe('parseDomainListDetailed（丢弃项必须可见）', () => {
  it('把无法解析的条目按原文回报，而不是静默吞掉', () => {
    const r = parseDomainListDetailed('edu.cn, *.edu.cn, .stanford.edu, edu');
    expect(r.valid).toEqual(['edu.cn']);
    // 原文回显：管理员要认得出自己填的是哪一条
    expect(r.invalid).toEqual(['*.edu.cn', '.stanford.edu', 'edu']);
  });
  it('全部合法时 invalid 为空', () => {
    const r = parseDomainListDetailed('edu.cn\nstanford.edu');
    expect(r.valid).toEqual(['edu.cn', 'stanford.edu']);
    expect(r.invalid).toEqual([]);
  });
  it('纯分隔符/空输入不算配置错误', () => {
    for (const raw of ['', '   ', ' , ; \n ', null, undefined]) {
      const r = parseDomainListDetailed(raw);
      expect(r.valid).toEqual([]);
      expect(r.invalid).toEqual([]);
    }
  });
  it('重复的非法条目只报一次', () => {
    const r = parseDomainListDetailed('*.edu.cn, *.edu.cn');
    expect(r.invalid).toEqual(['*.edu.cn']);
  });
});

describe('domainMatchesList（含子域）', () => {
  it('精确与子域匹配', () => {
    expect(domainMatchesList('edu.cn', ['edu.cn'])).toBe(true);
    expect(domainMatchesList('pku.edu.cn', ['edu.cn'])).toBe(true);
    expect(domainMatchesList('cs.stanford.edu', ['stanford.edu'])).toBe(true);
    expect(domainMatchesList('notedu.cn', ['edu.cn'])).toBe(false); // 不能被后缀误伤
    expect(domainMatchesList('example.com', ['edu.cn'])).toBe(false);
  });
});

describe('isDisposableEmail', () => {
  it('命中内置黑名单', () => {
    const policy = { ...emptyPolicy, blockDisposable: true };
    expect(isDisposableEmail('x@mailinator.com', policy)).toBe(true);
    expect(isDisposableEmail('x@sub.guerrillamail.com', policy)).toBe(true);
    expect(isDisposableEmail('x@gmail.com', policy)).toBe(false);
  });
  it('命中管理员额外黑名单', () => {
    const policy = { ...emptyPolicy, disposableExtra: ['temp-corp.io'] };
    expect(isDisposableEmail('x@temp-corp.io', policy)).toBe(true);
  });
});

describe('isEducationEmail', () => {
  it('识别通用教育域名模式', () => {
    expect(isEducationEmail('a@mit.edu', emptyPolicy)).toBe(true);
    expect(isEducationEmail('a@pku.edu.cn', emptyPolicy)).toBe(true);
    expect(isEducationEmail('a@ox.ac.uk', emptyPolicy)).toBe(true);
    expect(isEducationEmail('a@gmail.com', emptyPolicy)).toBe(false);
  });
  it('命中管理员白名单', () => {
    const policy = { ...emptyPolicy, allowlist: ['myschool.org'] };
    expect(isEducationEmail('a@myschool.org', policy)).toBe(true);
  });
});

describe('checkRegistrationEmail', () => {
  it('格式非法 → invalid_format', () => {
    const r = checkRegistrationEmail('bad', emptyPolicy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_format');
  });
  it('拦截一次性邮箱（开关开）', () => {
    const policy = { ...emptyPolicy, blockDisposable: true };
    const r = checkRegistrationEmail('x@mailinator.com', policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disposable_blocked');
  });
  it('一次性邮箱开关关闭时放行', () => {
    const r = checkRegistrationEmail('x@mailinator.com', emptyPolicy);
    expect(r.ok).toBe(true);
  });
  it('强制白名单：非白名单域名被拒', () => {
    const policy = { ...emptyPolicy, allowlist: ['edu.cn'], allowlistEnforce: true };
    expect(checkRegistrationEmail('x@gmail.com', policy).reason).toBe('not_allowlisted');
    expect(checkRegistrationEmail('x@pku.edu.cn', policy).ok).toBe(true);
  });
  it('非强制白名单：任意合法邮箱放行，但标记教育', () => {
    const policy = { ...emptyPolicy, allowlist: ['edu.cn'], allowlistEnforce: false };
    const r = checkRegistrationEmail('x@pku.edu.cn', policy);
    expect(r.ok).toBe(true);
    expect(r.isEducation).toBe(true);
    expect(checkRegistrationEmail('x@gmail.com', policy).ok).toBe(true);
  });

  // #10：白名单强制开着、管理员填的条目却一条都没解析出来（如 "*.edu.cn"）。
  // 旧实现 allowlist.length>0 不成立 → 直接跳过强制 → 全世界都能注册，而管理员以为已生效。
  it('强制白名单但条目全部非法 → fail-closed，不放行任何人', () => {
    const policy = buildDomainPolicy({
      block_disposable_email: false,
      disposable_email_extra: '',
      email_domain_allowlist: '*.edu.cn',
      email_domain_allowlist_enforce: true,
    });
    expect(policy.allowlist).toEqual([]);
    const r = checkRegistrationEmail('anyone@gmail.com', policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('allowlist_misconfigured');
    // 连管理员本想放行的院校域名也一并拒掉——配置坏了就是坏了，不猜他的意图
    expect(checkRegistrationEmail('x@pku.edu.cn', policy).ok).toBe(false);
  });

  it('强制白名单 + 白名单本就为空 → 维持「不限制」放行（有意行为，非配置错误）', () => {
    const policy = buildDomainPolicy({
      block_disposable_email: false,
      disposable_email_extra: '',
      email_domain_allowlist: '',
      email_domain_allowlist_enforce: true,
    });
    expect(checkRegistrationEmail('x@gmail.com', policy).ok).toBe(true);
  });

  it('部分条目非法时按已解析出的白名单强制（不整体 fail-closed）', () => {
    const policy = buildDomainPolicy({
      block_disposable_email: false,
      disposable_email_extra: '',
      email_domain_allowlist: 'pku.edu.cn, *.edu.cn',
      email_domain_allowlist_enforce: true,
    });
    expect(checkRegistrationEmail('x@pku.edu.cn', policy).ok).toBe(true);
    expect(checkRegistrationEmail('x@gmail.com', policy).reason).toBe('not_allowlisted');
  });
});

describe('buildDomainPolicy', () => {
  it('从 SiteSettings 字段构造', () => {
    const policy = buildDomainPolicy({
      block_disposable_email: true,
      disposable_email_extra: 'temp.io, spam.co',
      email_domain_allowlist: 'edu.cn',
      email_domain_allowlist_enforce: true,
    });
    expect(policy.blockDisposable).toBe(true);
    expect(policy.disposableExtra).toEqual(['temp.io', 'spam.co']);
    expect(policy.allowlist).toEqual(['edu.cn']);
    expect(policy.allowlistEnforce).toBe(true);
    expect(policy.allowlistInvalid).toEqual([]);
  });
  it('把白名单里被丢弃的条目带进 policy（供调用方报错/日志）', () => {
    const policy = buildDomainPolicy({
      block_disposable_email: false,
      disposable_email_extra: '',
      email_domain_allowlist: 'edu.cn, *.edu.cn',
      email_domain_allowlist_enforce: true,
    });
    expect(policy.allowlistInvalid).toEqual(['*.edu.cn']);
  });
});
