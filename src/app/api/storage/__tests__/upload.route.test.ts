import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMultipartRequest,
  readJson,
} from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  reserveStorageBytesMock,
  releaseStorageBytesMock,
  sessionFindUniqueMock,
  enforceApiRateLimitMock,
  getSiteSettingsMock,
  uploadMock,
  createCloudreveStorageMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  reserveStorageBytesMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  uploadMock: vi.fn(),
  createCloudreveStorageMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/quota', () => ({
  reserveStorageBytes: reserveStorageBytesMock,
  releaseStorageBytes: releaseStorageBytesMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
    },
  },
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceApiRateLimit: enforceApiRateLimitMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: {
    create: createCloudreveStorageMock,
  },
}));

import { POST } from '@/app/api/storage/upload/route';

describe('POST /api/storage/upload', () => {
  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'ADMIN',
    });
    reserveStorageBytesMock.mockResolvedValue(true);
    releaseStorageBytesMock.mockResolvedValue(null);
    enforceApiRateLimitMock.mockResolvedValue(null);
    getSiteSettingsMock.mockResolvedValue({ max_file_size: 10 });
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
    });
    createCloudreveStorageMock.mockResolvedValue({
      upload: uploadMock,
    });
    uploadMock.mockResolvedValue('/user-1/transcripts/notes.txt');
  });

  it('校验表单并上传文件到 Cloudreve', async () => {
    const response = await POST(
      createMultipartRequest(
        'http://localhost:3000/api/storage/upload',
        {
          category: 'transcripts',
          fileName: 'lecture notes.txt',
          sessionId: 'session-1',
        },
        {
          fieldName: 'file',
          fileName: 'lecture notes.txt',
          contents: 'hello world',
          type: 'text/plain',
        }
      )
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      path: '/user-1/transcripts/notes.txt',
    });
    expect(createCloudreveStorageMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledWith(
      'user-1',
      'transcripts',
      'lecture_notes.txt',
      expect.anything()
    );
    const uploadedBuffer = uploadMock.mock.calls[0]?.[3] as Buffer;
    expect(Buffer.from(uploadedBuffer).toString('utf8')).toBe('hello world');
    // C9：按 file.size 原子预留字节额度；上传成功不回滚
    expect(reserveStorageBytesMock).toHaveBeenCalledWith('user-1', 11);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('上传失败时回滚已预留的字节额度', async () => {
    uploadMock.mockRejectedValue(new Error('cloudreve down'));

    const response = await POST(
      createMultipartRequest(
        'http://localhost:3000/api/storage/upload',
        {
          category: 'transcripts',
          fileName: 'notes.txt',
          sessionId: 'session-1',
        },
        {
          fieldName: 'file',
          fileName: 'notes.txt',
          contents: 'hello world',
          type: 'text/plain',
        }
      )
    );

    expect(response.status).toBe(500);
    // C9：预留成功但上传失败 → 必须 releaseStorageBytes 回滚，避免额度泄漏
    expect(reserveStorageBytesMock).toHaveBeenCalledWith('user-1', 11);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 11);
  });

  it('在配额不足时返回 403', async () => {
    reserveStorageBytesMock.mockResolvedValue(false);

    const response = await POST(
      createMultipartRequest(
        'http://localhost:3000/api/storage/upload',
        {
          category: 'recordings',
          fileName: 'recording.webm',
          sessionId: 'session-1',
        },
        {
          fieldName: 'file',
          fileName: 'recording.webm',
          contents: new Uint8Array([1, 2, 3]),
          type: 'audio/webm',
        }
      )
    );

    expect(response.status).toBe(403);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Storage quota exceeded',
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('拒绝非法存储分类', async () => {
    const response = await POST(
      createMultipartRequest(
        'http://localhost:3000/api/storage/upload',
        {
          category: 'invalid-category',
          fileName: 'notes.txt',
          sessionId: 'session-1',
        },
        {
          fieldName: 'file',
          fileName: 'notes.txt',
          contents: 'hello',
          type: 'text/plain',
        }
      )
    );

    expect(response.status).toBe(400);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Invalid storage category',
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
