// L4：内部撤销通知端点（SHARE-REVOKE-001）默认随 WS 服务绑在 0.0.0.0（容器部署必须
// 如此，见 server/websocket.ts 的 P6-1），此前唯一防线是 HMAC 签名。签名实现本身正确，
// 这里补一道来源网段闸做纵深。
//
// 关键取舍：不能一刀切 loopback —— 跨容器/跨主机部署会显式设 LIVE_SHARE_WS_INTERNAL_URL，
// 通知来源是容器网段（172.16/12、10/8、Pod IP）。一刀切会让撤销通知全部被拒、
// 观众驱逐退化成 60s 周期兜底，那是**比原问题更糟的安全回归**。
// 故策略是「环回 + 私有网段放行，公网地址一律拒」。

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => {
  const noop = vi.fn();
  return {
    logger: {
      child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    },
    serializeError: (error: unknown) =>
      error instanceof Error ? { message: error.message } : { message: String(error) },
  };
});

import { isTrustedInternalSource } from '@/lib/liveShare/internalHttp';

describe('isTrustedInternalSource（L4）', () => {
  afterEach(() => {
    delete process.env.LIVE_SHARE_INTERNAL_ALLOW_ANY_SOURCE;
  });

  it.each([
    ['IPv4 环回（同机 systemd 部署的默认通知来源）', '127.0.0.1'],
    ['IPv4 环回段其它地址', '127.5.6.7'],
    ['IPv6 环回', '::1'],
    ['IPv6 映射的 IPv4 环回', '::ffff:127.0.0.1'],
    ['Docker 默认网桥网关', '172.17.0.1'],
    ['Docker 容器地址', '172.20.3.4'],
    ['Kubernetes Pod 网段', '10.244.1.9'],
    ['家用/内网网段', '192.168.1.20'],
    ['IPv6 ULA', 'fd00::1'],
    ['IPv6 链路本地（带 zone）', 'fe80::1%eth0'],
  ])('放行：%s', (_label, address) => {
    expect(isTrustedInternalSource(address)).toBe(true);
  });

  it.each([
    ['公网 IPv4', '203.0.113.9'],
    ['公网 IPv4（另一段）', '8.8.8.8'],
    ['IPv6 映射的公网 IPv4', '::ffff:203.0.113.9'],
    ['公网 IPv6', '2001:db8::1'],
    ['172.32 不属于 172.16/12', '172.32.0.1'],
    ['172.15 不属于 172.16/12', '172.15.255.254'],
  ])('拒绝：%s', (_label, address) => {
    expect(isTrustedInternalSource(address)).toBe(false);
  });

  it('无 remoteAddress（unix socket 等非 TCP/IP 连接）视为本机', () => {
    expect(isTrustedInternalSource(undefined)).toBe(true);
  });

  it('显式逃生开关可放开任意来源（HMAC 仍是主防线）', () => {
    expect(isTrustedInternalSource('203.0.113.9')).toBe(false);
    process.env.LIVE_SHARE_INTERNAL_ALLOW_ANY_SOURCE = 'true';
    expect(isTrustedInternalSource('203.0.113.9')).toBe(true);
  });
});
