import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  mkdirMock,
  unlinkMock,
  writeFileMock,
  trackJobMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  mkdirMock: vi.fn(),
  unlinkMock: vi.fn(),
  writeFileMock: vi.fn(),
  trackJobMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  unlink: unlinkMock,
  writeFile: writeFileMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  JOB_TYPE: { ADMIN_MUTATION: 'admin_mutation' },
  trackJob: trackJobMock,
}));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: writeSecurityAuditMock }));

import { POST } from '@/app/api/admin/upload-icon/route';

function request(): Request {
  const form = new FormData();
  form.set(
    'file',
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00])], 'attacker-name.png', {
      type: 'image/png',
    })
  );
  form.set('type', 'logo');
  return new Request('http://localhost/api/admin/upload-icon', {
    method: 'POST',
    body: form,
  });
}

describe('POST /api/admin/upload-icon — SEC-033 durable external mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    mkdirMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    writeSecurityAuditMock.mockResolvedValue({});
    trackJobMock.mockImplementation(async (options, operation) => {
      const result = await operation();
      await options.terminalMutation(
        { auditLog: { create: vi.fn() }, jobQueue: { update: vi.fn() } },
        { status: 'SUCCESS', result }
      );
      return result;
    });
  });

  it('journals before filesystem writes and commits the final audit with terminal state', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_mutation',
        params: expect.objectContaining({
          operation: 'upload_icon',
          iconType: 'logo',
          mimeType: 'image/png',
        }),
      }),
      expect.any(Function)
    );
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'icon.upload',
        outcome: 'SUCCESS',
        target: { type: 'site_icon', id: 'logo' },
      }),
      expect.objectContaining({ jobQueue: expect.any(Object) })
    );
    expect(JSON.stringify(writeSecurityAuditMock.mock.calls[0][1])).not.toContain(
      'attacker-name.png'
    );
  });

  it('does not report success when terminal audit persistence fails', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });
});
