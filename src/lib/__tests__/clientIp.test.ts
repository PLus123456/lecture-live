import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTrustedForwardedIp,
  normalizeClientIp,
  resolveRequestClientIp,
  resolveSocketClientIp,
  validateTrustedProxyConfiguration,
} from '@/lib/clientIp';

const ORIGINAL_HOPS = process.env.TRUSTED_PROXY_HOPS;
const ORIGINAL_CIDRS = process.env.TRUSTED_PROXY_CIDRS;

function setProxyConfig(hops?: string, cidrs?: string) {
  if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = hops;
  if (cidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = cidrs;
}

function request(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/test', { headers });
}

beforeEach(() => setProxyConfig());

afterEach(() => {
  if (ORIGINAL_HOPS === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = ORIGINAL_HOPS;
  if (ORIGINAL_CIDRS === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = ORIGINAL_CIDRS;
});

describe('IP normalization', () => {
  it('normalizes mapped IPv4 and safe host:port forms', () => {
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('203.0.113.7:54321')).toBe('203.0.113.7');
    expect(normalizeClientIp('[2001:db8::7]:443')).toBe('2001:db8::7');
  });

  it('rejects names, zone IDs, and malformed values', () => {
    expect(normalizeClientIp('attacker.example')).toBeNull();
    expect(normalizeClientIp('fe80::1%eth0')).toBeNull();
    expect(normalizeClientIp('')).toBeNull();
  });
});

describe('getTrustedForwardedIp compatibility helper', () => {
  it('取最后一段，忽略可伪造的最左段', () => {
    expect(getTrustedForwardedIp('1.1.1.1, 2.2.2.2, 3.3.3.3')).toBe('3.3.3.3');
  });

  it('攻击者伪造首段也不会被采信', () => {
    expect(getTrustedForwardedIp('9.9.9.9, 8.8.8.8')).toBe('8.8.8.8');
  });

  it('空串 / null / undefined / 非 IP 返回 null', () => {
    expect(getTrustedForwardedIp('')).toBeNull();
    expect(getTrustedForwardedIp(null)).toBeNull();
    expect(getTrustedForwardedIp(undefined)).toBeNull();
    expect(getTrustedForwardedIp('attacker.example')).toBeNull();
  });
});

describe('HTTP trusted proxy topology', () => {
  it('安全默认是本机 nginx 单跳，两个真实客户端保持独立身份', () => {
    expect(validateTrustedProxyConfiguration()).toMatchObject({ hops: 1 });

    const first = resolveRequestClientIp(
      request({ 'x-forwarded-for': '198.51.100.10', 'x-real-ip': '198.51.100.10' })
    );
    const second = resolveRequestClientIp(
      request({ 'x-forwarded-for': '198.51.100.11', 'x-real-ip': '198.51.100.11' })
    );
    expect(first).toBe('198.51.100.10');
    expect(second).toBe('198.51.100.11');
  });

  it('单跳按最右侧取值，忽略客户端伪造的更左条目', () => {
    expect(
      resolveRequestClientIp(
        request({
          'x-forwarded-for': '9.9.9.9, 198.51.100.10',
          'x-real-ip': '198.51.100.10',
        })
      )
    ).toBe('198.51.100.10');
  });

  it('单跳 XFF 与 X-Real-IP 不一致时 fail closed', () => {
    expect(
      resolveRequestClientIp(
        request({
          'x-forwarded-for': '198.51.100.10',
          'x-real-ip': '203.0.113.77',
        })
      )
    ).toBe('unknown');
  });

  it('单跳缺少任一由 nginx 覆盖的客户端头时 fail closed', () => {
    expect(
      resolveRequestClientIp(
        request({ 'x-forwarded-for': '198.51.100.10' })
      )
    ).toBe('unknown');
    expect(
      resolveRequestClientIp(request({ 'x-real-ip': '198.51.100.10' }))
    ).toBe('unknown');
  });

  it('显式两跳只接受配置 CIDR 内的中间代理', () => {
    setProxyConfig('2', '10.0.0.0/8');
    expect(
      resolveRequestClientIp(
        request({
          'x-forwarded-for': '198.51.100.10, 10.2.3.4',
          'x-real-ip': '10.2.3.4',
        })
      )
    ).toBe('198.51.100.10');

    expect(
      resolveRequestClientIp(
        request({
          'x-forwarded-for': '198.51.100.10, 192.0.2.44',
          'x-real-ip': '192.0.2.44',
        })
      )
    ).toBe('unknown');
  });

  it('两跳要求 X-Real-IP 与 XFF 最右 immediate proxy 完全一致', () => {
    setProxyConfig('2', '10.0.0.0/8');
    expect(
      resolveRequestClientIp(
        request({
          'x-forwarded-for': '198.51.100.10, 10.2.3.4',
          'x-real-ip': '10.9.9.9',
        })
      )
    ).toBe('unknown');
    expect(
      resolveRequestClientIp(
        request({ 'x-forwarded-for': '198.51.100.10, 10.2.3.4' })
      )
    ).toBe('unknown');
  });

  it('多跳缺少显式 CIDR 或配置非法时拒绝启动配置', () => {
    setProxyConfig('2');
    expect(() => validateTrustedProxyConfiguration()).toThrow(
      'TRUSTED_PROXY_CIDRS'
    );

    setProxyConfig('not-a-number', '10.0.0.0/8');
    expect(() => validateTrustedProxyConfiguration()).toThrow(
      'TRUSTED_PROXY_HOPS'
    );

    setProxyConfig('2', 'not-a-cidr');
    expect(() => validateTrustedProxyConfiguration()).toThrow('invalid trusted proxy CIDR');
  });

  it('显式 hops=0 的直连开发模式不采信任何代理头', () => {
    setProxyConfig('0');
    expect(
      resolveRequestClientIp(
        request({ 'x-forwarded-for': '198.51.100.10', 'x-real-ip': '198.51.100.10' })
      )
    ).toBe('unknown');
  });
});

describe('WebSocket peer + forwarded chain', () => {
  it('本机 nginx peer 使用被覆盖且一致的客户端头', () => {
    expect(
      resolveSocketClientIp({
        peerIp: '::ffff:127.0.0.1',
        forwardedFor: '198.51.100.10',
        realIp: '198.51.100.10',
      })
    ).toBe('198.51.100.10');
  });

  it('受信 nginx 缺少客户端头时 fail closed，不退化为共享 loopback 桶', () => {
    expect(resolveSocketClientIp({ peerIp: '127.0.0.1' })).toBe('unknown');
  });

  it('非受信直接 peer 永远使用 socket 地址，忽略伪造头', () => {
    expect(
      resolveSocketClientIp({
        peerIp: '203.0.113.5',
        forwardedFor: '9.9.9.9',
        realIp: '9.9.9.9',
      })
    ).toBe('203.0.113.5');
  });

  it('两跳同时验证本机 peer 和显式外部代理 CIDR', () => {
    setProxyConfig('2', '10.0.0.0/8');
    expect(
      resolveSocketClientIp({
        peerIp: '127.0.0.1',
        forwardedFor: '198.51.100.10, 10.2.3.4',
        realIp: '10.2.3.4',
      })
    ).toBe('198.51.100.10');
  });

  it('两跳 WS 拒绝与 XFF immediate proxy 不一致的 X-Real-IP', () => {
    setProxyConfig('2', '10.0.0.0/8');
    expect(
      resolveSocketClientIp({
        peerIp: '127.0.0.1',
        forwardedFor: '198.51.100.10, 10.2.3.4',
        realIp: '10.9.9.9',
      })
    ).toBe('unknown');
  });
});
