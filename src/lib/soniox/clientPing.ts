/**
 * 客户端 Soniox 数据中心延迟测量
 *
 * 直接从浏览器测量到各 Soniox 数据中心的网络延迟，
 * 比服务端测量更准确地反映用户的真实体验。
 */

export interface ClientPingResult {
  region: string;
  label: string;
  latencyMs: number | null;
  reachable: boolean;
}

const PING_TARGETS: Record<string, { label: string; url: string }> = {
  us: { label: 'US (Virginia)', url: 'https://api.soniox.com' },
  eu: { label: 'EU (Frankfurt)', url: 'https://api.eu.soniox.com' },
  jp: { label: 'JP (Tokyo)', url: 'https://api.jp.soniox.com' },
};

/**
 * 从浏览器端测量到指定 URL 的 RTT。
 * 使用 no-cors 模式避免 CORS 限制，虽然响应不可读，
 * 但 fetch 的耗时真实反映了 DNS + TCP + TLS 握手时间。
 */
async function measureClientLatency(url: string): Promise<number | null> {
  try {
    const start = performance.now();
    await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

/**
 * 测量单个区域的延迟（3 次取中位数）。
 */
async function pingRegion(
  region: string,
  target: { label: string; url: string }
): Promise<ClientPingResult> {
  const pings = await Promise.all([
    measureClientLatency(target.url),
    measureClientLatency(target.url),
    measureClientLatency(target.url),
  ]);
  const valid = pings
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  const median = valid.length > 0 ? valid[Math.floor(valid.length / 2)] : null;

  return {
    region,
    label: target.label,
    latencyMs: median,
    reachable: valid.length > 0,
  };
}

/**
 * 从浏览器端测量所有 Soniox 数据中心的延迟。
 * 三个区域并行测量，每个区域 3 次取中位数。
 */
export async function pingAllRegions(): Promise<ClientPingResult[]> {
  return Promise.all(
    Object.entries(PING_TARGETS).map(([region, target]) =>
      pingRegion(region, target)
    )
  );
}

/**
 * 快速测量所有区域（每区域仅 1 次），用于连接前的快速选区。
 */
export async function quickPingAllRegions(): Promise<ClientPingResult[]> {
  return Promise.all(
    Object.entries(PING_TARGETS).map(async ([region, { label, url }]) => {
      const latencyMs = await measureClientLatency(url);
      return {
        region,
        label,
        latencyMs,
        reachable: latencyMs !== null,
      };
    })
  );
}

// ---- 缓存层 ----

interface PingCache {
  results: ClientPingResult[];
  timestamp: number;
}

let pingCache: PingCache | null = null;
const CACHE_TTL = 5 * 60_000; // 5 分钟

/**
 * 获取缓存的 ping 结果。超过 TTL 返回 null。
 */
export function getCachedPingResults(): ClientPingResult[] | null {
  if (!pingCache) return null;
  if (Date.now() - pingCache.timestamp > CACHE_TTL) {
    pingCache = null;
    return null;
  }
  return pingCache.results;
}

/**
 * 更新缓存。
 */
export function setCachedPingResults(results: ClientPingResult[]) {
  pingCache = { results, timestamp: Date.now() };
}

/**
 * 根据 ping 结果选择延迟最低的区域。
 */
export function pickBestRegion(results: ClientPingResult[]): string | null {
  let best: ClientPingResult | null = null;
  for (const r of results) {
    if (r.reachable && r.latencyMs != null) {
      if (!best || r.latencyMs < best.latencyMs!) {
        best = r;
      }
    }
  }
  return best?.region ?? null;
}

/**
 * 自动选择最优区域：优先用缓存，否则做一次快速 ping。
 */
export async function resolveAutoRegion(): Promise<string | null> {
  const cached = getCachedPingResults();
  if (cached) {
    return pickBestRegion(cached);
  }

  const results = await quickPingAllRegions();
  setCachedPingResults(results);
  return pickBestRegion(results);
}
