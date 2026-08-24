import 'server-only';

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Agent, type Dispatcher } from 'undici';

export const LLM_ALLOW_INSECURE_HTTP_ENV = 'LLM_PROVIDER_ALLOW_INSECURE_HTTP';

const MAX_PROVIDER_URL_BYTES = 8 * 1024;
const MAX_DNS_ADDRESSES = 32;
const DNS_LOOKUP_TIMEOUT_MS = 3_000;

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
}

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible forms
  ['::ffff:0:0', 96], // IPv4-mapped forms; use an IPv4 literal instead
  ['64:ff9b::', 96], // well-known NAT64 can encode private IPv4 destinations
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['100:0:0:1::', 64], // IANA dummy IPv6 prefix
  ['2001::', 23], // IETF protocol assignments (Teredo/benchmark/ORCHID/etc.)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // deprecated 6to4 embeds an IPv4 destination
  ['2620:4f:8000::', 48], // direct-delegation AS112 service
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment-routing SIDs, not ordinary public endpoints
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

export class LlmOutboundPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutboundPolicyError';
  }
}

export type LlmAddressLookup = (hostname: string) => Promise<readonly string[]>;

interface LlmOutboundDependencies {
  lookupAddresses?: LlmAddressLookup;
  fetchImpl?: typeof fetch;
  dispatcherFactory?: (addresses: readonly string[]) => Dispatcher;
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

function insecureHttpAllowed(): boolean {
  // Plain HTTP is only an explicit local-development escape hatch. Production
  // cannot enable it accidentally through a copied development environment.
  return (
    process.env.NODE_ENV === 'development' &&
    isExplicitlyEnabled(process.env[LLM_ALLOW_INSECURE_HTTP_ENV])
  );
}

function canonicalHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    // URL has already parsed and canonicalized the IPv6 literal. Keep brackets so
    // the value can be placed back into an origin without an ambiguous colon.
    return lower;
  }

  // A trailing DNS root dot is equivalent on the wire. Canonicalize it before
  // allowlist comparison so `api.example.com.` cannot create a second spelling.
  const withoutRootDot = lower.replace(/\.+$/, '');
  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii) {
    throw new LlmOutboundPolicyError('LLM provider hostname is invalid');
  }
  return ascii;
}

function parseHttpUrl(
  value: string,

): { url: URL; origin: string; hostname: string } {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_URL_BYTES) {
    throw new LlmOutboundPolicyError('LLM provider URL is too large');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmOutboundPolicyError('LLM provider URL must be an absolute URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LlmOutboundPolicyError('LLM provider URL must use HTTP or HTTPS');
  }
  if (url.protocol === 'http:' && !insecureHttpAllowed()) {
    throw new LlmOutboundPolicyError(
      `LLM provider URL must use HTTPS unless ${LLM_ALLOW_INSECURE_HTTP_ENV} is enabled for development`
    );
  }
  if (url.username || url.password) {
    throw new LlmOutboundPolicyError('LLM provider URL must not contain userinfo');
  }
  if (url.search) {
    // Query strings are especially dangerous here: the gateway appends fixed API
    // paths with string concatenation, which would put that path inside the query,
    // and query values commonly contain credentials that then leak through UI/logs.
    throw new LlmOutboundPolicyError('LLM provider URL must not contain a query');
  }
  if (url.hash) {
    throw new LlmOutboundPolicyError('LLM provider URL must not contain a fragment');
  }

  const hostname = canonicalHostname(url.hostname);
  url.hostname = hostname;
  const origin = url.origin;


  return { url, origin, hostname };
}

function withoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 4 && !NON_PUBLIC_IPV4.check(address, 'ipv4')) return;
  if (family === 6 && !NON_PUBLIC_IPV6.check(address, 'ipv6')) return;
  if (family === 0) {
    throw new LlmOutboundPolicyError('LLM provider DNS returned an invalid address');
  }
  throw new LlmOutboundPolicyError(
    'LLM provider host must resolve only to public network addresses'
  );
}

async function defaultLookupAddresses(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

async function withDnsTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LlmOutboundPolicyError('LLM provider DNS lookup timed out'));
    }, DNS_LOOKUP_TIMEOUT_MS);
    timeout.unref?.();
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolvePublicAddresses(
  hostname: string,
  lookupAddresses: LlmAddressLookup
): Promise<readonly string[]> {
  const addressLiteral = withoutIpv6Brackets(hostname);
  if (isIP(addressLiteral)) {
    assertPublicAddress(addressLiteral);
    return [addressLiteral];
  }

  if (
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new LlmOutboundPolicyError('LLM provider host must be a public DNS name');
  }

  let addresses: readonly string[];
  try {
    addresses = await withDnsTimeout(lookupAddresses(hostname));
  } catch (error) {
    if (error instanceof LlmOutboundPolicyError) throw error;
    throw new LlmOutboundPolicyError('LLM provider hostname could not be resolved safely');
  }

  if (addresses.length === 0 || addresses.length > MAX_DNS_ADDRESSES) {
    throw new LlmOutboundPolicyError('LLM provider hostname returned no safe DNS addresses');
  }
  for (const address of addresses) assertPublicAddress(address);
  return [...new Set(addresses)];
}

type ResolvedLlmTarget = {
  url: string;
  addresses: readonly string[];
};

async function resolveLlmProviderTarget(
  value: string,
  dependencies: Pick<LlmOutboundDependencies, 'lookupAddresses'>
): Promise<ResolvedLlmTarget> {
  const { url, origin, hostname } = parseHttpUrl(value);
  const addresses = await resolvePublicAddresses(
    hostname,
    dependencies.lookupAddresses ?? defaultLookupAddresses
  );
  const pathname = url.pathname.replace(/\/+$/, '');
  return {
    url: pathname ? `${origin}${pathname}` : origin,
    addresses,
  };
}

function createPinnedDispatcher(addresses: readonly string[]): Dispatcher {
  const entries = addresses.map((address) => ({
    address,
    family: isIP(address) as 4 | 6,
  }));

  return new Agent({
    connections: 1,
    pipelining: 0,
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connect: {
      lookup(_hostname, options, callback) {
        const family =
          typeof options === 'number'
            ? options
            : typeof options?.family === 'number'
              ? options.family
              : 0;
        const eligible = family === 4 || family === 6
          ? entries.filter((entry) => entry.family === family)
          : entries;
        if (eligible.length === 0) {
          const error = Object.assign(
            new Error('No validated address matches the requested family'),
            { code: 'ENOTFOUND' }
          );
          callback(error, undefined as never);
          return;
        }
        if (typeof options === 'object' && options?.all) {
          callback(null, eligible as never);
          return;
        }
        callback(null, eligible[0].address, eligible[0].family);
      },
    },
  });
}

/**
 * Validate and canonicalize a persisted provider base URL.
 *
 * There is no origin allowlist: on a self-hosted single-operator deployment the
 * administrator and the person who can edit the deployment env are the same
 * person, so an env-var allowlist adds no boundary against the only party it
 * could restrict — it only costs an SSH round trip and a restart per provider.
 *
 * What remains is the part that protects against the host itself misbehaving,
 * and costs the operator nothing: literal and DNS-resolved addresses are checked
 * against non-public ranges, the resolved answer set is pinned for the actual
 * connection (so a rebinding server cannot answer public for validation and
 * private for the socket), and redirects are never followed.
 */
export async function validateLlmProviderBaseUrl(
  value: string,
  dependencies: Pick<LlmOutboundDependencies, 'lookupAddresses'> = {}
): Promise<string> {
  return (await resolveLlmProviderTarget(value, dependencies)).url;
}

/** Validate at the actual network sink, refuse redirects, and never forward secrets to a new origin. */
export async function fetchLlmOutbound(
  value: string,
  init: RequestInit = {},
  dependencies: LlmOutboundDependencies = {}
): Promise<Response> {
  const target = await resolveLlmProviderTarget(value, dependencies);
  // SEC-034: DNS validation and connection establishment must use the same answer set. A normal
  // fetch would resolve the hostname again, allowing a rebinding server to return a public IP for
  // policy validation and a private IP for the socket. The pinned lookup preserves the original
  // hostname for TLS SNI/certificate verification while restricting the peer addresses.
  const dispatcher =
    dependencies.dispatcherFactory?.(target.addresses) ??
    createPinnedDispatcher(target.addresses);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(target.url, {
      ...init,
      // Node fetch strips Authorization on a cross-origin redirect but retains
      // arbitrary headers such as Anthropic's x-api-key. Never follow any 3xx.
      redirect: 'manual',
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
  // close() stops reuse immediately and resolves after the caller consumes the active body. Do not
  // await it here: doing so before returning the Response would deadlock streaming bodies.
  void dispatcher.close().catch(() => undefined);
  if (response.status >= 300 && response.status < 400) {
    // Do not include Location in the error: a legacy upstream may place a secret
    // in its redirect query, and this error can reach logs or an API response.
    throw new LlmOutboundPolicyError('LLM provider redirects are not allowed');
  }
  return response;
}

/** Safe endpoint shape for audit records; query values and userinfo are never returned. */
export function describeLlmEndpointForAudit(value: unknown): Record<string, unknown> {
  const raw = String(value ?? '');
  try {
    const url = new URL(raw);
    const hostname = canonicalHostname(url.hostname);
    url.hostname = hostname;
    const pathSegments = url.pathname.split('/').filter(Boolean).length;
    const queryParamCount = [...url.searchParams].length;
    return {
      // URL.origin never contains userinfo, path, query, or fragment.
      origin: url.origin,
      pathSha256: createHash('sha256').update(url.pathname).digest('hex'),
      pathSegments,
      queryParamCount,
      hasQuery: url.search.length > 0,
      hasUserinfo: Boolean(url.username || url.password),
      hasFragment: url.hash.length > 0,
    };
  } catch {
    return {
      invalid: true,
      inputSha256: createHash('sha256').update(raw).digest('hex'),
      inputBytes: Buffer.byteLength(raw, 'utf8'),
    };
  }
}
