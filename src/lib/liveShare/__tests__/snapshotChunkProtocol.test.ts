// H1 服务端侧：分块 sync_snapshot 的提交语义与拒绝规则。
//
// 关键不变式（snapshotChunking.ts 的 I3）：sync_snapshot 是**全量覆盖**语义，所以
// 半份快照绝不能覆盖服务端已有历史 —— 这是 U11 明令警告过的事故形态。因此：
//   - 首块只暂存，集齐 chunkCount 块才原子提交；
//   - 乱序/串批次/畸形分块字段一律整条丢弃，绝不降级成「全量覆盖」；
//   - 提交前观众 join 读到的仍是**上一份完整快照**，不是半份。
//
// 另含 L5：未鉴权 join 的每 socket 预算闸。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

const { shareLinkFindUniqueMock, verifyAuthTokenMock } = vi.hoisted(() => ({
  shareLinkFindUniqueMock: vi.fn(),
  verifyAuthTokenMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    shareLink: {
      findUnique: shareLinkFindUniqueMock,
      findMany: vi.fn(async () => []),
    },
    session: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock('@/lib/auth', () => ({
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  extractTokenFromCookieHeader: vi.fn(() => null),
  verifyAuthToken: verifyAuthTokenMock,
}));

vi.mock('@/lib/logger', () => {
  const noop = vi.fn();
  return {
    logger: {
      child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    },
    serializeError: (error: unknown) =>
      error instanceof Error ? { message: error.message } : { message: String(error) },
  };
});

import { setupLiveShare } from '@/lib/liveShare/server';

interface ViewerState {
  segments: Array<{ id: string }>;
  translations: Record<string, string>;
  truncated?: boolean;
}

describe('分块 sync_snapshot 的服务端语义（H1）', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    verifyAuthTokenMock.mockResolvedValue({
      user: { id: 'user-1', email: 'alice@example.com', role: 'ADMIN' },
      token: { jti: 'jti-1', tokenVersion: 1 },
      rawToken: 'server-jwt',
    });
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        if (token !== 'share-token') return null;
        return {
          id: 'link-1',
          token,
          sessionId: 'session-1',
          createdBy: 'user-1',
          isLive: true,
          expiresAt: null,
          session: { id: 'session-1', userId: 'user-1', status: 'RECORDING' },
        };
      }
    );

    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    teardownLiveShare = setupLiveShare(io);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
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
    teardownLiveShare();
    await new Promise<void>((resolve) => {
      io.close(() => httpServer.close(() => resolve()));
    });
  });

  async function connectHost() {
    const host = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(host);
    await onceSocketEvent(host, 'initial_state'); // 鉴权完成的信号
    return host;
  }

  async function connectViewer() {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    return viewer;
  }

  async function readSnapshot(viewer: Socket): Promise<ViewerState> {
    const statePromise = onceSocketEvent<ViewerState>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    return statePromise;
  }

  function chunk(
    chunkId: string,
    chunkIndex: number,
    chunkCount: number,
    segments: Array<{ id: string }>,
    extra: Record<string, unknown> = {}
  ) {
    return {
      chunkId,
      chunkIndex,
      chunkCount,
      segments,
      summaryBlocks: [],
      translations: {},
      ...extra,
    };
  }

  it('集齐全部块才提交：中途 join 的观众读到的是上一份完整快照，不是半份', async () => {
    const host = await connectHost();
    const viewer = await connectViewer();

    // 先落一份完整的旧快照（单块）
    host.emit('sync_snapshot', {
      segments: [{ id: 'old-1' }, { id: 'old-2' }],
      summaryBlocks: [],
      translations: {},
      status: 'RECORDING',
    });
    await expect(
      readSnapshot(viewer).then((s) => s.segments.map((seg) => seg.id))
    ).resolves.toEqual(['old-1', 'old-2']);

    // 新一批只发首块（共 3 块）——此时不得提交
    host.emit('sync_snapshot', chunk('batch-A', 0, 3, [{ id: 'new-1' }]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await readSnapshot(viewer)).segments.map((s) => s.id)).toEqual([
      'old-1',
      'old-2',
    ]);

    // 补齐剩余两块 → 原子提交
    host.emit('sync_snapshot', chunk('batch-A', 1, 3, [{ id: 'new-2' }]));
    host.emit('sync_snapshot', chunk('batch-A', 2, 3, [{ id: 'new-3' }]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await readSnapshot(viewer)).segments.map((s) => s.id)).toEqual([
      'new-1',
      'new-2',
      'new-3',
    ]);
  });

  it('没有首块的续块被丢弃，不会用残片覆盖服务端历史', async () => {
    const host = await connectHost();
    const viewer = await connectViewer();

    host.emit('sync_snapshot', {
      segments: [{ id: 'keep-1' }],
      summaryBlocks: [],
      translations: {},
    });
    await expect(
      readSnapshot(viewer).then((s) => s.segments.map((seg) => seg.id))
    ).resolves.toEqual(['keep-1']);

    host.emit('sync_snapshot', chunk('rogue', 1, 2, [{ id: 'rogue-1' }]));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect((await readSnapshot(viewer)).segments.map((s) => s.id)).toEqual([
      'keep-1',
    ]);
  });

  it('畸形分块字段整条丢弃（绝不降级成全量覆盖）', async () => {
    const host = await connectHost();
    const viewer = await connectViewer();

    host.emit('sync_snapshot', {
      segments: [{ id: 'keep-1' }],
      summaryBlocks: [],
      translations: {},
    });
    await readSnapshot(viewer);

    // chunkCount 越上限：readSnapshotChunkMeta → invalid
    host.emit('sync_snapshot', chunk('bad', 0, 9_999, [{ id: 'bad-1' }]));
    // chunkIndex 越界
    host.emit('sync_snapshot', chunk('bad2', 5, 2, [{ id: 'bad-2' }]));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect((await readSnapshot(viewer)).segments.map((s) => s.id)).toEqual([
      'keep-1',
    ]);
  });

  it('新一批的首块作废上一批未完成的暂存（不会把两批混在一起）', async () => {
    const host = await connectHost();
    const viewer = await connectViewer();

    host.emit('sync_snapshot', chunk('batch-A', 0, 2, [{ id: 'a-1' }]));
    // A 还差一块就被 B 顶掉
    host.emit('sync_snapshot', chunk('batch-B', 0, 2, [{ id: 'b-1' }]));
    // A 的迟到续块必须被拒（chunkId 对不上）
    host.emit('sync_snapshot', chunk('batch-A', 1, 2, [{ id: 'a-2' }]));
    host.emit('sync_snapshot', chunk('batch-B', 1, 2, [{ id: 'b-2' }]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await readSnapshot(viewer)).segments.map((s) => s.id)).toEqual([
      'b-1',
      'b-2',
    ]);
  });

  it('首块的 truncated 标记随 initial_state 下发给观众', async () => {
    const host = await connectHost();
    const viewer = await connectViewer();

    host.emit(
      'sync_snapshot',
      chunk('batch-T', 0, 1, [{ id: 't-1' }], {
        truncated: true,
        droppedSegments: 42,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect((await readSnapshot(viewer)).truncated).toBe(true);
  });
});

describe('未鉴权 join 的每 socket 预算闸（L5）', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    shareLinkFindUniqueMock.mockReset();
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        if (token !== 'share-token') return null;
        return {
          id: 'link-1',
          token,
          sessionId: 'session-1',
          createdBy: 'user-1',
          isLive: true,
          expiresAt: null,
          session: { id: 'session-1', userId: 'user-1', status: 'RECORDING' },
        };
      }
    );

    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    teardownLiveShare = setupLiveShare(io);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
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
    teardownLiveShare();
    await new Promise<void>((resolve) => {
      io.close(() => httpServer.close(() => resolve()));
    });
  });

  it('单 socket 狂刷 join 时，超预算的部分不再打 DB（守卫排在查询之前）', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');

    for (let i = 0; i < 30; i += 1) {
      viewer.emit('join', { shareToken: 'share-token' });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 桶容量 5 + 300ms 回填不到 1 → DB 查询次数必须远小于 30
    expect(shareLinkFindUniqueMock.mock.calls.length).toBeLessThanOrEqual(8);
    expect(shareLinkFindUniqueMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('正常观众（每条连接 join 一两次）不受影响', async () => {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');

    const first = onceSocketEvent<ViewerState>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await first;

    const second = onceSocketEvent<ViewerState>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    await expect(second).resolves.toBeTruthy();
  });
});
