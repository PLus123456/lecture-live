// 跨批次集成回归：观众 join 已收尾会话时，服务端的 initial_state 必须真的带上转录。
//
// 事故：liveShare/server.ts 原来按**约定**拼 `data/transcripts/{id}.json` 去读收尾产物，
// 而产物落盘早已改成版本化文件名（sessionPersistence 的 buildVersionedArtifactFileName →
// `{id}-{stamp}.json`）：先是 api/sessions/[id]/transcript 走 staged 写入，随后 M5 把
// finalize 主链路也切了过去。于是这条 readFile 对所有新收尾的会话必然 ENOENT，静默掉进
// catch → 回退读草稿 → 草稿在收尾时已被删 → 观众拿到**空快照**。全链路无日志。
//
// 修法：以 DB 的 Session.transcriptPath 为准（loadSessionTranscriptBundle），
// 并保留 C16 的草稿回退。本文件同时钉住这两条与 L3 的 clamp。

import { createServer } from 'http';
import { AddressInfo } from 'net';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, Socket } from 'socket.io-client';
import { onceSocketEvent } from '../../../../tests/utils/socket';

const { shareLinkFindUniqueMock, sessionFindUniqueMock, verifyAuthTokenMock } =
  vi.hoisted(() => ({
    shareLinkFindUniqueMock: vi.fn(),
    sessionFindUniqueMock: vi.fn(),
    verifyAuthTokenMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    shareLink: {
      findUnique: shareLinkFindUniqueMock,
      findMany: vi.fn(async () => []),
    },
    session: {
      findUnique: sessionFindUniqueMock,
    },
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

const SESSION_ID = 'liveshare-finalized-test';
const USER_ID = 'user-1';
// 版本化文件名：M5 之后 finalize 落盘就是这个形态，不再是 `${SESSION_ID}.json`
const VERSIONED_FILE = `${SESSION_ID}-20260822T010203000Z-a1b2c3.json`;
const TRANSCRIPT_DIR = path.join(process.cwd(), 'data', 'transcripts');
const DRAFT_DIR = path.join(
  process.cwd(),
  'data',
  'transcript-drafts',
  SESSION_ID
);

describe('已收尾会话的 initial_state 回填（跨批次集成回归）', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketIOServer;
  let baseUrl: string;
  let teardownLiveShare: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    verifyAuthTokenMock.mockResolvedValue({
      user: { id: USER_ID, email: 'alice@example.com', role: 'ADMIN' },
      token: { jti: 'jti-1', tokenVersion: 1 },
      rawToken: 'server-jwt',
    });
    shareLinkFindUniqueMock.mockImplementation(
      async ({ where: { token } }: { where: { token: string } }) => {
        if (token !== 'share-token') return null;
        return {
          id: 'link-1',
          token,
          sessionId: SESSION_ID,
          createdBy: USER_ID,
          isLive: true,
          expiresAt: null,
          session: { id: SESSION_ID, userId: USER_ID, status: 'COMPLETED' },
        };
      }
    );
    sessionFindUniqueMock.mockResolvedValue(null);

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

    await fs.rm(path.join(TRANSCRIPT_DIR, VERSIONED_FILE), { force: true });
    await fs.rm(path.join(TRANSCRIPT_DIR, `${SESSION_ID}.json`), { force: true });
    await fs.rm(DRAFT_DIR, { recursive: true, force: true });
  });

  async function writeVersionedTranscript(bundle: unknown) {
    await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(TRANSCRIPT_DIR, VERSIONED_FILE),
      JSON.stringify(bundle),
      'utf-8'
    );
  }

  async function joinAsViewer() {
    const viewer = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(viewer);
    await onceSocketEvent(viewer, 'connect');
    const statePromise = onceSocketEvent<{
      segments: Array<{ id: string; text: string }>;
      translations: Record<string, string>;
      summaryBlocks: unknown[];
    }>(viewer, 'initial_state');
    viewer.emit('join', { shareToken: 'share-token' });
    return statePromise;
  }

  it('DB 有版本化 transcriptPath 时能读到内容（约定式 {id}.json 并不存在）', async () => {
    await writeVersionedTranscript({
      segments: [
        { id: 'seg-1', text: '收尾之后的转录第一段' },
        { id: 'seg-2', text: '第二段' },
      ],
      translations: { 'seg-1': 'first finalized segment' },
      summaries: [{ id: 'sum-1', blockIndex: 0, summary: '摘要' }],
    });
    // 约定式路径确实不存在——这正是回归的根源
    await expect(
      fs.access(path.join(TRANSCRIPT_DIR, `${SESSION_ID}.json`))
    ).rejects.toBeTruthy();

    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      recordingPath: null,
      transcriptPath: `local:transcripts/${VERSIONED_FILE}`,
      summaryPath: null,
    });

    const state = await joinAsViewer();

    expect(state.segments.map((segment) => segment.id)).toEqual([
      'seg-1',
      'seg-2',
    ]);
    expect(state.translations).toEqual({ 'seg-1': 'first finalized segment' });
    expect(state.summaryBlocks).toHaveLength(1);
  });

  it('DB 无 transcriptPath 时仍回退直播草稿（保住 C16 的冷开分享）', async () => {
    await fs.mkdir(DRAFT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DRAFT_DIR, 'transcript.json'),
      JSON.stringify({
        segments: [{ id: 'draft-1', text: '直播进行中的草稿' }],
        translations: { 'draft-1': 'live draft' },
        summaries: [],
        updatedAt: Date.now(),
      }),
      'utf-8'
    );

    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      recordingPath: null,
      transcriptPath: null,
      summaryPath: null,
    });

    const state = await joinAsViewer();
    expect(state.segments.map((segment) => segment.id)).toEqual(['draft-1']);
  });

  it('L3：产物路径同样要过 clamp（单条超长文本被截断，不原样推给观众）', async () => {
    await writeVersionedTranscript({
      segments: [{ id: 'seg-huge', text: 'x'.repeat(50_000) }],
      translations: {},
      summaries: [],
    });
    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      recordingPath: null,
      transcriptPath: `local:transcripts/${VERSIONED_FILE}`,
      summaryPath: null,
    });

    const state = await joinAsViewer();
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0].text.length).toBe(10_000);
  });
});
