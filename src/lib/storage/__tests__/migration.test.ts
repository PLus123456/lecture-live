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

const { sessionFindManyMock, sessionUpdateMock, uploadMock, isConfiguredMock } =
  vi.hoisted(() => ({
    sessionFindManyMock: vi.fn(),
    sessionUpdateMock: vi.fn(),
    uploadMock: vi.fn(),
    isConfiguredMock: vi.fn(),
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
  CloudreveStorage: {
    create: vi.fn(async () => ({ upload: uploadMock })),
  },
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
