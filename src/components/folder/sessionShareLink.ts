/**
 * 文件夹页（/folders/[id]、/folders/unarchived）「分享」：拿到一条可复制的回放分享链接。
 *
 * 此前两个页面各自在客户端拼 `/session/<id>/view/<token>` —— 应用里根本没有这条路由
 * （只有 `/session/[id]/view?token=`），复制出去的链接一律 404；而且每次都带
 * `expiresInHours: 72` 去 POST，服务端会复用该会话已有的回放链接并**改写其过期时间**，
 * 于是用户早先从回放页生成的永久链接被静默缩短成 72 小时（审计 medium）。
 *
 * 规则：
 * - 该会话已有未过期的非 live 链接 → 原样复用服务端给的 url，不发任何写请求；
 * - 没有 → 新建一条带有效期的回放链接；
 * - URL 一律用服务端返回的 `url` 字段（含 NEXT_PUBLIC_APP_URL），缺失时才按真实路由兜底拼。
 */

interface ShareLinkListItem {
  token?: unknown;
  url?: unknown;
  isLive?: unknown;
  expiresAt?: unknown;
  session?: { id?: unknown } | null;
}

function buildFallbackUrl(origin: string, sessionId: string, token: string): string {
  return `${origin}/session/${encodeURIComponent(sessionId)}/view?token=${encodeURIComponent(token)}`;
}

function resolveShareUrl(
  url: unknown,
  token: unknown,
  sessionId: string,
  origin: string
): string | null {
  if (typeof url === 'string' && url) return url;
  if (typeof token === 'string' && token) return buildFallbackUrl(origin, sessionId, token);
  return null;
}

function isReusablePlaybackLink(link: ShareLinkListItem, sessionId: string, nowMs: number): boolean {
  if (!link || link.isLive === true) return false;
  if (link.session?.id !== sessionId) return false;
  if (link.expiresAt == null) return true;
  const expiresMs = new Date(String(link.expiresAt)).getTime();
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

export async function getOrCreateSessionShareUrl(options: {
  sessionId: string;
  authHeaders: Record<string, string>;
  /** 仅在新建链接时使用；复用已有链接时绝不发送（否则会改写其过期时间）。 */
  expiresInHours: number;
  failureMessage: string;
  origin?: string;
  nowMs?: number;
}): Promise<string> {
  const origin = options.origin ?? window.location.origin;
  const nowMs = options.nowMs ?? Date.now();

  const listRes = await fetch('/api/share/create', { headers: options.authHeaders });
  const listData: unknown = await listRes.json().catch(() => null);
  if (!listRes.ok) {
    const error =
      listData && typeof listData === 'object' && typeof (listData as { error?: unknown }).error === 'string'
        ? (listData as { error: string }).error
        : options.failureMessage;
    throw new Error(error);
  }

  if (Array.isArray(listData)) {
    const existing = (listData as ShareLinkListItem[]).find((link) =>
      isReusablePlaybackLink(link, options.sessionId, nowMs)
    );
    if (existing) {
      const url = resolveShareUrl(existing.url, existing.token, options.sessionId, origin);
      if (url) return url;
    }
  }

  const createRes = await fetch('/api/share/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.authHeaders },
    body: JSON.stringify({
      sessionId: options.sessionId,
      isLive: false,
      expiresInHours: options.expiresInHours,
    }),
  });
  const created = (await createRes.json().catch(() => ({}))) as {
    url?: unknown;
    token?: unknown;
    error?: unknown;
  };
  if (!createRes.ok) {
    throw new Error(typeof created.error === 'string' && created.error ? created.error : options.failureMessage);
  }
  const url = resolveShareUrl(created.url, created.token, options.sessionId, origin);
  if (!url) throw new Error(options.failureMessage);
  return url;
}
