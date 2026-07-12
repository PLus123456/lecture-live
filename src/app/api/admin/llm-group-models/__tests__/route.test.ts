import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用户组 × 用途模型绑定 API（LLM 设置页「按会员组」视图的读写端点）

const {
  requireAdminAccessMock,
  siteSettingFindUniqueMock,
  siteSettingUpsertMock,
  siteSettingUpdateMock,
  routeFindUniqueMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  siteSettingFindUniqueMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  siteSettingUpdateMock: vi.fn(),
  routeFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findUnique: siteSettingFindUniqueMock,
      upsert: siteSettingUpsertMock,
      update: siteSettingUpdateMock,
    },
    llmModel: {
      findUnique: routeFindUniqueMock,
    },
  },
}));

vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));

import { GET, PUT } from '@/app/api/admin/llm-group-models/route';

function put(body: unknown): Request {
  return new Request('http://localhost/api/admin/llm-group-models', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminAccessMock.mockResolvedValue({ user: { id: 'admin-1' }, response: null });
  siteSettingFindUniqueMock.mockResolvedValue(null);
  routeFindUniqueMock.mockResolvedValue({ id: 'model-1', purpose: 'CHAT' });
});

describe('GET /api/admin/llm-group-models', () => {
  it('返回系统组（FREE/PRO）+ 自定义组的绑定；ADMIN 不出现', async () => {
    siteSettingFindUniqueMock.mockImplementation(async ({ where }) => {
      if (where.key === 'group_config_FREE') {
        return { key: where.key, value: JSON.stringify({ chatModelId: 'model-1' }) };
      }
      if (where.key === 'custom_groups') {
        return {
          key: where.key,
          value: JSON.stringify([
            {
              id: 'vip',
              name: 'VIP',
              color: 'bg-purple-50',
              permissions: { finalSummaryModelId: 'model-9' },
            },
          ]),
        };
      }
      return null;
    });

    const res = await GET(new Request('http://localhost/api/admin/llm-group-models'));
    expect(res.status).toBe(200);
    const data = await res.json();
    const keys = data.groups.map((g: { key: string }) => g.key);
    expect(keys).toEqual(['FREE', 'PRO', 'custom:vip']);
    expect(data.groups[0].chatModelId).toBe('model-1');
    expect(data.groups[2].finalSummaryModelId).toBe('model-9');
    expect(keys).not.toContain('ADMIN');
  });
});

describe('PUT /api/admin/llm-group-models', () => {
  it('系统组：读-改-写 group_config_<role> 只动绑定字段', async () => {
    siteSettingFindUniqueMock.mockResolvedValue({
      key: 'group_config_FREE',
      value: JSON.stringify({ transcriptionMinutesLimit: 60, chatModelId: '' }),
    });
    const res = await PUT(
      put({ groupKey: 'FREE', purpose: 'CHAT', modelId: 'model-1' })
    );
    expect(res.status).toBe(200);
    const written = JSON.parse(siteSettingUpsertMock.mock.calls[0][0].update.value);
    expect(written).toEqual({ transcriptionMinutesLimit: 60, chatModelId: 'model-1' });
  });

  it('自定义组：改 custom_groups 里对应条目的 permissions 字段', async () => {
    siteSettingFindUniqueMock.mockResolvedValue({
      key: 'custom_groups',
      value: JSON.stringify([
        { id: 'vip', name: 'VIP', permissions: { allowedModels: 'local' } },
      ]),
    });
    routeFindUniqueMock.mockResolvedValue({ id: 'model-2', purpose: 'REALTIME_SUMMARY' });

    const res = await PUT(
      put({ groupKey: 'custom:vip', purpose: 'REALTIME_SUMMARY', modelId: 'model-2' })
    );
    expect(res.status).toBe(200);
    const written = JSON.parse(siteSettingUpdateMock.mock.calls[0][0].data.value);
    expect(written[0].permissions).toEqual({
      allowedModels: 'local',
      realtimeSummaryModelId: 'model-2',
    });
  });

  it('modelId 空串 = 清除绑定（跟随全局默认），不校验存在性', async () => {
    siteSettingFindUniqueMock.mockResolvedValue(null);
    const res = await PUT(put({ groupKey: 'PRO', purpose: 'CHAT', modelId: '' }));
    expect(res.status).toBe(200);
    expect(routeFindUniqueMock).not.toHaveBeenCalled();
  });

  it('绑定的模型用途不匹配 → 400', async () => {
    routeFindUniqueMock.mockResolvedValue({ id: 'model-1', purpose: 'FINAL_SUMMARY' });
    const res = await PUT(
      put({ groupKey: 'FREE', purpose: 'CHAT', modelId: 'model-1' })
    );
    expect(res.status).toBe(400);
  });

  it('不可按组绑定的用途（KEYWORD_EXTRACTION）→ 400', async () => {
    const res = await PUT(
      put({ groupKey: 'FREE', purpose: 'KEYWORD_EXTRACTION', modelId: 'model-1' })
    );
    expect(res.status).toBe(400);
  });

  it('未知 groupKey → 400；不存在的自定义组 → 404', async () => {
    const bad = await PUT(put({ groupKey: 'ADMIN', purpose: 'CHAT', modelId: '' }));
    expect(bad.status).toBe(400);

    siteSettingFindUniqueMock.mockResolvedValue({
      key: 'custom_groups',
      value: JSON.stringify([]),
    });
    const missing = await PUT(
      put({ groupKey: 'custom:ghost', purpose: 'CHAT', modelId: '' })
    );
    expect(missing.status).toBe(404);
  });
});
