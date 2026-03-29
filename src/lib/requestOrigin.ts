import 'server-only';

import { getSiteSettings } from '@/lib/siteSettings';

function pickFirstHeaderValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const first = value.split(',')[0]?.trim();
  return first || null;
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function buildOriginFromParts(
  protocol: string | null | undefined,
  host: string | null | undefined
): string | null {
  const normalizedHost = pickFirstHeaderValue(host);
  if (!normalizedHost) {
    return null;
  }

  const normalizedProtocol = pickFirstHeaderValue(protocol)?.replace(/:$/, '') || 'http';
  return normalizeOrigin(`${normalizedProtocol}://${normalizedHost}`);
}

function isPrivateIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const [first, second] = parts.map((part) => Number(part));
  if (first === 10 || first === 127) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

function isPublicOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return !(
      url.hostname === 'localhost' ||
      url.hostname === '::1' ||
      url.hostname.endsWith('.local') ||
      url.hostname.endsWith('.internal') ||
      isPrivateIpv4Host(url.hostname)
    );
  } catch {
    return false;
  }
}

async function getConfiguredOrigin(): Promise<string | null> {
  const envOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL?.trim());
  const siteOrigin = await getSiteSettings()
    .then((settings) => normalizeOrigin(settings.site_url?.trim()))
    .catch(() => null);

  const configuredCandidates = [siteOrigin, envOrigin].filter(
    (origin): origin is string => Boolean(origin)
  );

  return (
    configuredCandidates.find((origin) => isPublicOrigin(origin)) ??
    configuredCandidates[0] ??
    null
  );
}

export async function resolvePublicAppOrigin(req: Request): Promise<string> {
  const requestUrl = new URL(req.url);
  const forwardedProto =
    pickFirstHeaderValue(req.headers.get('x-forwarded-proto')) ??
    requestUrl.protocol.replace(/:$/, '');

  const requestCandidates = [
    buildOriginFromParts(forwardedProto, req.headers.get('x-forwarded-host')),
    buildOriginFromParts(forwardedProto, req.headers.get('host')),
    requestUrl.origin,
  ].filter((origin): origin is string => Boolean(origin));

  const publicRequestOrigin = requestCandidates.find((origin) => isPublicOrigin(origin));
  if (publicRequestOrigin) {
    return publicRequestOrigin;
  }

  const configuredOrigin = await getConfiguredOrigin();
  const fallbackCandidates = [
    configuredOrigin,
    ...requestCandidates,
  ].filter((origin): origin is string => Boolean(origin));

  return fallbackCandidates.find((origin) => isPublicOrigin(origin)) ?? fallbackCandidates[0]!;
}
