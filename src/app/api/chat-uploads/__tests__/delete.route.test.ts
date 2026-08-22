import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  releaseStorageBytesMock,
  chatAttachmentFindUniqueMock,
  chatAttachmentDeleteManyMock,
  siteSettingFindUniqueMock,
  resolveCloudreveConfigMock,
  decryptMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  chatAttachmentFindUniqueMock: vi.fn(),
  chatAttachmentDeleteManyMock: vi.fn(),
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
      deleteMany: chatAttachmentDeleteManyMock,
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
    chatAttachmentDeleteManyMock.mockResolvedValue({ count: 1 });
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

    expect(chatAttachmentDeleteManyMock).toHaveBeenCalledWith({
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
    expect(chatAttachmentDeleteManyMock).not.toHaveBeenCalled();
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
    expect(chatAttachmentDeleteManyMock).not.toHaveBeenCalled();
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
    expect(chatAttachmentDeleteManyMock).toHaveBeenCalled();
    expect(releaseStorageBytesMock).toHaveBeenCalled();
  });

  it('Cloudreve DELETE 非 2xx 仍继续删 DB 行', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }));
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(200);
    expect(chatAttachmentDeleteManyMock).toHaveBeenCalled();
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
    chatAttachmentDeleteManyMock.mockRejectedValueOnce(new Error('db fail'));
    const response = await DELETE(makeReq(), makeParams('att-1'));
    expect(response.status).toBe(500);
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  /**
   * L62：两个并发 DELETE 打同一个 id。双方都能通过 findUnique（读到同一行），
   * 都会走到删除这一步；只有一方真的删掉了行。
   *
   * 旧实现用 prisma.delete —— 输的那一方吃 P2025 被当作 DB 故障回 500，
   * 前端 removeAttachment 于是回滚 chip 并 toast「操作失败」，而文件其实早已删干净。
   * 现在用 deleteMany 的 count 做权威口径：count===0 → 幂等 200，且**绝不退配额**
   * （退了就是与赢家叠加的重复退款，撞上 B8/P5-13 那条不变量）。
   */
  it('L62：并发 DELETE 的输家（count=0）→ 200 幂等，且不重复释放配额', async () => {
    chatAttachmentDeleteManyMock.mockResolvedValueOnce({ count: 0 });

    const response = await DELETE(makeReq(), makeParams('att-1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, alreadyDeleted: true });
    // 关键：字节只能被赢家退一次。
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('L62：赢家（count=1）照常释放配额一次', async () => {
    chatAttachmentDeleteManyMock.mockResolvedValueOnce({ count: 1 });

    const response = await DELETE(makeReq(), makeParams('att-1'));

    expect(response.status).toBe(200);
    expect(releaseStorageBytesMock).toHaveBeenCalledTimes(1);
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('user-1', 1024);
  });
});
