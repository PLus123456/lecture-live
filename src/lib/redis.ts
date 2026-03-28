import Redis from 'ioredis';
import { logger } from '@/lib/logger';

const REDIS_CLIENT_KEY = '__lectureLiveRedisClient';
const redisLogger = logger.child({ component: 'redis' });

type RedisGlobal = typeof globalThis & {
  [REDIS_CLIENT_KEY]?: Redis;
};

export function getRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return null;
  }

  const globalState = globalThis as RedisGlobal;
  if (!globalState[REDIS_CLIENT_KEY]) {
    globalState[REDIS_CLIENT_KEY] = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      retryStrategy(times) {
        if (times > 3) {
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    });

    globalState[REDIS_CLIENT_KEY].on('connect', () => {
      redisLogger.info('Redis connection established');
    });

    globalState[REDIS_CLIENT_KEY].on('ready', () => {
      redisLogger.info('Redis client ready');
    });

    globalState[REDIS_CLIENT_KEY].on('close', () => {
      redisLogger.warn('Redis connection closed');
    });

    globalState[REDIS_CLIENT_KEY].on('reconnecting', (delay: number) => {
      redisLogger.warn({ delayMs: delay }, 'Redis reconnecting');
    });

    globalState[REDIS_CLIENT_KEY].on('error', (err) => {
      redisLogger.warn(
        { message: err.message },
        'Redis connection error, falling back to in-memory guards'
      );
    });
  }

  return globalState[REDIS_CLIENT_KEY] as Redis;
}
