import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveRequestClientIp } from '@/lib/clientIp';
import { enforceRateLimit } from '@/lib/rateLimit';

export const PUBLIC_AUTH_BODY_MAX_BYTES = 8 * 1024;

const PUBLIC_AUTH_GLOBAL_LIMIT = 600;
const PUBLIC_AUTH_GLOBAL_WINDOW_MS = 60_000;
const PUBLIC_AUTH_IP_LIMIT = 120;
const PUBLIC_AUTH_IP_WINDOW_MS = 60_000;

interface PublicAuthPreludeOptions {
  scope: string;
  endpointIpLimit: number;
  endpointWindowMs: number;
}

export interface PublicAuthPreludeResult {
  clientIp: string;
  response: NextResponse | null;
}

/**
 * Cheap, fixed-cardinality gates for anonymous authentication routes.
 *
 * This must run before reading the request body, loading site settings, or
 * deriving an account-specific key. The global bucket remains active even
 * when the proxy topology cannot safely identify a client IP.
 */
export async function enforcePublicAuthPrelude(
  req: Request,
  options: PublicAuthPreludeOptions
): Promise<PublicAuthPreludeResult> {
  const globallyLimited = await enforceRateLimit(req, {
    scope: 'auth:public:global',
    limit: PUBLIC_AUTH_GLOBAL_LIMIT,
    windowMs: PUBLIC_AUTH_GLOBAL_WINDOW_MS,
    key: 'global',
  });
  if (globallyLimited) {
    return { clientIp: 'unknown', response: globallyLimited };
  }

  const clientIp = resolveRequestClientIp(req);
  if (clientIp === 'unknown') {
    return { clientIp, response: null };
  }

  const sharedIpLimited = await enforceRateLimit(req, {
    scope: 'auth:public:ip',
    limit: PUBLIC_AUTH_IP_LIMIT,
    windowMs: PUBLIC_AUTH_IP_WINDOW_MS,
    key: `ip:${clientIp}`,
  });
  if (sharedIpLimited) {
    return { clientIp, response: sharedIpLimited };
  }

  const endpointIpLimited = await enforceRateLimit(req, {
    scope: `auth:${options.scope}:prelude:ip`,
    limit: options.endpointIpLimit,
    windowMs: options.endpointWindowMs,
    key: `ip:${clientIp}`,
  });
  return { clientIp, response: endpointIpLimited };
}

export function publicAuthAccountKey(
  kind: 'email' | 'token',
  normalizedValue: string
): string {
  const digest = createHash('sha256').update(normalizedValue, 'utf8').digest('hex');
  return `${kind}:sha256:${digest}`;
}

type PublicAuthJsonResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

function invalidBodyResponse(): NextResponse {
  return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
}

function oversizedBodyResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Request body too large' },
    { status: 413 }
  );
}

function authMutationRejection(message: string, status: 403 | 415): NextResponse {
  const response = NextResponse.json({ error: message }, { status });
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return response;
}

/**
 * Browser-side auth mutations must be same-origin. In particular, a sibling
 * subdomain can submit a no-CORS text/plain login form and the browser will
 * still apply a Set-Cookie response unless Origin/Fetch-Metadata are checked.
 *
 * Requests without browser metadata remain available to trusted CLI/bootstrap
 * clients, but JSON endpoints still require an explicit application/json media
 * type. This guard never emits Set-Cookie or Clear-Site-Data.
 */
export function guardAuthMutationRequest(
  req: Request,
  options: { requireJson?: boolean } = {}
): NextResponse | null {
  const fetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    return authMutationRejection('Cross-origin auth mutation rejected', 403);
  }

  const origin = req.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) {
        return authMutationRejection('Cross-origin auth mutation rejected', 403);
      }
    } catch {
      return authMutationRejection('Cross-origin auth mutation rejected', 403);
    }
  }

  if (options.requireJson) {
    const mediaType = req.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== 'application/json') {
      return authMutationRejection('Content-Type must be application/json', 415);
    }
  }

  return null;
}

/**
 * Parse a small JSON object without ever buffering an unbounded chunked body.
 * Content-Length is an early rejection only; actual streamed bytes are always
 * counted because the header may be missing or dishonest.
 */
export async function readPublicAuthJson<T extends Record<string, unknown>>(
  req: Request,
  maxBytes = PUBLIC_AUTH_BODY_MAX_BYTES
): Promise<PublicAuthJsonResult<T>> {
  const requestGuard = guardAuthMutationRequest(req, { requireJson: true });
  if (requestGuard) return { ok: false, response: requestGuard };

  const declaredLength = req.headers.get('content-length')?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      return { ok: false, response: oversizedBodyResponse() };
    }
  }

  if (!req.body) {
    return { ok: false, response: invalidBodyResponse() };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('public auth body exceeds byte limit').catch(() => undefined);
        return { ok: false, response: oversizedBodyResponse() };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: invalidBodyResponse() };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: invalidBodyResponse() };
    }
    return { ok: true, body: parsed as T };
  } catch {
    return { ok: false, response: invalidBodyResponse() };
  }
}
