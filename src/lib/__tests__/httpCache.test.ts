import { describe, expect, it } from 'vitest';
import { readJson } from '../../../tests/utils/http';
import { jsonWithCache } from '@/lib/httpCache';

describe('httpCache', () => {
  it('返回 JSON 响应时附带 ETag 和缓存头', async () => {
    const request = new Request('http://localhost:3000/api/site-config');

    const response = jsonWithCache(
      request,
      { ok: true, version: 1 },
      {
        cacheControl: 'public, no-cache, must-revalidate',
        vary: ['Authorization', 'Cookie'],
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, no-cache, must-revalidate'
    );
    expect(response.headers.get('ETag')).toMatch(/^".+"$/);
    expect(response.headers.get('Vary')).toBe('Authorization, Cookie');
    await expect(readJson<Record<string, unknown>>(response)).resolves.toEqual({
      ok: true,
      version: 1,
    });
  });

  it('命中 If-None-Match 时返回 304', async () => {
    const initial = jsonWithCache(
      new Request('http://localhost:3000/api/site-config'),
      { ok: true },
      {
        cacheControl: 'public, no-cache, must-revalidate',
      }
    );

    const etag = initial.headers.get('ETag');
    expect(etag).toBeTruthy();

    const response = jsonWithCache(
      new Request('http://localhost:3000/api/site-config', {
        headers: {
          'If-None-Match': etag!,
        },
      }),
      { ok: true },
      {
        cacheControl: 'public, no-cache, must-revalidate',
      }
    );

    expect(response.status).toBe(304);
    await expect(response.text()).resolves.toBe('');
  });
});
