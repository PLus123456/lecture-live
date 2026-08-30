import { BlockList, isIP } from 'node:net';

/**
 * 仓库标准拓扑是「公网客户端 -> 本机 nginx -> 回环 Web/WS」。因此安全默认只剥一跳；
 * nginx 必须覆盖（而不是追加）客户端自带的代理头，应用端口也必须只监听回环。
 *
 * 额外的 CDN / LB 不得靠运行期数据库 boolean 猜测：部署者必须显式增加 hop 数，并列出
 * 中间代理 CIDR。拓扑是启动配置，Web 与独立 WS 进程必须读取同一份环境变量，不能在管理
 * 页面运行中切换、再等待两个进程各自的异步缓存碰巧收敛。
 */
const DEFAULT_TRUSTED_PROXY_HOPS = 1;
const MAX_TRUSTED_PROXY_HOPS = 8;
const LOOPBACK_PROXY_CIDRS = ['127.0.0.1/32', '::1/128'] as const;

interface TrustedProxyRuntimeConfig {
  hops: number;
  cidrs: string[];
  blockList: BlockList;
}

export interface TrustedProxyConfig {
  hops: number;
  cidrs: string[];
}

export interface SocketClientIpInput {
  peerIp: string | null | undefined;
  forwardedFor?: string | null;
  realIp?: string | null;
}

let cachedConfigKey = '';
let cachedConfig: TrustedProxyRuntimeConfig | null = null;

function stripIpPort(value: string): string {
  const bracketed = value.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) {
    return bracketed[1];
  }

  // Node / proxies may expose an IPv4 peer as "198.51.100.10:54321". Never split an
  // unbracketed IPv6 literal on its last colon; only accept the host:port form for IPv4.
  const ipv4WithPort = value.match(/^([^:]+):(\d+)$/);
  if (ipv4WithPort && isIP(ipv4WithPort[1]) === 4) {
    return ipv4WithPort[1];
  }
  return value;
}

export function normalizeClientIp(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const stripped = stripIpPort(value.trim());
  if (!stripped || stripped.includes('%')) return null;

  // Keep rate-limit keys stable between Node's IPv4-mapped socket addresses and nginx's
  // ordinary IPv4 headers.
  const mapped = stripped.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && isIP(mapped[1]) === 4) {
    return mapped[1];
  }

  return isIP(stripped) ? stripped.toLowerCase() : null;
}

function parseHopCount(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_TRUSTED_PROXY_HOPS;
  if (!/^\d+$/.test(value)) {
    throw new Error('FATAL: TRUSTED_PROXY_HOPS must be an integer between 0 and 8');
  }
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error('FATAL: TRUSTED_PROXY_HOPS must be an integer between 0 and 8');
  }
  return hops;
}

function addCidr(blockList: BlockList, cidr: string): string {
  const trimmed = cidr.trim();
  if (!trimmed) {
    throw new Error('FATAL: TRUSTED_PROXY_CIDRS contains an empty entry');
  }

  const slash = trimmed.lastIndexOf('/');
  const rawAddress = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const normalizedAddress = normalizeClientIp(rawAddress);
  const family = normalizedAddress ? isIP(normalizedAddress) : 0;
  if (!normalizedAddress || family === 0) {
    throw new Error(`FATAL: invalid trusted proxy CIDR: ${trimmed}`);
  }

  const maxPrefix = family === 4 ? 32 : 128;
  const rawPrefix = slash >= 0 ? trimmed.slice(slash + 1) : String(maxPrefix);
  if (!/^\d+$/.test(rawPrefix)) {
    throw new Error(`FATAL: invalid trusted proxy CIDR: ${trimmed}`);
  }
  const prefix = Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`FATAL: invalid trusted proxy CIDR: ${trimmed}`);
  }

  blockList.addSubnet(
    normalizedAddress,
    prefix,
    family === 4 ? 'ipv4' : 'ipv6'
  );
  return `${normalizedAddress}/${prefix}`;
}

function loadTrustedProxyConfig(): TrustedProxyRuntimeConfig {
  const rawHops = process.env.TRUSTED_PROXY_HOPS;
  const rawCidrs = process.env.TRUSTED_PROXY_CIDRS;
  const configKey = `${rawHops ?? ''}\0${rawCidrs ?? ''}`;
  if (cachedConfig && cachedConfigKey === configKey) {
    return cachedConfig;
  }

  const hops = parseHopCount(rawHops);
  const explicitCidrs = (rawCidrs ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (hops > 1 && explicitCidrs.length === 0) {
    throw new Error(
      'FATAL: TRUSTED_PROXY_HOPS > 1 requires explicit TRUSTED_PROXY_CIDRS'
    );
  }

  const blockList = new BlockList();
  const cidrs: string[] = [];
  // The shipped nginx is local in every supported standard deployment. Keep loopback trusted
  // even when operators add external proxy CIDRs for a multi-hop chain.
  for (const cidr of [...LOOPBACK_PROXY_CIDRS, ...explicitCidrs]) {
    const normalized = addCidr(blockList, cidr);
    if (!cidrs.includes(normalized)) cidrs.push(normalized);
  }

  cachedConfigKey = configKey;
  cachedConfig = { hops, cidrs, blockList };
  return cachedConfig;
}

export function validateTrustedProxyConfiguration(): TrustedProxyConfig {
  const config = loadTrustedProxyConfig();
  return { hops: config.hops, cidrs: [...config.cidrs] };
}

export function shouldTrustProxyHeaders(): boolean {
  return loadTrustedProxyConfig().hops > 0;
}

function isTrustedProxyIp(
  value: string | null | undefined,
  config: TrustedProxyRuntimeConfig
): boolean {
  const normalized = normalizeClientIp(value);
  if (!normalized) return false;
  const family = isIP(normalized);
  return config.blockList.check(
    normalized,
    family === 4 ? 'ipv4' : 'ipv6'
  );
}

function splitForwardedFor(
  forwardedHeader: string | null | undefined
): string[] {
  if (!forwardedHeader) return [];
  return forwardedHeader
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve the Nth address from the right. Values farther left are attacker-controlled and are
 * deliberately ignored; every address between the selected client and local nginx must be a
 * configured trusted proxy.
 */
function resolveForwardedClientIp(
  forwardedHeader: string | null | undefined,
  config: TrustedProxyRuntimeConfig
): string | null {
  if (config.hops <= 0) return null;
  const entries = splitForwardedFor(forwardedHeader);
  if (entries.length < config.hops) return null;

  const clientIndex = entries.length - config.hops;
  const clientIp = normalizeClientIp(entries[clientIndex]);
  if (!clientIp) return null;

  for (const proxy of entries.slice(clientIndex + 1)) {
    if (!isTrustedProxyIp(proxy, config)) return null;
  }
  return clientIp;
}

/** Compatibility helper: one trusted hop means the right-most valid address. */
export function getTrustedForwardedIp(
  forwardedHeader: string | null | undefined
): string | null {
  const entries = splitForwardedFor(forwardedHeader);
  return normalizeClientIp(entries[entries.length - 1]);
}

function resolveTrustedHeaders(
  forwardedFor: string | null | undefined,
  realIp: string | null | undefined,
  config: TrustedProxyRuntimeConfig
): string | null {
  const forwardedClient = resolveForwardedClientIp(forwardedFor, config);

  // In the standard single-nginx topology both headers are overwritten from $remote_addr.
  // When both are present they must agree — reject disagreement rather than choosing
  // whichever an attacker prefers.
  //
  // X-Real-IP being absent is NOT ambiguous, though: at one hop the right-most XFF entry
  // was written by the trusted proxy itself. Requiring both headers collapsed every
  // deployment whose proxy sets only X-Forwarded-For (Traefik, most k8s ingresses, plenty
  // of hand-rolled nginx) into the single `unknown` bucket, so one shared rate limit 429'd
  // the entire site.
  if (config.hops === 1) {
    if (!forwardedClient) {
      return null;
    }
    const normalizedRealIp = normalizeClientIp(realIp);
    if (!normalizedRealIp) {
      return forwardedClient;
    }
    return forwardedClient === normalizedRealIp ? forwardedClient : null;
  }

  // In a multi-hop topology X-Real-IP names the immediate external proxy. It is not the
  // client identity, but it must agree with XFF's right-most hop; otherwise a stale or forged
  // companion header could silently pass while audit/rate-limit components see different chains.
  const entries = splitForwardedFor(forwardedFor);
  const immediateProxy = normalizeClientIp(entries[entries.length - 1]);
  const normalizedRealIp = normalizeClientIp(realIp);
  if (!forwardedClient || !immediateProxy || !normalizedRealIp) return null;
  return immediateProxy === normalizedRealIp ? forwardedClient : null;
}

export function resolveRequestClientIp(req: Request): string {
  const config = loadTrustedProxyConfig();
  if (config.hops === 0) return 'unknown';
  return (
    resolveTrustedHeaders(
      req.headers.get('x-forwarded-for'),
      req.headers.get('x-real-ip'),
      config
    ) ?? 'unknown'
  );
}

/**
 * WS has the direct socket peer, so it can additionally prove that forwarded headers arrived
 * through an allowed proxy. Untrusted/direct peers are keyed by their real socket address and
 * cannot spoof either header. A trusted proxy that omits/mangles the expected headers fails
 * closed as `unknown`; the handshake layer rejects that value.
 */
export function resolveSocketClientIp(input: SocketClientIpInput): string {
  const config = loadTrustedProxyConfig();
  const peerIp = normalizeClientIp(input.peerIp);
  if (!peerIp) return 'unknown';
  if (config.hops === 0 || !isTrustedProxyIp(peerIp, config)) {
    return peerIp;
  }

  // A peer inside a trusted CIDR that presents no proxy headers at all is not a proxy
  // relaying somebody else — it is a direct connection from that host: `npm run dev:ws`
  // reached at ws://localhost:3001, an SSH tunnel, a local probe. Its socket address comes
  // from the kernel and cannot be spoofed, so keying on it is safe and is what the
  // pre-hardening code did. Loopback is *always* in the trusted set, so without this the
  // WS handshake resolved `unknown` and websocket.ts rejected every local connection —
  // live share and realtime transcription were dead in development.
  //
  // Fail closed only for the genuinely ambiguous case: headers present but unresolvable.
  if (!input.forwardedFor && !input.realIp) {
    return peerIp;
  }

  return (
    resolveTrustedHeaders(input.forwardedFor, input.realIp, config) ?? 'unknown'
  );
}
