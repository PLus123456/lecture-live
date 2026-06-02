import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';

// validateCloudreveBaseUrl 对私网 / 本地地址抛错（除非显式 CLOUDREVE_ALLOW_PRIVATE_HOST），
// 对可信公网地址返回规范化后的 URL。这是 SSRF 的核心防线，覆盖 IPv4/IPv6 全部私网段。

describe('Cloudreve SSRF 私网判定（validateCloudreveBaseUrl）', () => {
  const originalAllowPrivate = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;

  beforeEach(() => {
    // 确保默认拒绝私网：必须未设置放行开关
    delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
  });

  afterEach(() => {
    if (originalAllowPrivate === undefined) {
      delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
    } else {
      process.env.CLOUDREVE_ALLOW_PRIVATE_HOST = originalAllowPrivate;
    }
  });

  describe('拒绝私网 / 本地地址（应抛错）', () => {
    const privateHosts: Array<[string, string]> = [
      ['localhost', 'http://localhost:5212'],
      ['.local 域', 'http://nas.local'],
      ['.internal 域', 'http://cloudreve.internal'],
      ['含用户名（凭据走私）', 'http://user@cloud.example.com'],
      ['含用户名密码', 'http://user:pass@cloud.example.com'],
      // IPv4 私网
      ['10/8', 'http://10.0.0.5'],
      ['127/8 回环', 'http://127.0.0.1:5212'],
      ['172.16/12 下界', 'http://172.16.0.1'],
      ['172.31/12 上界', 'http://172.31.255.255'],
      ['192.168/16', 'http://192.168.1.1'],
      // 新增网段
      ['0.0.0.0/8', 'http://0.0.0.0'],
      ['0.0.0.0/8 非零主机位', 'http://0.1.2.3'],
      ['169.254/16 链路本地', 'http://169.254.1.1'],
      ['169.254.169.254 云元数据', 'http://169.254.169.254/latest/meta-data/'],
      // IPv6
      ['::1 回环（带方括号 hostname）', 'http://[::1]:5212'],
      [':: 未指定地址', 'http://[::]'],
      ['fc00::/7 ULA（fc 段）', 'http://[fc00::1]'],
      ['fc00::/7 ULA（fd 段）', 'http://[fd12:3456:789a::1]'],
      ['fe80::/10 链路本地', 'http://[fe80::1]'],
      ['febf::/10 链路本地上界', 'http://[febf::1]'],
      ['IPv4-mapped 元数据 ::ffff:169.254.169.254', 'http://[::ffff:169.254.169.254]'],
    ];

    it.each(privateHosts)('拒绝 %s', (_label, url) => {
      expect(() => validateCloudreveBaseUrl(url)).toThrow(
        /trusted public host|HTTP or HTTPS/
      );
    });
  });

  describe('放行可信公网地址（返回规范化 URL）', () => {
    it('https 公网域名', () => {
      expect(validateCloudreveBaseUrl('https://cloud.example.com/')).toBe(
        'https://cloud.example.com'
      );
    });

    it('公网 IPv4（非私网段）', () => {
      expect(validateCloudreveBaseUrl('https://8.8.8.8')).toBe(
        'https://8.8.8.8'
      );
    });

    it('172.15 不在私网段内（172.16-31 才是私网）', () => {
      expect(validateCloudreveBaseUrl('http://172.15.0.1')).toBe(
        'http://172.15.0.1'
      );
    });

    it('172.32 不在私网段内', () => {
      expect(validateCloudreveBaseUrl('http://172.32.0.1')).toBe(
        'http://172.32.0.1'
      );
    });

    it('169.253 不在 169.254 链路本地段内', () => {
      expect(validateCloudreveBaseUrl('http://169.253.0.1')).toBe(
        'http://169.253.0.1'
      );
    });

    it('去除路径尾部斜杠', () => {
      expect(validateCloudreveBaseUrl('https://cloud.example.com/base/')).toBe(
        'https://cloud.example.com/base'
      );
    });

    it('公网 IPv6（2001:db8::/32 文档段，非私网）', () => {
      // 规范化后 hostname 仍带方括号
      expect(validateCloudreveBaseUrl('https://[2001:4860:4860::8888]')).toBe(
        'https://[2001:4860:4860::8888]'
      );
    });
  });

  describe('CLOUDREVE_ALLOW_PRIVATE_HOST 放行开关', () => {
    it('开关打开时允许私网地址（本地自托管场景）', () => {
      process.env.CLOUDREVE_ALLOW_PRIVATE_HOST = 'true';
      expect(validateCloudreveBaseUrl('http://127.0.0.1:5212')).toBe(
        'http://127.0.0.1:5212'
      );
      expect(validateCloudreveBaseUrl('http://[::1]:5212')).toBe(
        'http://[::1]:5212'
      );
    });

    it('非法 URL 始终抛错（与放行开关无关）', () => {
      expect(() => validateCloudreveBaseUrl('not a url')).toThrow(
        /valid URL/
      );
    });

    it('非 http(s) 协议始终被拒', () => {
      expect(() => validateCloudreveBaseUrl('ftp://cloud.example.com')).toThrow(
        /HTTP or HTTPS/
      );
    });
  });
});
