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
      // 无上限重连。旧实现在 times > 3（累计约 1.2s）返回 null，ioredis 随即 close()/
      // setStatus('end') 永久放弃；而实例缓存在 globalThis 从不重建 → 一次常规
      // `docker restart redis` 就让该进程余生失去 Redis（token 吊销、限流全线降级到
      // 进程内存）。指数退避封顶 30s：稳态每分钟最多 2 次重连尝试，代价可忽略。
      retryStrategy(times) {
        return Math.min(2 ** Math.min(times, 8) * 100, 30_000);
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
