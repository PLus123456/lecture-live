import { describe, it, expect } from 'vitest';
import { getTrustedForwardedIp } from '@/lib/clientIp';

// 安全回归：nginx 用 $proxy_add_x_forwarded_for 会把客户端自带的 X-Forwarded-For
// 原样透传 + 在末尾追加真实 $remote_addr。故最左段是攻击者可伪造的（用来绕过 IP
// 限流/连接上限或污染审计日志），必须取【最后】一段（反代写入的真实来源）。
describe('getTrustedForwardedIp', () => {
  it('取最后一段，忽略可伪造的最左段', () => {
    expect(getTrustedForwardedIp('1.1.1.1, 2.2.2.2, 3.3.3.3')).toBe('3.3.3.3');
  });

  it('攻击者伪造首段也不会被采信', () => {
    // 攻击者发 "X-Forwarded-For: 9.9.9.9"，nginx 追加真实客户端 8.8.8.8
    expect(getTrustedForwardedIp('9.9.9.9, 8.8.8.8')).toBe('8.8.8.8');
  });

  it('单段直接返回', () => {
    expect(getTrustedForwardedIp('7.7.7.7')).toBe('7.7.7.7');
  });

  it('含空白条目时仍取最后一个有效段', () => {
    expect(getTrustedForwardedIp('1.1.1.1,  , 4.4.4.4')).toBe('4.4.4.4');
  });

  it('空串 / null / undefined 返回 null', () => {
    expect(getTrustedForwardedIp('')).toBeNull();
    expect(getTrustedForwardedIp(null)).toBeNull();
    expect(getTrustedForwardedIp(undefined)).toBeNull();
    expect(getTrustedForwardedIp('   ')).toBeNull();
  });
});
