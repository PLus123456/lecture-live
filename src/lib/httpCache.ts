import { createHash } from 'crypto';
import { NextResponse } from 'next/server';

interface JsonCacheResponseOptions {
  cacheControl: string;
  headers?: HeadersInit;
  status?: number;
  vary?: string[];
}

function buildEtag(body: string): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`;
}

function normalizeEtagForComparison(value: string): string {
  return value.trim().replace(/^W\//i, '');
}

function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  if (ifNoneMatch.trim() === '*') {
    return true;
  }

  const normalizedEtag = normalizeEtagForComparison(etag);
  return ifNoneMatch
    .split(',')
    .some((candidate) => normalizeEtagForComparison(candidate) === normalizedEtag);
}

function mergeVaryHeaders(headers: Headers, vary: string[]) {
  const existing = headers.get('Vary');
  const values = new Set<string>();

  for (const value of (existing ? existing.split(',') : []).concat(vary)) {
    const normalized = value.trim();
    if (normalized) {
      values.add(normalized);
    }
  }

  if (values.size > 0) {
    headers.set('Vary', Array.from(values).join(', '));
  }
}

export function jsonWithCache(
  req: Request,
  data: unknown,
  options: JsonCacheResponseOptions
): NextResponse {
  const body = JSON.stringify(data);
  const etag = buildEtag(body);
  const headers = new Headers(options.headers);

  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', options.cacheControl);
  headers.set('ETag', etag);

  if (options.vary?.length) {
    mergeVaryHeaders(headers, options.vary);
  }

  if (matchesIfNoneMatch(req.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, {
      status: 304,
      headers,
    });
  }

  return new NextResponse(body, {
    status: options.status ?? 200,
    headers,
  });
}
