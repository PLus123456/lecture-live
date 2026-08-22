import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P6-6（旧 Y8）：storage/migration.ts 的两处裸 path.join 都能被 DB 里的 path 列穿越。
 *
 * - `resolveLocalPath('local:../../etc/passwd')` → 迁移会把任意文件整个读出来传上 Cloudreve；
 * - `cleanupExpiredLocalFiles` 的 `path.join(DATA_ROOT, category, fileName)`，fileName 是
 *   remote path 的第三段，可以是 `..` → unlink 的目标跳出 data/<category>/。
 *
 * `src/lib/storage/` 此前零测试文件，这是第一份。
 */

const {
  sessionFindManyMock,
  sessionUpdateMock,
  uploadMock,
  isConfiguredMock,
  openDownloadStreamMock,
  createStorageMock,
} = vi.hoisted(() => ({
  sessionFindManyMock: vi.fn(),
  sessionUpdateMock: vi.fn(),
  uploadMock: vi.fn(),
  isConfiguredMock: vi.fn(),
  openDownloadStreamMock: vi.fn(),
  // CloudreveStorage 在被测代码里只用到静态 create（类型位置的用法是编译期的），
  // 替身给个带 create 的对象即可。
  createStorageMock: { create: vi.fn() },
}));

const { accessMock, readFileMock, unlinkMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  readFileMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findMany: sessionFindManyMock,
      update: sessionUpdateMock,
    },
  },
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  isCloudreveConfiguredAsync: isConfiguredMock,
  CloudreveStorage: createStorageMock,
}));

vi.mock('fs/promises', () => {
  const api = {
    access: accessMock,
    readFile: readFileMock,
    unlink: unlinkMock,
  };
  return { ...api, default: api };
});

import {
  cleanupExpiredLocalFiles,
  migrateLocalToCloudreve,
} from '@/lib/storage/migration';

/** 远端「可读」的最小响应：206 + 1 字节，body 会被被测代码 cancel 掉。 */
function makeRangeResponse(): Response {
  return new Response(new Uint8Array([0]), {
    status: 206,
    headers: { 'content-range': 'bytes 0-0/1024' },
  });
}

const DATA_ROOT = path.join(process.cwd(), 'data');

const EMPTY_PATHS = {
  recordingPath: null,
  transcriptPath: null,
  summaryPath: null,
  reportPath: null,
  fullTranscriptPath: null,
};

describe('migrateLocalToCloudreve —— local: 引用不得跳出 data/', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isConfiguredMock.mockResolvedValue(true);
    createStorageMock.create.mockResolvedValue({
      upload: uploadMock,
      openDownloadStream: openDownloadStreamMock,
    });
    // 所有被问到的文件都"存在"，把是否读取完全交给路径校验决定
    accessMock.mockResolvedValue(undefined);
    readFileMock.mockResolvedValue(Buffer.from('payload'));
    uploadMock.mockResolvedValue('/user-1/recordings/a.webm');
    sessionUpdateMock.mockResolvedValue({});
  });

  it('正常的 local: 引用照常迁移', async () => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        userId: 'user-1',
        ...EMPTY_PATHS,
        recordingPath: 'local:recordings/a.webm',
      },
    ]);

    const result = await migrateLocalToCloudreve();

    expect(readFileMock).toHaveBeenCalledWith(
      path.join(DATA_ROOT, 'recordings/a.webm')
    );
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(result.migratedCount).toBe(1);
  });

  it.each([
    'local:../../etc/passwd',
    'local:../.env',
    'local:recordings/../../../etc/shadow',
  ])('拒绝穿越引用 %s：不读文件、不上传、不改库', async (reference) => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        userId: 'user-1',
        ...EMPTY_PATHS,
        recordingPath: reference,
      },
    ]);

    const result = await migrateLocalToCloudreve();

    expect(readFileMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(sessionUpdateMock).not.toHaveBeenCalled();
    expect(result.migratedCount).toBe(0);
  });
});

describe('cleanupExpiredLocalFiles —— unlink 目标不得跳出 data/<category>/', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    isConfiguredMock.mockResolvedValue(true);
    createStorageMock.create.mockResolvedValue({
      upload: uploadMock,
      openDownloadStream: openDownloadStreamMock,
    });
    // 默认远端副本可读（206 + 1 字节）
    openDownloadStreamMock.mockResolvedValue(makeRangeResponse());
  });

  it('正常的 Cloudreve 引用照常清理对应本地文件', async () => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        ...EMPTY_PATHS,
        recordingPath: '/user-1/recordings/a.webm',
      },
    ]);

    const result = await cleanupExpiredLocalFiles(7);

    expect(unlinkMock).toHaveBeenCalledWith(
      path.join(DATA_ROOT, 'recordings', 'a.webm')
    );
    expect(result.deletedCount).toBe(1);
  });

  it('文件名段是 `..` 时不 unlink（否则目标是 data/ 目录本身）', async () => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        ...EMPTY_PATHS,
        recordingPath: '/user-1/recordings/..',
      },
    ]);

    const result = await cleanupExpiredLocalFiles(7);

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(1);
  });

  it('retentionDays<=0 表示永久保留，直接返回', async () => {
    const result = await cleanupExpiredLocalFiles(0);
    expect(sessionFindManyMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0, errorCount: 0, errors: [] });
  });
});

/**
 * L63（不可逆数据丢失）：清理本地过期文件此前仅凭「DB 引用以 / 开头」就断定云端有副本，
 * 随即 unlink 本地最后一份。引用只说明**当初**上传成功过 —— 云端侧的删除不会回写 DB，
 * 一次定时任务就把用户的录音彻底抹掉。unlink 前必须实际校验远端可读。
 */
describe('cleanupExpiredLocalFiles —— L63：unlink 前必须校验远端副本可读', () => {
  const ONE_CLOUD_SESSION = [
    {
      id: 's1',
      ...EMPTY_PATHS,
      recordingPath: '/user-1/recordings/a.webm',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    isConfiguredMock.mockResolvedValue(true);
    createStorageMock.create.mockResolvedValue({
      upload: uploadMock,
      openDownloadStream: openDownloadStreamMock,
    });
    openDownloadStreamMock.mockResolvedValue(makeRangeResponse());
    sessionFindManyMock.mockResolvedValue(ONE_CLOUD_SESSION);
  });

  it('远端可读 → 才 unlink；校验只取 1 字节（Range: bytes=0-0）', async () => {
    const result = await cleanupExpiredLocalFiles(7);

    expect(openDownloadStreamMock).toHaveBeenCalledWith('/user-1/recordings/a.webm', {
      range: 'bytes=0-0',
    });
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('远端文件已不存在（openDownloadStream 抛错）→ 不 unlink，保留本地最后一份', async () => {
    openDownloadStreamMock.mockRejectedValue(
      new Error('Cloudreve 文件下载失败 (404)')
    );

    const result = await cleanupExpiredLocalFiles(7);

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toContain('/user-1/recordings/a.webm');
  });

  it('远端签名接口报错 / 网络不通 → 同样保留本地文件（fail-safe，不是 fail-open）', async () => {
    openDownloadStreamMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const result = await cleanupExpiredLocalFiles(7);

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
  });

  it('Cloudreve 未配置 → 一个本地文件都不删（没法校验就不能删）', async () => {
    isConfiguredMock.mockResolvedValue(false);

    const result = await cleanupExpiredLocalFiles(7);

    expect(sessionFindManyMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(1);
  });

  it('CloudreveStorage.create 抛错 → 同样整批跳过，不删本地', async () => {
    createStorageMock.create.mockRejectedValue(new Error('no token'));

    const result = await cleanupExpiredLocalFiles(7);

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(1);
  });

  it('多个文件：可读的删、不可读的留（逐个判定，不是一刀切）', async () => {
    sessionFindManyMock.mockResolvedValue([
      {
        id: 's1',
        ...EMPTY_PATHS,
        recordingPath: '/user-1/recordings/ok.webm',
        transcriptPath: '/user-1/transcripts/gone.json',
      },
    ]);
    openDownloadStreamMock.mockImplementation(async (remotePath: string) => {
      if (remotePath.includes('gone')) throw new Error('404');
      return makeRangeResponse();
    });

    const result = await cleanupExpiredLocalFiles(7);

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith(
      path.join(DATA_ROOT, 'recordings', 'ok.webm')
    );
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(1);
  });
});
