import { describe, it, expect } from 'vitest';
import {
  parsePreferences,
  serializePreferences,
  getEffectivePreferences,
  isCategoryEnabledForUser,
  getUserFacingCategories,
  isKnownCategory,
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
} from '@/lib/email/preferences';

describe('parsePreferences', () => {
  it('解析合法 JSON，忽略未知键与坏值', () => {
    const p = parsePreferences('{"promotions":false,"unknown":true,"quota_alert":"x"}');
    expect(p).toEqual({ promotions: false });
  });
  it('坏 JSON / 空 → {}', () => {
    expect(parsePreferences('not json')).toEqual({});
    expect(parsePreferences(null)).toEqual({});
    expect(parsePreferences('')).toEqual({});
  });
});

describe('serializePreferences', () => {
  it('仅保留可控分类，空 → null', () => {
    expect(serializePreferences({})).toBeNull();
    const s = serializePreferences({ promotions: false, security_alert: false } as never);
    expect(s).toBe('{"promotions":false}'); // security_alert 事务类被剔除
  });
});

describe('getEffectivePreferences', () => {
  it('缺省回落各分类默认（全 true），显式覆盖生效', () => {
    const eff = getEffectivePreferences('{"promotions":false}');
    expect(eff.promotions).toBe(false);
    expect(eff.subscription).toBe(true);
    // 不包含事务类
    expect('security_alert' in eff).toBe(false);
  });
});

describe('isCategoryEnabledForUser', () => {
  it('事务类恒发', () => {
    expect(isCategoryEnabledForUser('security_alert', '{"security_alert":false}', { marketingEnabled: false })).toBe(true);
  });
  it('营销类受站点总开关约束', () => {
    expect(isCategoryEnabledForUser('promotions', null, { marketingEnabled: false })).toBe(false);
    expect(isCategoryEnabledForUser('promotions', null, { marketingEnabled: true })).toBe(true);
  });
  it('非营销通知类只看用户偏好', () => {
    expect(isCategoryEnabledForUser('subscription', null, { marketingEnabled: false })).toBe(true);
    expect(isCategoryEnabledForUser('subscription', '{"subscription":false}', { marketingEnabled: true })).toBe(false);
  });
});

describe('分类元信息', () => {
  it('用户可控分类不含事务类', () => {
    const keys = getUserFacingCategories().map((d) => d.key);
    expect(keys).not.toContain('security_alert');
    expect(keys).toContain('subscription');
    expect(keys).toContain('promotions');
  });
  it('isKnownCategory', () => {
    expect(isKnownCategory('promotions')).toBe(true);
    expect(isKnownCategory('nope')).toBe(false);
  });
});

describe('退订令牌（HMAC 无状态）', () => {
  it('往返：签发→校验得回 userId 与退订范围', () => {
    const token = makeUnsubscribeToken('user_abc123', 'promotions');
    expect(verifyUnsubscribeToken(token)).toEqual({
      userId: 'user_abc123',
      scope: 'promotions',
    });
  });

  it('scope=all 往返', () => {
    const token = makeUnsubscribeToken('user_abc123', 'all');
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: 'user_abc123', scope: 'all' });
  });

  // #8 核心回归：范围签进令牌，收件人不能自行扩权。
  it('把范围改成 all 后签名不符 → null（不能拿促销退订链接关掉全部通知）', () => {
    const token = makeUnsubscribeToken('user_abc123', 'promotions');
    const [id, , exp, sig] = token.split('.');
    expect(verifyUnsubscribeToken(`${id}.all.${exp}.${sig}`)).toBeNull();
  });

  it('把范围改成另一个分类后签名不符 → null', () => {
    const token = makeUnsubscribeToken('user_abc123', 'promotions');
    const [id, , exp, sig] = token.split('.');
    expect(verifyUnsubscribeToken(`${id}.expiry_reminder.${exp}.${sig}`)).toBeNull();
  });

  it('事务类分类（安全提醒）不可作为退订范围', () => {
    const token = makeUnsubscribeToken('user_abc123', 'security_alert' as 'promotions');
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('未知范围 → null', () => {
    const token = makeUnsubscribeToken('user_abc123', 'nonsense' as 'promotions');
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('过期令牌 → null', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = makeUnsubscribeToken('user_abc123', 'promotions', { now, ttlMs: 1000 });
    expect(verifyUnsubscribeToken(token, { now: now + 999 })).not.toBeNull();
    expect(verifyUnsubscribeToken(token, { now: now + 1000 })).toBeNull();
    expect(verifyUnsubscribeToken(token, { now: now + 10_000 })).toBeNull();
  });

  it('延长 exp 后签名不符 → null（有效期不可自行改写）', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = makeUnsubscribeToken('user_abc123', 'promotions', { now, ttlMs: 1000 });
    const [id, scope, , sig] = token.split('.');
    const forged = `${id}.${scope}.${now + 10_000_000}.${sig}`;
    expect(verifyUnsubscribeToken(forged, { now: now + 5000 })).toBeNull();
  });

  it('默认有效期为 180 天量级（远超合规下限，又不是永久）', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = makeUnsubscribeToken('user_abc123', 'promotions', { now });
    const exp = Number(token.split('.')[2]);
    expect(exp - now).toBe(180 * 24 * 60 * 60 * 1000);
  });

  it('篡改签名 → null', () => {
    const token = makeUnsubscribeToken('user_abc123', 'promotions');
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('篡改 userId 段 → null（签名不匹配）', () => {
    const token = makeUnsubscribeToken('user_abc123', 'promotions');
    const [, scope, exp, sig] = token.split('.');
    const forged = `${Buffer.from('user_evil').toString('base64url')}.${scope}.${exp}.${sig}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('格式错误 → null', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('nodot')).toBeNull();
    expect(verifyUnsubscribeToken('.sigonly')).toBeNull();
    expect(verifyUnsubscribeToken('a.b.c')).toBeNull();
    expect(verifyUnsubscribeToken('a.promotions.notanumber.sig')).toBeNull();
  });
});
