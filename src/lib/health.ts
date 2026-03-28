import 'server-only';

import { prisma } from '@/lib/prisma';
import { getRedisClient } from '@/lib/redis';
import { getSiteSettings } from '@/lib/siteSettings';

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
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: error instanceof Error ? error.message : 'Database unavailable',
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
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: error instanceof Error ? error.message : 'Redis unavailable',
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
    return {
      status: 'down',
      latencyMs: durationMsFrom(startedAt),
      detail: error instanceof Error ? error.message : 'Cloudreve unavailable',
    };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis, cloudreve] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkCloudreve(),
  ]);

  let status: AppHealthStatus = 'ok';
  if (database.status === 'down') {
    status = 'down';
  } else if (redis.status === 'down' || cloudreve.status === 'down') {
    status = 'degraded';
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    dependencies: {
      database,
      redis,
      cloudreve,
    },
  };
}
