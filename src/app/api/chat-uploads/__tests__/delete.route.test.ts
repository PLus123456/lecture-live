import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  releaseStorageBytesMock,
  chatAttachmentFindUniqueMock,
  chatAttachmentDeleteMock,
  siteSettingFindUniqueMock,
  resolveCloudreveConfigMock,
  decryptMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  chatAttachmentFindUniqueMock: vi.fn(),
  chatAttachmentDeleteMock: vi.fn(),
  siteSettingFindUniqueMock: vi.fn(),
  resolveCloudreveConfigMock: vi.fn(),
  decryptMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/quota', () => ({
  releaseStorageBytes: releaseStorageBytesMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findUnique: chatAttachmentFindUniqueMock,
      delete: chatAttachmentDeleteMock,
    },
    siteSetting: {
      findUnique: siteSettingFindUniqueMock,
    },
  },
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  resolveCloudreveConfig: resolveCloudreveConfigMock,
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: decryptMock,
}));

vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    serializeError: (err: unknown) =>
      err instanceof Error ? { message: err.message } : { message: String(err) },
  };
});

import { DELETE } from '@/app/api/chat-uploads/[id]/route';

describe('DELETE /api/chat-uploads/[id]', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'PRO',
    });
    chatAttachmentFindUniqueMock.mockResolvedValue({
      id: 'att-1',
      userId: 'user-1',
      bytes: BigInt(1024),
      cloudrevePath: '/user-1/chat-uploads/conv-1_foo.pdf',
      extractedTextPath: '/user-1/chat-uploads/conv-1_foo.pdf.extracted.txt',
    });
    chatAttachmentDeleteMock.mockResolvedValue(undefined);
    releaseStorageBytesMock.mockResolvedValue(null);
    // 默认 Cloudreve 已配置且有 access_token，物理删除会被调
    resolveCloudreveConfigMock.mockResolvedValue({
      baseUrl: 'https://cloudreve.example.com',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    siteSettingFindUniqueMock.mockResolvedValue({
      key: 'cloudreve_access_token',
      value: 'enc:foo',
    });
    decryptMock.mockReturnValue('mock-access-token');
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeReq() {
    return new Request('http://localhost:3000/api/chat-uploads/att-1', {
      method: 'DELETE',
    });
  }

  function makeParams(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  it('owner 删除 → 200, 物理 + DB + 释放配额都触发', async () => {
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });

    // 物理删除：原文件 + 抽出 .txt 各调一次 Cloudreve DELETE
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloudreve.example.com/api/v4/file',
      expect.objectContaining({ method: 'DELETE' })
    );

    expect(chatAttachmentDeleteMock).toHaveBeenCalledWith({
      where: { id: 'att-1' },
    });
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 1024);
  });

  it('非 owner 且非 ADMIN → 403', async () => {
    verifyAuthMock.mockResolvedValueOnce({
      id: 'user-2',
      email: 'bob@example.com',
      role: 'PRO',
    });
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(403);
    expect(chatAttachmentDeleteMock).not.toHaveBeenCalled();
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('ADMIN 可跨用户删，释放原 owner 的配额', async () => {
    verifyAuthMock.mockResolvedValueOnce({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(200);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 1024);
  });

  it('attachment 不存在 → 404', async () => {
    chatAttachmentFindUniqueMock.mockResolvedValueOnce(null);
    const response = await DELETE(makeReq(), makeParams('nope'));
    expect(response.status).toBe(404);
    expect(chatAttachmentDeleteMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(401);
  });

  it('Cloudreve 未配置时仍删 DB 行并释放配额', async () => {
    resolveCloudreveConfigMock.mockResolvedValueOnce(null);
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chatAttachmentDeleteMock).toHaveBeenCalled();
    expect(releaseStorageBytesMock).toHaveBeenCalled();
  });

  it('Cloudreve DELETE 非 2xx 仍继续删 DB 行', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }));
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(200);
    expect(chatAttachmentDeleteMock).toHaveBeenCalled();
  });

  it('extractedTextPath = null 时只调一次 Cloudreve DELETE', async () => {
    chatAttachmentFindUniqueMock.mockResolvedValueOnce({
      id: 'att-2',
      userId: 'user-1',
      bytes: BigInt(512),
      cloudrevePath: '/user-1/chat-uploads/conv-1_pic.png',
      extractedTextPath: null,
    });
    const response = await DELETE(makeReq(), makeParams('att-2'));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('DB delete 失败 → 500', async () => {
    chatAttachmentDeleteMock.mockRejectedValueOnce(new Error('db fail'));
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(500);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });
});
