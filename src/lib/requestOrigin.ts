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
  // L11 之后这条路径在**每次**解析时都会走到（配置优先），所以不能假设
  // getSiteSettings() 一定返回 thenable —— 站点设置不可用时应当安静降级到
  // 请求头/环境变量，而不是把 OAuth 回调整条打断。
  const siteOrigin = await Promise.resolve()
    .then(() => getSiteSettings())
    .then((settings) => normalizeOrigin(settings?.site_url?.trim()))
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

/**
 * L11：解析「本站对外可见的 origin」。
 *
 * 原实现是**请求头优先**：`x-forwarded-host` → `host` → `req.url`，只要拼出来的
 * origin 看着像公网地址就直接采用。这两个头都是调用方可控的（反代漏配时更是完全可控），
 * 于是任意公网域名都能被当成本站 origin —— 当前唯一调用方是 admin-only 的 Cloudreve
 * OAuth（拿它兜底 redirect_uri），影响有限，但这条链上出现的是**授权回跳地址**，
 * 值得按最小信任来做。
 *
 * 改成**配置优先**：先用运维显式配置的 `site_url` / `NEXT_PUBLIC_APP_URL`
 * （与密码重置/验证邮件里的链接口径一致），配置缺失或不是公网地址时才回退到请求头。
 * 正常部署里这两者本来就相同，行为无变化；被伪造头污染的那条路径被堵死。
 */
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

  // 配置优先：这是唯一不受调用方影响的来源
  const configuredOrigin = await getConfiguredOrigin();
  if (configuredOrigin && isPublicOrigin(configuredOrigin)) {
    return configuredOrigin;
  }

  // 没配置（或配的是内网地址，例如本地开发）才退回请求头
  const publicRequestOrigin = requestCandidates.find((origin) => isPublicOrigin(origin));
  if (publicRequestOrigin) {
    return publicRequestOrigin;
  }

  const fallbackCandidates = [
    configuredOrigin,
    ...requestCandidates,
  ].filter((origin): origin is string => Boolean(origin));

  return fallbackCandidates.find((origin) => isPublicOrigin(origin)) ?? fallbackCandidates[0]!;
}
