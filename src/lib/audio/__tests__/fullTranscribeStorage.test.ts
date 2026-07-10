import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C2/C3：完整版补全转录接入 sessionPersistence 的 'full-transcripts' category 后的存储往返。
 * 用内存 fs 桩 + 可切换的 Cloudreve 桩，覆盖：
 *  - 本地 persist → load 往返；
 *  - 阶段B 落的老 `local:` 引用仍可读；
 *  - fullTranscriptPath 为 null 时按 sessionId 约定候选回退读；
 *  - Cloudreve 已配置：persist 上传远程 + load 走远程下载；
 *  - deleteSessionArtifacts 清理完整版产物（本地物理删 + Cloudreve 远程删），删会话不留孤儿。
 */

// vi.mock 工厂被提升到文件顶部，其引用的变量必须走 vi.hoisted。
const { store, cloudreveState, uploadMock, downloadMock, cloudreveDeleteCtx, deleteCloudreveFileMock } =
  vi.hoisted(() => ({
    store: new Map<string, Buffer>(),
    cloudreveState: { configured: false },
    uploadMock: vi.fn(),
    downloadMock: vi.fn(),
    cloudreveDeleteCtx: { value: null as unknown },
    deleteCloudreveFileMock: vi.fn(async () => undefined),
  }));

// ── 内存 fs 桩 ──
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: string, data: Buffer | string) => {
      store.set(String(p), Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
    }),
    readFile: vi.fn(async (p: string) => {
      const b = store.get(String(p));
      if (!b) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return b;
    }),
    access: vi.fn(async (p: string) => {
      if (!store.has(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    rm: vi.fn(async (p: string) => {
      store.delete(String(p));
    }),
    unlink: vi.fn(async (p: string) => {
      store.delete(String(p));
    }),
  },
}));

// ── 可切换的 Cloudreve 桩 ──
vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: {
    create: vi.fn(async () => {
      if (!cloudreveState.configured) throw new Error('Cloudreve is not configured');
      return { upload: uploadMock, downloadByRemotePath: downloadMock };
    }),
  },
}));

vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: vi.fn(async () => cloudreveDeleteCtx.value),
  deleteCloudreveFile: deleteCloudreveFileMock,
}));

import {
  persistArtifact,
  readArtifactFromReference,
  deleteSessionArtifacts,
} from '@/lib/sessionPersistence';

const session = { id: 's1', userId: 'user-1' };

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  cloudreveState.configured = false;
  cloudreveDeleteCtx.value = null;
});

describe('full-transcripts 存储往返（本地）', () => {
  it('persist 本地 → 返回 local: 引用；load 读回同一 bundle', async () => {
    const json = JSON.stringify({
      segments: [{ id: 'a' }],
      summaries: [],
      translations: { a: 'x' },
    });
    const result = await persistArtifact(session, 'full-transcripts', json);
    expect(result.storage).toBe('local');
    expect(result.path).toBe('local:full-transcripts/s1.json');

    const buf = await readArtifactFromReference(session, 'full-transcripts', result.path);
    expect(buf).not.toBeNull();
    expect(JSON.parse(buf!.toString('utf-8'))).toEqual({
      segments: [{ id: 'a' }],
      summaries: [],
      translations: { a: 'x' },
    });
  });

  it('阶段B 落的老 local: 引用仍可读', async () => {
    // 预置一份阶段B 格式落盘的文件，用老引用格式读回
    await persistArtifact({ id: 'old', userId: 'user-1' }, 'full-transcripts', '{"segments":[{"id":"o"}]}');
    const buf = await readArtifactFromReference(
      { id: 'old', userId: 'user-1' },
      'full-transcripts',
      'local:full-transcripts/old.json'
    );
    expect(JSON.parse(buf!.toString('utf-8')).segments[0].id).toBe('o');
  });

  it('fullTranscriptPath 为 null：按 sessionId 约定候选回退读本地', async () => {
    await persistArtifact({ id: 'nb', userId: 'user-1' }, 'full-transcripts', '{"segments":[]}');
    const buf = await readArtifactFromReference({ id: 'nb', userId: 'user-1' }, 'full-transcripts', null);
    expect(buf).not.toBeNull();
  });

  it('引用与文件都不存在：load 返回 null', async () => {
    const buf = await readArtifactFromReference({ id: 'ghost', userId: 'user-1' }, 'full-transcripts', null);
    expect(buf).toBeNull();
  });
});

describe('full-transcripts 存储往返（Cloudreve）', () => {
  it('Cloudreve 已配置：persist 上传远程并返回远程路径；load 走远程下载', async () => {
    cloudreveState.configured = true;
    uploadMock.mockResolvedValue('/user-1/full-transcripts/s1.json');
    const json = '{"segments":[{"id":"c"}],"summaries":[],"translations":{}}';

    const result = await persistArtifact(session, 'full-transcripts', json);
    expect(result.storage).toBe('cloudreve');
    expect(result.path).toBe('/user-1/full-transcripts/s1.json');
    expect(uploadMock).toHaveBeenCalledWith('user-1', 'full-transcripts', 's1.json', json);

    downloadMock.mockResolvedValue(Buffer.from(json));
    const buf = await readArtifactFromReference(session, 'full-transcripts', result.path);
    expect(downloadMock).toHaveBeenCalledWith('/user-1/full-transcripts/s1.json', 'user-1');
    expect(JSON.parse(buf!.toString('utf-8')).segments[0].id).toBe('c');
  });
});

describe('deleteSessionArtifacts 清理完整版转录（C3）', () => {
  it('本地完整版文件随会话删除被清掉（不留孤儿）', async () => {
    await persistArtifact(session, 'full-transcripts', '{"segments":[]}');
    expect(store.size).toBe(1);

    await deleteSessionArtifacts({
      id: 's1',
      userId: 'user-1',
      recordingPath: null,
      transcriptPath: null,
      summaryPath: null,
      reportPath: null,
      fullTranscriptPath: 'local:full-transcripts/s1.json',
    });
    expect(store.size).toBe(0);
  });

  it('Cloudreve 远程完整版随会话删除触发远程删除', async () => {
    cloudreveDeleteCtx.value = { token: 'ctx' };
    await deleteSessionArtifacts({
      id: 's1',
      userId: 'user-1',
      recordingPath: null,
      transcriptPath: null,
      summaryPath: null,
      reportPath: null,
      fullTranscriptPath: '/user-1/full-transcripts/s1.json',
    });
    expect(deleteCloudreveFileMock).toHaveBeenCalledWith(
      '/user-1/full-transcripts/s1.json',
      { token: 'ctx' }
    );
  });
});
