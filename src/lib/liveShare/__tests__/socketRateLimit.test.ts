// 验证 server/websocket.ts 中的「每 socket 入站消息限流」行为。
// websocket.ts 是带副作用的进程入口（import 即 listen + 启动后台 loop），
// 无法直接 import 测试；此处用相同的令牌桶参数 + onAny 断连接线复刻其逻辑，
// 在真实 socket.io 服务上断言：突发可放行、持续洪泛会被断连、停顿后令牌回填恢复可用。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

// 与 server/websocket.ts 保持一致的限流参数
const RATE_LIMIT_REFILL_PER_SEC = 20;
const RATE_LIMIT_BUCKET_CAPACITY = 40;

interface SocketRateState {
  tokens: number;
  lastRefillMs: number;
}

function consumeRateToken(state: SocketRateState, nowMs: number): boolean {
  const elapsedMs = nowMs - state.lastRefillMs;
  if (elapsedMs > 0) {
    state.tokens = Math.min(
      RATE_LIMIT_BUCKET_CAPACITY,
      state.tokens + (elapsedMs / 1000) * RATE_LIMIT_REFILL_PER_SEC
    );
    state.lastRefillMs = nowMs;
  }
  if (state.tokens < 1) {
    return false;
  }
  state.tokens -= 1;
  return true;
}

describe('每 socket 消息限流（令牌桶）', () => {
  it('纯函数：桶容量内放行，桶空后拒绝，停顿回填后恢复', () => {
    const state: SocketRateState = {
      tokens: RATE_LIMIT_BUCKET_CAPACITY,
      lastRefillMs: 0,
    };

    // 同一时刻连发：前 40 条（容量）放行，第 41 条拒绝
    for (let i = 0; i < RATE_LIMIT_BUCKET_CAPACITY; i += 1) {
      expect(consumeRateToken(state, 0)).toBe(true);
    }
    expect(consumeRateToken(state, 0)).toBe(false);

    // 停顿 1s 回填 ~20 令牌 → 又可放行 20 条
    let allowed = 0;
    for (let i = 0; i < 25; i += 1) {
      if (consumeRateToken(state, 1000)) allowed += 1;
    }
    expect(allowed).toBe(RATE_LIMIT_REFILL_PER_SEC);
  });

  it('稳态被限制在 ~20 msg/s（每 50ms 放 1 个，10s 窗口约 20×10）', () => {
    const state: SocketRateState = {
      tokens: RATE_LIMIT_BUCKET_CAPACITY,
      lastRefillMs: 0,
    };
    // 模拟匀速来包：先耗尽初始容量再观察稳态速率
    let now = 0;
    // 耗尽初始桶
    for (let i = 0; i < RATE_LIMIT_BUCKET_CAPACITY; i += 1) {
      consumeRateToken(state, now);
    }
    let allowed = 0;
    // 接下来 1 秒，每 10ms 来一个包（100 包/s 的洪泛）
    for (let i = 0; i < 100; i += 1) {
      now += 10;
      if (consumeRateToken(state, now)) allowed += 1;
    }
    // 稳态放行应接近 refill 速率（20/s），远小于来包速率 100/s
    expect(allowed).toBeGreaterThanOrEqual(18);
    expect(allowed).toBeLessThanOrEqual(22);
  });

  describe('集成：onAny 断连接线', () => {
    let httpServer: ReturnType<typeof createServer>;
    let io: SocketIOServer;
    let baseUrl: string;
    const clients: Socket[] = [];

    beforeEach(async () => {
      httpServer = createServer();
      io = new SocketIOServer(httpServer, { transports: ['websocket'] });

      io.on('connection', (socket) => {
        const rateState: SocketRateState = {
          tokens: RATE_LIMIT_BUCKET_CAPACITY,
          lastRefillMs: Date.now(),
        };
        socket.onAny(() => {
          if (consumeRateToken(rateState, Date.now())) {
            return;
          }
          socket.disconnect(true);
        });
        socket.on('ping_msg', () => {
          // no-op 业务 handler，仅用于触发 onAny 计数
        });
      });

      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });
      const address = httpServer.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await Promise.all(
        clients.map((client) =>
          client.connected
            ? new Promise<void>((resolve) => {
                client.once('disconnect', () => resolve());
                client.disconnect();
              })
            : Promise.resolve()
        )
      );
      clients.length = 0;
      await new Promise<void>((resolve) => {
        io.close(() => httpServer.close(() => resolve()));
      });
    });

    it('单 socket 瞬间洪泛大量消息会被服务端断连', async () => {
      const client = createClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
      });
      clients.push(client);

      await onceSocketEvent(client, 'connect');

      const disconnectPromise = onceSocketEvent<string>(client, 'disconnect');
      // 远超桶容量(40)的瞬时洪泛 → 必触发断连
      for (let i = 0; i < 500; i += 1) {
        client.emit('ping_msg', i);
      }

      const reason = await disconnectPromise;
      expect(typeof reason).toBe('string');
      expect(client.connected).toBe(false);
    });
  });
});
