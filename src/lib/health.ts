import 'server-only';

import { connect as netConnect } from 'node:net';

import { logger, serializeError } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { getRedisClient } from '@/lib/redis';
import { getSiteSettings } from '@/lib/siteSettings';

// /api/health 未授权可读，对外只回固定文案，避免泄露内网主机名/端口/连接串。
// 原始错误仅进服务端日志，供运维排障。
const DEPENDENCY_DOWN_DETAIL = 'unavailable';

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
      ...(pong === 'PONG' ? {} : { detail: `Unexpected ping response: ${pong}` }),
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
 * 单容器部署里 docker-entrypoint.sh 同时拉起 Next 与 WS，但 /api/health 只体检
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

export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis, cloudreve, websocket] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkCloudreve(),
    checkWebsocket(),
  ]);

  // WS 挂了默认只算 degraded（分体部署时不该因 WS 抖动把 Web 摘出负载均衡）；
  // 单容器镜像里 Dockerfile 显式置 HEALTH_WS_REQUIRED=1，让它升级成 down → /api/health
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
