// C16/U11：直播「冷开分享」（先录一段、录到一半才点分享）的三条数据链路。
//  - P7-3(a) 监听器注册顺序：主播客户端在 connect 同刻补发的首帧 sync_snapshot 若落在
//    authenticateBroadcaster 的 await 窗口内，会因零监听器被 socket.io 丢弃。
//  - P7-3(b) 快照目录：直播中草稿在 data/transcript-drafts/，不是收尾后才有的
//    data/transcripts/；只读后者 = 冷开分享观众永远拿不到开分享前的内容。
//  - P7-4    增量折回：三个 broadcast*Delta 不折回 lastSnapshot，而服务端 sync_snapshot
//    是全量覆盖语义 → 主播抖动重连后补发的旧快照把服务端累积的增量整个抹掉。
import { createServer } from 'http';
import { AddressInfo } from 'net';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';
import {
  makeSummaryBlock,
  makeTranscriptSegment,
} from './fixtures';

const {
  shareLinkFindUniqueMock,
  verifyAuthTokenMock,
  diagnoseEstablishedAuthFamilyTokenMock,
} = vi.hoisted(() => ({
  shareLinkFindUniqueMock: vi.fn(),
  verifyAuthTokenMock: vi.fn(),
  diagnoseEstablishedAuthFamilyTokenMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    shareLink: {
      findUnique: shareLinkFindUniqueMock,
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  diagnoseEstablishedAuthFamilyToken: diagnoseEstablishedAuthFamilyTokenMock,
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
import { LiveBroadcaster } from '@/lib/liveShare/broadcaster';

const AUTH_SESSION = {
  user: { id: 'user-1', email: 'alice@example.com', role: 'ADMIN' },
  token: { jti: 'jti-1', tokenVersion: 1 },
  rawToken: 'server-jwt',
};

// 只有 share-token → session-1；draft-token → session-draft（P7-3(b) 用）
const LINKS: Record<string, { sessionId: string }> = {
  'share-token': { sessionId: 'session-1' },
  'draft-token': { sessionId: 'session-draft' },
};

describe('直播冷开分享的历史回填（C16/U11）', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const broadcasters: LiveBroadcaster[] = [];
  const clients: Socket[] = [];

  beforeEach(async () => {
    verifyAuthTokenMock.mockResolvedValue(AUTH_SESSION);
    diagnoseEstablishedAuthFamilyTokenMock.mockResolvedValue({
      status: 'valid',
      session: AUTH_SESSION,
    });
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        const link = LINKS[token];
        if (!link) return null;
        return {
          id: `link-${token}`,
          token,
          sessionId: link.sessionId,
          createdBy: 'user-1',
          isLive: true,
          expiresAt: null,
          session: { id: link.sessionId, userId: 'user-1', status: 'RECORDING' },
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
    for (const broadcaster of broadcasters) broadcaster.disconnect();
    broadcasters.length = 0;

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

  function rawSocketOf(broadcaster: LiveBroadcaster): Socket {
    return (broadcaster as unknown as { socket: Socket }).socket;
  }

  /** 每次用新 socket join，模拟真实重连；同一 socket 的重复 join 按 SEC-003 必须 no-op。 */
  async function joinUntil<T extends { segments: unknown[] }>(
    shareToken: string,
    predicate: (state: T) => boolean
  ): Promise<T> {
    let state = { segments: [] } as unknown as T;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const viewer = createClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
      });
      clients.push(viewer);
      await onceSocketEvent(viewer, 'connect');
      const statePromise = onceSocketEvent<T>(viewer, 'initial_state');
      viewer.emit('join', { shareToken });
      state = await statePromise;
      if (predicate(state)) break;
      viewer.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return state;
  }

  it('P7-3(a)：鉴权窗口内到达的首帧 sync_snapshot 不被丢弃', async () => {
    // 让鉴权慢下来，稳定复现「客户端 connect 后立刻补发的快照落在 await 窗口内」。
    verifyAuthTokenMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return AUTH_SESSION;
    });

    const broadcaster = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        token: 'server-jwt',
        sessionId: 'session-1',
        shareToken: 'share-token',
      },
    });
    clients.push(broadcaster);

    // 连上之前就 emit：socket.io-client 会缓冲，并在 connect 完成的同刻立即发出，
    // 于是这一帧必然落在服务端 authenticateBroadcaster 的 await 窗口内。
    broadcaster.emit('sync_snapshot', {
      segments: [
        makeTranscriptSegment({
          id: 'seg-cold',
          text: '开分享之前录的内容',
        }),
      ],
      translations: { 'seg-cold': 'recorded before sharing' },
      summaryBlocks: [],
      status: 'RECORDING',
    });

    // 等鉴权走完（主播自己的 initial_state 在鉴权成功后发出）
    await onceSocketEvent(broadcaster, 'initial_state');

    const state = await joinUntil<{
      segments: Array<{ id: string }>;
      translations: Record<string, string>;
    }>('share-token', (s) => s.segments.length > 0);

    expect(state.segments).toMatchObject([
      { id: 'seg-cold', text: '开分享之前录的内容' },
    ]);
    expect(state.translations).toEqual({
      'seg-cold': 'recorded before sharing',
    });
  });

  it('P7-3(b)：内存无快照时回退读 data/transcript-drafts 的直播中草稿', async () => {
    const draftDir = path.join(
      process.cwd(),
      'data',
      'transcript-drafts',
      'session-draft'
    );
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(
      path.join(draftDir, 'transcript.json'),
      JSON.stringify({
        segments: [
          makeTranscriptSegment({ id: 'seg-draft', text: '草稿里的历史' }),
        ],
        translations: { 'seg-draft': 'from draft' },
        summaries: [
          makeSummaryBlock({
            id: 'sum-draft',
            summary: 'draft summary',
          }),
        ],
        clientTs: Date.now(),
      }),
      'utf-8'
    );

    try {
      const state = await joinUntil<{
        segments: Array<{ id: string }>;
        translations: Record<string, string>;
        summaryBlocks: Array<{ id: string }>;
      }>('draft-token', (s) => s.segments.length > 0);

      expect(state.segments).toMatchObject([
        { id: 'seg-draft', text: '草稿里的历史' },
      ]);
      expect(state.translations).toEqual({ 'seg-draft': 'from draft' });
      expect(state.summaryBlocks).toMatchObject([
        { id: 'sum-draft', blockIndex: 0, summary: 'draft summary' },
      ]);
    } finally {
      await fs.rm(draftDir, { recursive: true, force: true });
    }
  });

  it('回退读的是 transcriptDraftPersistence 真正写出的 transcript-<代号>.json', async () => {
    // 写入侧每次落盘换一个代号（tmp+rename 原子发布），裸 transcript.json 只是
    // 升级前的历史文件名。冷启动恢复若硬编码后者，这次部署之后写的每一份草稿都
    // 读不到 —— 观众进来看到空白板，而单测只要自己手写 transcript.json 就永远发现不了。
    const draftDir = path.join(
      process.cwd(),
      'data',
      'transcript-drafts',
      'session-draft'
    );
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(
      path.join(draftDir, 'transcript-3f8c1d2e-9a44-4b17-8e5c-2b6d0f1a7c93.json'),
      JSON.stringify({
        segments: [
          makeTranscriptSegment({ id: 'seg-uuid', text: '代号文件里的历史' }),
        ],
        translations: { 'seg-uuid': 'from generational draft' },
        summaries: [],
        clientTs: Date.now(),
      }),
      'utf-8'
    );

    try {
      const state = await joinUntil<{
        segments: Array<{ id: string }>;
        translations: Record<string, string>;
      }>('draft-token', (s) => s.segments.length > 0);

      expect(state.segments).toMatchObject([
        { id: 'seg-uuid', text: '代号文件里的历史' },
      ]);
      expect(state.translations).toEqual({ 'seg-uuid': 'from generational draft' });
    } finally {
      await fs.rm(draftDir, { recursive: true, force: true });
    }
  });

  it('P7-4：主播重连补发的快照含开分享后累积的增量（不把服务端内存抹回旧态）', async () => {
    const broadcaster = new LiveBroadcaster(baseUrl, {
      sessionId: 'session-1',
      token: 'server-jwt',
      shareToken: 'share-token',
    });
    broadcasters.push(broadcaster);

    const raw = rawSocketOf(broadcaster);
    await onceSocketEvent(raw, 'connect');

    broadcaster.syncSnapshot({
      segments: [makeTranscriptSegment()],
      translations: { 'seg-1': '你好' },
      summaryBlocks: [],
      status: 'RECORDING',
      previewText: { finalText: '', nonFinalText: '' },
      previewTranslation: {
        finalText: '',
        nonFinalText: '',
        state: 'idle',
        sourceLanguage: null,
      },
    });

    // 开分享后新产生的内容只走增量
    broadcaster.broadcastTranscriptDelta(
      makeTranscriptSegment({
        id: 'seg-2',
        text: 'World',
        globalStartMs: 1_000,
        globalEndMs: 2_000,
        startMs: 1_000,
        endMs: 2_000,
        timestamp: '00:00:01',
      })
    );
    broadcaster.broadcastTranslationDelta('seg-2', '世界');
    broadcaster.broadcastSummaryUpdate(makeSummaryBlock());

    // 先确认服务端已吃到 seg-2（避免与下面的断连竞争）
    await joinUntil<{ segments: Array<{ id: string }> }>(
      'share-token',
      (s) => s.segments.length === 2
    );

    // 底层断连 → 自动重连 → broadcaster 补发 lastSnapshot（全量覆盖服务端内存）
    const reconnected = new Promise<void>((resolve) => {
      raw.once('connect', () => resolve());
    });
    raw.io.engine.close();
    await reconnected;

    const state = await joinUntil<{
      segments: Array<{ id: string }>;
      translations: Record<string, string>;
      summaryBlocks: Array<{ id: string }>;
      status: string | null;
    }>('share-token', (s) => s.segments.length === 2);

    // 旧实现：补发的是「开分享瞬间」的快照，只有 seg-1 —— seg-2 及其翻译/摘要被抹掉
    expect(state.segments.map((segment) => segment.id)).toEqual([
      'seg-1',
      'seg-2',
    ]);
    expect(state.translations).toEqual({ 'seg-1': '你好', 'seg-2': '世界' });
    expect(state.summaryBlocks.map((block) => block.id)).toEqual(['sum-1']);
  });
});
