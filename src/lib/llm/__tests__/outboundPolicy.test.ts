import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeLlmEndpointForAudit,
  fetchLlmOutbound,
  LlmOutboundPolicyError,
  parseLlmAllowedOrigins,
  validateLlmProviderBaseUrl,
} from '@/lib/llm/outboundPolicy';

const publicDns = vi.fn(async () => ['93.184.216.34']);

afterEach(() => {
  publicDns.mockClear();
  vi.unstubAllEnvs();
});

describe('LLM outbound exact-origin and SSRF policy', () => {
  it('fails closed when the allowlist is missing or empty', () => {
    expect(() => parseLlmAllowedOrigins(undefined)).toThrow(LlmOutboundPolicyError);
    expect(() => parseLlmAllowedOrigins('  ')).toThrow(/at least one trusted origin/);
  });

  it('canonicalizes default ports, a DNS root dot and IDN hostnames', async () => {
    const idn = new URL('https://例子.测试').origin;
    const allowed = parseLlmAllowedOrigins(
      `https://api.example.com:443, https://api.example.com., ${idn}`
    );
    expect(allowed).toEqual(new Set(['https://api.example.com', idn]));
    await expect(
      validateLlmProviderBaseUrl(
        'https://api.example.com.:443/v1/',
        'https://api.example.com',
        { lookupAddresses: publicDns }
      )
    ).resolves.toBe('https://api.example.com/v1');
  });

  it('binds scheme, exact host and effective port without implicit subdomains', async () => {
    const allowlist = 'https://api.example.com,https://gateway.example.com:8443';
    await expect(
      validateLlmProviderBaseUrl('https://api.example.com/v1', allowlist, {
        lookupAddresses: publicDns,
      })
    ).resolves.toBe('https://api.example.com/v1');
    await expect(
      validateLlmProviderBaseUrl('https://child.api.example.com/v1', allowlist, {
        lookupAddresses: publicDns,
      })
    ).rejects.toThrow(/not allowlisted/);
    await expect(
      validateLlmProviderBaseUrl('http://api.example.com/v1', allowlist, {
        lookupAddresses: publicDns,
      })
    ).rejects.toThrow(/must use HTTPS/);
    await expect(
      validateLlmProviderBaseUrl('https://gateway.example.com:9443/v1', allowlist, {
        lookupAddresses: publicDns,
      })
    ).rejects.toThrow(/not allowlisted/);
  });

  it('supports an explicitly allowlisted public IPv6 origin and exact port', async () => {
    await expect(
      validateLlmProviderBaseUrl(
        'https://[2001:4860:4860::8888]:8443/v1/',
        'https://[2001:4860:4860::8888]:8443'
      )
    ).resolves.toBe('https://[2001:4860:4860::8888]:8443/v1');
  });

  it.each([
    'https://user@api.example.com/v1',
    'https://api.example.com/v1?token=secret',
    'https://api.example.com/v1#secret',
    'ftp://api.example.com/v1',
  ])('rejects unsafe URL representation: %s', async (url) => {
    await expect(
      validateLlmProviderBaseUrl(url, 'https://api.example.com', {
        lookupAddresses: publicDns,
      })
    ).rejects.toThrow(LlmOutboundPolicyError);
  });

  it('rejects malformed allowlist entries instead of silently dropping them', () => {
    expect(() => parseLlmAllowedOrigins('https://api.example.com/v1')).toThrow(
      /without a path/
    );
    expect(() =>
      parseLlmAllowedOrigins('https://api.example.com,not-a-url')
    ).toThrow(LlmOutboundPolicyError);
  });

  it.each([
    'https://127.0.0.1',
    'https://10.0.0.8',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[::ffff:169.254.169.254]',
    'https://[100:0:0:1::1]',
    'https://[2001:3::1]',
    'https://[2620:4f:8000::1]',
    'https://[3fff::1]',
    'https://[5f00::1]',
  ])('rejects an allowlisted private or special-use IP literal: %s', async (url) => {
    await expect(validateLlmProviderBaseUrl(`${url}/v1`, url)).rejects.toThrow(
      /public network addresses/
    );
  });

  it('rejects localhost and internal DNS suffixes before resolution', async () => {
    for (const host of ['localhost', 'llm.internal', 'provider.local', 'llm.home.arpa']) {
      await expect(
        validateLlmProviderBaseUrl(`https://${host}/v1`, `https://${host}`, {
          lookupAddresses: publicDns,
        })
      ).rejects.toThrow(/public DNS name/);
    }
    expect(publicDns).not.toHaveBeenCalled();
  });

  it('rejects a public-looking allowlisted hostname if any DNS answer is private', async () => {
    const privateDns = vi.fn(async () => ['93.184.216.34', '10.0.0.7']);
    await expect(
      validateLlmProviderBaseUrl(
        'https://api.example.com/v1',
        'https://api.example.com',
        { lookupAddresses: privateDns }
      )
    ).rejects.toThrow(/public network addresses/);
  });

  it('fails closed when DNS cannot be resolved safely', async () => {
    const failedDns = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(
      validateLlmProviderBaseUrl(
        'https://api.example.com/v1',
        'https://api.example.com',
        { lookupAddresses: failedDns }
      )
    ).rejects.toThrow(/could not be resolved safely/);
  });

  it('permits HTTP only behind the explicit non-production development switch', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LLM_PROVIDER_ALLOW_INSECURE_HTTP', 'true');
    await expect(
      validateLlmProviderBaseUrl(
        'http://8.8.8.8:8080/v1',
        'http://8.8.8.8:8080'
      )
    ).resolves.toBe('http://8.8.8.8:8080/v1');

    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      validateLlmProviderBaseUrl(
        'http://8.8.8.8:8080/v1',
        'http://8.8.8.8:8080'
      )
    ).rejects.toThrow(/must use HTTPS/);
  });

  it('revalidates at fetch time, forces manual redirect mode, and rejects every 3xx', async () => {
    vi.stubEnv('LLM_PROVIDER_ALLOWED_ORIGINS', 'https://8.8.8.8');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.example/steal?token=secret' },
      })
    );

    await expect(
      fetchLlmOutbound(
        'https://8.8.8.8/v1/messages',
        {
          method: 'POST',
          redirect: 'follow',
          headers: { 'x-api-key': 'secret' },
        },
        { fetchImpl: fetchMock }
      )
    ).rejects.toThrow(/redirects are not allowed/);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://8.8.8.8/v1/messages',
      expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() })
    );
  });

  it('pins the validated DNS answer into the fetch dispatcher, closing the rebind window', async () => {
    vi.stubEnv('LLM_PROVIDER_ALLOWED_ORIGINS', 'https://api.example.com');
    const lookupAddresses = vi.fn(async () => ['93.184.216.34']);
    const close = vi.fn().mockResolvedValue(undefined);
    const dispatcher = { close };
    const dispatcherFactory = vi.fn(() => dispatcher as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(
      fetchLlmOutbound('https://api.example.com/v1/messages', {}, {
        lookupAddresses,
        dispatcherFactory,
        fetchImpl: fetchMock,
      })
    ).resolves.toBeInstanceOf(Response);

    expect(lookupAddresses).toHaveBeenCalledTimes(1);
    expect(dispatcherFactory).toHaveBeenCalledWith(['93.184.216.34']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/messages',
      expect.objectContaining({ dispatcher, redirect: 'manual' })
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('audit metadata never includes userinfo or query/fragment values', () => {
    const metadata = describeLlmEndpointForAudit(
      'https://user:password@api.example.com/v1?token=supersecret&tenant=acme#fragment-secret'
    );
    expect(metadata).toMatchObject({
      origin: 'https://api.example.com',
      pathSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pathSegments: 1,
      queryParamCount: 2,
      hasQuery: true,
      hasUserinfo: true,
      hasFragment: true,
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('fragment-secret');
    expect(serialized).not.toContain('acme');
    expect(serialized).not.toContain('/v1');
    expect(serialized).not.toContain('tenant');
    expect(serialized).not.toContain('token');
  });
});
