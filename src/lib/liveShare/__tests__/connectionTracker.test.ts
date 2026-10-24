// 验证 server/websocket.ts 握手中间件所用的每 IP 连接名额记账（connectionTracker.ts）。
// 回归点：旧实现「中间件 +1、connection 里挂 disconnect -1」——底层连接在中间件与
// socket.io 的 nextTick 之间关闭时，'connection' 不触发，名额永久泄漏。用真实 socket.io
// 服务 + 手工构造的 polling 请求（同一个 POST 里先 CONNECT 再 engine.io close）稳定复现。

import { EventEmitter } from 'events';
import { createServer, request as httpRequest } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server as SocketIOServer, type Socket as ServerSocket } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';
import { createIpConnectionTracker } from '@/lib/liveShare/connectionTracker';

function rawRequest(
  port: number,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: body
          ? {
              'Content-Type': 'text/plain;charset=UTF-8',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** engine.io 握手拿 sid 后，在同一个 POST 里发 socket.io CONNECT（"40"）紧跟 close 包（"1"）。 */
async function abortedHandshake(port: number) {
  const handshake = await rawRequest(port, 'GET', '/socket.io/?EIO=4&transport=polling');
  const sid = (JSON.parse(handshake.slice(1)) as { sid: string }).sid;
  await rawRequest(
    port,
    'POST',
    `/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    '40\x1e1'
  );
}

function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error('condition not met in time'));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('createIpConnectionTracker（真实 socket.io 握手）', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let port: number;
  let tracker: ReturnType<typeof createIpConnectionTracker>;
  const clients: Socket[] = [];

  beforeEach(async () => {
    tracker = createIpConnectionTracker(2);
    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    // 与 server/websocket.ts 同一接线：占名额失败即拒连
    io.use((socket, next) => {
      const outcome = tracker.acquire(socket, socket.handshake.address);
      if (outcome === 'closed') return next(new Error('Connection closed during handshake'));
      if (outcome === 'limit') return next(new Error('Too many connections from this IP'));
      return next();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  function connectClient() {
    const client = createClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(client);
    return client;
  }

  it('握手途中断开的连接不泄漏名额（旧实现每次 +1 永不归还）', async () => {
    for (let i = 0; i < 5; i += 1) {
      await abortedHandshake(port);
    }
    // 给 socket.io 的 nextTick / engine.io 关闭流程留出时间
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(io.of('/').sockets.size).toBe(0);
    expect(tracker.count('127.0.0.1')).toBe(0);
    expect(tracker.size).toBe(0);

    // 名额没被吃掉：上限 2 的情况下仍能正常连上
    const client = connectClient();
    await onceSocketEvent(client, 'connect');
    expect(tracker.count('127.0.0.1')).toBe(1);
  });

  it('正常连上 / 断开：名额 +1 / -1', async () => {
    const client = connectClient();
    await onceSocketEvent(client, 'connect');
    expect(tracker.count('127.0.0.1')).toBe(1);

    client.disconnect();
    await waitFor(() => tracker.count('127.0.0.1') === 0);
    expect(tracker.size).toBe(0);
  });

  it('达到上限后拒连；释放一个名额后可再连', async () => {
    const first = connectClient();
    const second = connectClient();
    await Promise.all([onceSocketEvent(first, 'connect'), onceSocketEvent(second, 'connect')]);
    expect(tracker.count('127.0.0.1')).toBe(2);

    const third = connectClient();
    const error = await onceSocketEvent<Error>(third, 'connect_error');
    expect(error.message).toBe('Too many connections from this IP');
    expect(tracker.count('127.0.0.1')).toBe(2);

    first.disconnect();
    await waitFor(() => tracker.count('127.0.0.1') === 1);

    const fourth = connectClient();
    await onceSocketEvent(fourth, 'connect');
    expect(tracker.count('127.0.0.1')).toBe(2);
  });

  it('服务端踢掉 socket（disconnect(true)）后名额归还', async () => {
    const serverSocketPromise = new Promise<ServerSocket>((resolve) => {
      io.once('connection', resolve);
    });
    const client = connectClient();
    await onceSocketEvent(client, 'connect');
    const serverSocket = await serverSocketPromise;
    expect(tracker.count('127.0.0.1')).toBe(1);

    serverSocket.disconnect(true);
    await waitFor(() => tracker.count('127.0.0.1') === 0);
  });
});

describe('createIpConnectionTracker（单元：恰好释放一次）', () => {
  function fakeSocket(readyState = 'open') {
    const conn = Object.assign(new EventEmitter(), { readyState });
    const socket = Object.assign(new EventEmitter(), { conn });
    return { socket: socket as unknown as ServerSocket, conn, emitter: socket };
  }

  it('底层连接已关闭时不占名额', () => {
    const tracker = createIpConnectionTracker(5);
    const { socket } = fakeSocket('closed');
    expect(tracker.acquire(socket, '10.0.0.1')).toBe('closed');
    expect(tracker.count('10.0.0.1')).toBe(0);
  });

  it('close 与 disconnect 先后到达只释放一次，且不影响同 IP 的其他名额', () => {
    const tracker = createIpConnectionTracker(5);
    const a = fakeSocket();
    const b = fakeSocket();
    expect(tracker.acquire(a.socket, '10.0.0.1')).toBe('ok');
    expect(tracker.acquire(b.socket, '10.0.0.1')).toBe('ok');
    expect(tracker.count('10.0.0.1')).toBe(2);

    a.conn.emit('close');
    a.emitter.emit('disconnect');
    a.conn.emit('close');
    expect(tracker.count('10.0.0.1')).toBe(1);
    expect(a.conn.listenerCount('close')).toBe(0);
    expect(a.emitter.listenerCount('disconnect')).toBe(0);

    b.emitter.emit('disconnect');
    expect(tracker.count('10.0.0.1')).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('clear() 之后迟到的释放不会把计数减成负数', () => {
    const tracker = createIpConnectionTracker(5);
    const a = fakeSocket();
    tracker.acquire(a.socket, '10.0.0.1');
    tracker.clear();
    a.conn.emit('close');
    expect(tracker.count('10.0.0.1')).toBe(0);
    expect(tracker.size).toBe(0);
  });
});
