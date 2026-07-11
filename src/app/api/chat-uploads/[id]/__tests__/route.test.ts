import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M5 回归：DELETE /api/chat-uploads/[id] 必须拒绝删除「已关闭（endedAt 非空）对话」的附件，
 * 否则会真实删 Cloudreve 文件 + DB 行，破坏只读语义（UI 也已隐藏入口，这里是服务端兜底）。
 */

const {
  verifyAuthMock,
  attachmentFindUniqueMock,
  attachmentDeleteMock,
  releaseStorageBytesMock,
  loadCloudreveContextMock,
  deleteCloudreveFileMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  attachmentFindUniqueMock: vi.fn(),
  attachmentDeleteMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  loadCloudreveContextMock: vi.fn(),
  deleteCloudreveFileMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatAttachment: {
      findUnique: attachmentFindUniqueMock,
      delete: attachmentDeleteMock,
    },
  },
}));
vi.mock('@/lib/quota', () => ({ releaseStorageBytes: releaseStorageBytesMock }));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: loadCloudreveContextMock,
  deleteCloudreveFile: deleteCloudreveFileMock,
}));

import { DELETE } from '@/app/api/chat-uploads/[id]/route';

function del(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/chat-uploads/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  ];
}

const OPEN_ATTACHMENT = {
  id: 'att-1',
  userId: 'user-1',
  bytes: BigInt(42),
  cloudrevePath: '/u/att-1',
  extractedTextPath: null,
  conversation: { endedAt: null },
};

describe('DELETE /api/chat-uploads/[id] — 只读对话守卫（M5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    attachmentDeleteMock.mockResolvedValue({});
    releaseStorageBytesMock.mockResolvedValue(undefined);
    loadCloudreveContextMock.mockResolvedValue(null);
  });

  it('对话已关闭（endedAt 非空）→ 409，且不删文件/DB 行', async () => {
    attachmentFindUniqueMock.mockResolvedValue({
      ...OPEN_ATTACHMENT,
      conversation: { endedAt: new Date() },
    });

    const res = await DELETE(...del('att-1'));
    expect(res.status).toBe(409);
    expect(attachmentDeleteMock).not.toHaveBeenCalled();
    expect(deleteCloudreveFileMock).not.toHaveBeenCalled();
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('对话未关闭 + 本人拥有 → 正常删除', async () => {
    attachmentFindUniqueMock.mockResolvedValue(OPEN_ATTACHMENT);

    const res = await DELETE(...del('att-1'));
    expect(res.status).toBe(200);
    expect(attachmentDeleteMock).toHaveBeenCalledWith({ where: { id: 'att-1' } });
  });

  it('非本人且非 ADMIN → 403（不受 endedAt 影响的既有校验）', async () => {
    attachmentFindUniqueMock.mockResolvedValue({
      ...OPEN_ATTACHMENT,
      userId: 'someone-else',
    });

    const res = await DELETE(...del('att-1'));
    expect(res.status).toBe(403);
    expect(attachmentDeleteMock).not.toHaveBeenCalled();
  });
});
