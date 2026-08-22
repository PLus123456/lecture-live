import { describe, expect, it } from 'vitest';

import {
  SECRET_MASK,
  findUnsavedEndpoints,
  hasFreshSecret,
  isEndpointRetargeted,
  requiresSecretReentry,
  retargetErrorMessage,
} from '@/lib/credentialRetarget';

describe('credentialRetarget — hasFreshSecret', () => {
  it('掩码 / 空串 / 纯空白 / 非字符串 都算「没给新凭据」', () => {
    expect(hasFreshSecret(SECRET_MASK)).toBe(false);
    expect(hasFreshSecret(`  ${SECRET_MASK}  `)).toBe(false);
    expect(hasFreshSecret('')).toBe(false);
    expect(hasFreshSecret('   ')).toBe(false);
    expect(hasFreshSecret(undefined)).toBe(false);
    expect(hasFreshSecret(null)).toBe(false);
    expect(hasFreshSecret(12345)).toBe(false);
  });

  it('真值才算给了', () => {
    expect(hasFreshSecret('s3cret')).toBe(true);
  });
});

describe('credentialRetarget — isEndpointRetargeted', () => {
  it('next 为 undefined = 本次没提交这一项，不算改', () => {
    expect(
      isEndpointRetargeted([{ current: 'smtp.old.tld', next: undefined }])
    ).toBe(false);
  });

  it('任一分量变化即算改靶', () => {
    expect(
      isEndpointRetargeted([
        { current: 'smtp.old.tld', next: 'smtp.old.tld' },
        { current: 587, next: '2525' },
      ])
    ).toBe(true);
  });

  it('数字/字符串混填、首尾空白、尾部斜杠差异不算改（避免误伤原样回填）', () => {
    expect(isEndpointRetargeted([{ current: 587, next: '587' }])).toBe(false);
    expect(
      isEndpointRetargeted([{ current: 'https://a.tld', next: 'https://a.tld/' }])
    ).toBe(false);
    expect(
      isEndpointRetargeted([{ current: 'https://a.tld', next: ' https://a.tld ' }])
    ).toBe(false);
  });

  it('URL query 值末尾的斜杠必须保留并视为改靶', () => {
    for (const suffix of ['/', '//', '///']) {
      expect(
        isEndpointRetargeted([
          {
            current: 'https://api.vendor.example/v1?tenant=a',
            next: `https://api.vendor.example/v1?tenant=a${suffix}`,
          },
        ])
      ).toBe(true);
    }
  });

  it('URL fragment 末尾的斜杠同样不得被 pathname 归一误删', () => {
    expect(
      isEndpointRetargeted([
        {
          current: 'https://api.vendor.example/v1#tenant-a',
          next: 'https://api.vendor.example/v1#tenant-a/',
        },
      ])
    ).toBe(true);
  });
});

describe('credentialRetarget — requiresSecretReentry', () => {
  const retarget = { current: 'https://old.tld', next: 'https://attacker.tld' };

  it('改端点 + 凭据留掩码 + 库里有凭据 → 必须拒（核心攻击形状）', () => {
    expect(
      requiresSecretReentry({
        endpoint: [retarget],
        hasStoredSecret: true,
        suppliedSecret: SECRET_MASK,
      })
    ).toBe(true);
  });

  it('改端点 + 凭据留空 → 同样拒（空串在写入侧同样是「保持原值」）', () => {
    expect(
      requiresSecretReentry({
        endpoint: [retarget],
        hasStoredSecret: true,
        suppliedSecret: '',
      })
    ).toBe(true);
  });

  it('改端点但本次重填了凭据 → 放行', () => {
    expect(
      requiresSecretReentry({
        endpoint: [retarget],
        hasStoredSecret: true,
        suppliedSecret: 'brand-new-secret',
      })
    ).toBe(false);
  });

  it('库里本来就没凭据 → 没东西可外带，放行', () => {
    expect(
      requiresSecretReentry({
        endpoint: [retarget],
        hasStoredSecret: false,
        suppliedSecret: SECRET_MASK,
      })
    ).toBe(false);
  });

  it('端点没变（只改别的设置）→ 放行，掩码照常保持原值', () => {
    expect(
      requiresSecretReentry({
        endpoint: [{ current: 'https://old.tld', next: 'https://old.tld' }],
        hasStoredSecret: true,
        suppliedSecret: SECRET_MASK,
      })
    ).toBe(false);
  });
});

describe('credentialRetarget — findUnsavedEndpoints', () => {
  it('只调换顺序 / 只取子集 → 不算改靶', () => {
    expect(
      findUnsavedEndpoints(
        ['https://b.tld', 'https://a.tld'],
        ['https://a.tld', 'https://b.tld']
      )
    ).toEqual([]);
    expect(
      findUnsavedEndpoints(['https://a.tld'], ['https://a.tld', 'https://b.tld'])
    ).toEqual([]);
  });

  it('出现未保存过的地址 → 报出来', () => {
    expect(
      findUnsavedEndpoints(
        ['https://a.tld', 'https://attacker.tld'],
        ['https://a.tld']
      )
    ).toEqual(['https://attacker.tld']);
  });
});

describe('credentialRetarget — retargetErrorMessage', () => {
  it('文案点名端点与凭据，管理员知道该重填什么', () => {
    const msg = retargetErrorMessage('SMTP 主机 / 端口 / 账号', 'SMTP 密码');
    expect(msg).toContain('SMTP 主机 / 端口 / 账号');
    expect(msg).toContain('SMTP 密码');
  });
});
