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
  it('往返：签发→校验得回 userId', () => {
    const token = makeUnsubscribeToken('user_abc123');
    expect(verifyUnsubscribeToken(token)).toBe('user_abc123');
  });
  it('篡改签名 → null', () => {
    const token = makeUnsubscribeToken('user_abc123');
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });
  it('篡改 userId 段 → null（签名不匹配）', () => {
    const token = makeUnsubscribeToken('user_abc123');
    const sig = token.split('.')[1];
    const forged = `${Buffer.from('user_evil').toString('base64url')}.${sig}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });
  it('格式错误 → null', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('nodot')).toBeNull();
    expect(verifyUnsubscribeToken('.sigonly')).toBeNull();
  });
});
