import 'server-only';

import { timingSafeEqual } from 'node:crypto';
import { connect as netConnect } from 'node:net';

import { logger, serializeError } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { getRedisClient } from '@/lib/redis';
import { getSiteSettings } from '@/lib/siteSettings';

// 深度报告只由带内部 bearer 的 /api/health/ready 返回；即便如此仍只回固定文案，
// 避免监控输出或代理日志泄露内网主机名/端口/连接串。原始错误仅进服务端日志。
const DEPENDENCY_DOWN_DETAIL = 'unavailable';

// A timeout only stops the readiness request from waiting; Prisma and some Redis
// clients cannot cancel an already-issued command. Keep one underlying probe per
// dependency until it really settles so a black-holed backend cannot accumulate
// another live query every time the short readiness cache expires.
const probeFlights = new Map<string, Promise<DependencyHealth>>();

export type DependencyHealthStatus = 'up' | 'down' | 'disabled';
export type AppHealthStatus = 'ok' | 'degraded' | 'down';

export interface DependencyHealth {
  status: DependencyHealthStatus;
  latencyMs: number | null;
  detail?: string;
}

export interface HealthReport {
  status: AppHealthStatus;
  checkedAt: string;
  dependencies: {
    database: DependencyHealth;
    redis: DependencyHealth;
    cloudreve: DependencyHealth;
    websocket: DependencyHealth;
  };
}

function durationMsFrom(startedAt: number) {
  return Date.now() - startedAt;
}

async function withProbeDeadline(
  name: string,
  createProbe: () => Promise<DependencyHealth>,
  timeoutMs: number
): Promise<DependencyHealth> {
  let probe = probeFlights.get(name);
  if (!probe) {
    const started = createProbe();
    probe = started.finally(() => {
      if (probeFlights.get(name) === probe) {
        probeFlights.delete(name);
      }
    });
    probeFlights.set(name, probe);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DependencyHealth>((resolve) => {
    timer = setTimeout(() => {
      logger.error({ probe: name, timeoutMs }, 'Health check probe timed out');
      resolve({
        status: 'down',
        latencyMs: timeoutMs,
        detail: DEPENDENCY_DOWN_DETAIL,
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDatabase(): Promise<DependencyHealth> {
  const startedAt = Date.now();

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return {
      status: 'up',
      latencyMs: durationMsFrom(startedAt),
    };
  } catch (error) {
    logger.error({ err: serializeError(error) }, 'Health check: database down');
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: DEPENDENCY_DOWN_DETAIL,
    };
  }
}

async function checkRedis(): Promise<DependencyHealth> {
  const startedAt = Date.now();
  const redis = getRedisClient();

  if (!redis) {
    return {
      status: 'disabled',
      latencyMs: null,
      detail: 'REDIS_URL not configured',
    };
  }

  try {
    const pong = await redis.ping();
    return {
      status: pong === 'PONG' ? 'up' : 'down',
      latencyMs: durationMsFrom(startedAt),
      ...(pong === 'PONG' ? {} : { detail: DEPENDENCY_DOWN_DETAIL }),
    };
  } catch (error) {
    logger.error({ err: serializeError(error) }, 'Health check: redis down');
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: DEPENDENCY_DOWN_DETAIL,
    };
  }
}

async function resolveCloudreveBaseUrl(): Promise<string | null> {
  const envUrl = process.env.CLOUDREVE_BASE_URL?.trim();
  if (envUrl) {
    return envUrl;
  }

  try {
    const settings = await getSiteSettings();
    if (settings.storage_mode === 'cloudreve' && settings.cloudreve_url.trim()) {
      return settings.cloudreve_url.trim();
    }
  } catch {
    return null;
  }

  return null;
}

async function checkCloudreve(): Promise<DependencyHealth> {
  const baseUrl = await resolveCloudreveBaseUrl();
  if (!baseUrl) {
    return {
      status: 'disabled',
      latencyMs: null,
      detail: 'Cloudreve not configured',
    };
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(baseUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });

    const reachable =
      response.status < 500 ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 405;

    return {
      status: reachable ? 'up' : 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    logger.error({ err: serializeError(error) }, 'Health check: cloudreve down');
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: DEPENDENCY_DOWN_DETAIL,
    };
  }
}

/**
 * L7：WS 进程存活探针。
 *
 * 单容器部署里 docker-entrypoint.sh 同时拉起 Next 与 WS；深度 readiness 会体检
 * DB/Redis/Cloudreve —— WS 崩掉后 Next 照常 200，Docker healthcheck 恒绿、永不重启，
 * 实时转录与直播分享整条链路静默失效。这里补一个到 WS 端口的 TCP 探针。
 *
 * 只连不发：WS 进程对非 /internal 路径一律回 404，靠 HTTP 状态码判活反而要区分
 * 「拒连(4)」与「404(8)」两种 wget 退出码，不如握手本身直接。
 *
 * 地址口径与 revocationNotifier.resolveInternalBaseUrl 保持一致
 * （LIVE_SHARE_WS_INTERNAL_URL 优先，否则回环 + WS_PORT）。
 * 不同机部署且没配 LIVE_SHARE_WS_INTERNAL_URL 时用 HEALTH_CHECK_WEBSOCKET=0 关掉本项。
 */
function resolveWebsocketProbeTarget(): { host: string; port: number } | null {
  if (process.env.HEALTH_CHECK_WEBSOCKET === '0') return null;

  const explicit = process.env.LIVE_SHARE_WS_INTERNAL_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      const port = url.port
        ? Number(url.port)
        : url.protocol === 'https:'
          ? 443
          : 80;
      if (!url.hostname || !Number.isFinite(port)) return null;
      return { host: url.hostname, port };
    } catch {
      return null;
    }
  }

  const port = parseInt(process.env.WS_PORT || '3001', 10);
  if (!Number.isFinite(port)) return null;
  return { host: '127.0.0.1', port };
}

async function checkWebsocket(): Promise<DependencyHealth> {
  const target = resolveWebsocketProbeTarget();
  if (!target) {
    return {
      status: 'disabled',
      latencyMs: null,
      detail: 'WebSocket health probe disabled',
    };
  }

  const startedAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = netConnect({ host: target.host, port: target.port });
      const done = (err?: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      socket.setTimeout(2000, () => done(new Error('timeout')));
      socket.once('connect', () => done());
      socket.once('error', (err: Error) => done(err));
    });
    return { status: 'up', latencyMs: durationMsFrom(startedAt) };
  } catch (error) {
    logger.error({ err: serializeError(error) }, 'Health check: websocket down');
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: DEPENDENCY_DOWN_DETAIL,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  M23：去抖缓存 + 公开视图裁剪                                          */
/* ------------------------------------------------------------------ */

/**
 * M23：`/api/health` 被 middleware 显式放行、无鉴权，而每次调用要做
 * 1 次 DB `SELECT 1` + 1 次 Redis PING + **1 次对 Cloudreve 的出站 HTTP HEAD**
 * + 1 次到 WS 端口的 TCP 连接 —— 脚本化高频打它就是一台放大器（尤其那次出站请求）。
 *
 * 这里加一层「短 TTL + singleflight」：无论并发多高，每 {@link HEALTH_CACHE_TTL_MS}
 * 只真正体检一次，其余全部读缓存。放大倍数从 O(请求数) 变成 O(时间)。
 *
 * TTL 必须**小于** Dockerfile 里 HEALTHCHECK 的 interval（30s），否则容器探活会读到
 * 过期结论、故障发现被拖慢。默认 10s，可用 HEALTH_CACHE_TTL_MS 调整。
 *
 * 刻意**不**在路由上挂 enforceRateLimit：限流一旦触发就是 429，
 * 而 Dockerfile 的 `wget ... || exit 1` 会把 429 当成不健康 → HEALTHCHECK 转红 →
 * 重启策略拉起整个容器。等于给攻击者一个「打 /api/health 就能重启你的容器」的开关，
 * 比原问题更糟。请求**量**的兜底交给反代（deploy/nginx-lecturelive.conf 的 limit_req）。
 */
function healthCacheTtlMs(): number {
  const raw = Number(process.env.HEALTH_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 10_000;
}

let cachedReport: { report: HealthReport; at: number } | null = null;
let inFlight: Promise<HealthReport> | null = null;

/** 仅供测试：清空去抖缓存。 */
export function __resetHealthCache(): void {
  cachedReport = null;
  inFlight = null;
}

export async function getCachedHealthReport(): Promise<HealthReport> {
  const ttl = healthCacheTtlMs();
  const now = Date.now();

  if (cachedReport && now - cachedReport.at < ttl) {
    return cachedReport.report;
  }

  // singleflight：并发 miss 只跑一次真实体检
  if (inFlight) {
    return inFlight;
  }

  inFlight = getHealthReport()
    .then((report) => {
      cachedReport = { report, at: Date.now() };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * M23：公开视图只回「整体健康与否」。
 *
 * 原实现对匿名调用方直接吐出依赖拓扑（哪些依赖启用/禁用、各依赖延迟 ms、
 * `Cloudreve not configured` 这类指纹），足够画出内部架构并按延迟推断负载。
 * 明细只给带内部凭据（HEALTH_DETAIL_TOKEN + x-health-token 头）的调用方。
 */
export function redactHealthReport(report: HealthReport): Pick<HealthReport, 'status' | 'checkedAt'> {
  return { status: report.status, checkedAt: report.checkedAt };
}

/** 请求是否有权看依赖明细：需配置 HEALTH_DETAIL_TOKEN 且请求头匹配。 */
export function isHealthDetailAuthorized(req: Request): boolean {
  const expected = process.env.HEALTH_DETAIL_TOKEN?.trim();
  if (!expected) return false;
  const provided = req.headers.get('x-health-token')?.trim();
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis, cloudreve, websocket] = await Promise.all([
    withProbeDeadline('database', checkDatabase, 2_000),
    withProbeDeadline('redis', checkRedis, 2_000),
    withProbeDeadline('cloudreve', checkCloudreve, 3_500),
    withProbeDeadline('websocket', checkWebsocket, 2_500),
  ]);

  // WS 挂了默认只算 degraded（分体部署时不该因 WS 抖动把 Web 摘出负载均衡）；
  // 单容器镜像里 Dockerfile 显式置 HEALTH_WS_REQUIRED=1，让它升级成 down → /api/health/ready
  // 回 503 → HEALTHCHECK 转红 → 重启策略把整容器拉起来（WS 与 Web 同生共死）。
  const websocketRequired = process.env.HEALTH_WS_REQUIRED === '1';

  let status: AppHealthStatus = 'ok';
  if (
    database.status === 'down' ||
    (websocketRequired && websocket.status === 'down')
  ) {
    status = 'down';
  } else if (
    redis.status === 'down' ||
    cloudreve.status === 'down' ||
    websocket.status === 'down'
  ) {
    status = 'degraded';
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    dependencies: {
      database,
      redis,
      cloudreve,
      websocket,
    },
  };
}
