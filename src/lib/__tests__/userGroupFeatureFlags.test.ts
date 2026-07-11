import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用户组能力开关（可用模型 / 思考深度上限 / 实时摘要 / 总摘要）解析回归测试。
// 覆盖：思考深度 clamp、系统角色 group_config 解析、自定义组解析（缺失默认全开）、
// resolveUserFeatureFlags 的 ADMIN 恒全开 / 自定义组优先 / 缺失回落角色。

const { siteSettingFindUniqueMock } = vi.hoisted(() => ({
  siteSettingFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: { findUnique: siteSettingFindUniqueMock },
  },
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: async () => ({
    chat_files_quota_free_mb: 100,
    chat_files_quota_pro_mb: 1024,
    chat_files_quota_admin_mb: 10240,
  }),
}));

import {
  coerceThinkingDepthCap,
  clampDepthToCap,
  resolveRoleQuotas,
  resolveCustomGroupPermissions,
  resolveUserFeatureFlags,
} from '@/lib/userRoles';

/** 让 mock 按 SiteSetting key 返回预置行 */
function setSiteSettings(rows: Record<string, unknown>) {
  siteSettingFindUniqueMock.mockImplementation(
    async ({ where }: { where: { key: string } }) => {
      if (!(where.key in rows)) return null;
      return { key: where.key, value: JSON.stringify(rows[where.key]) };
    }
  );
}

beforeEach(() => {
  siteSettingFindUniqueMock.mockReset();
  siteSettingFindUniqueMock.mockResolvedValue(null);
});

describe('coerceThinkingDepthCap', () => {
  it('合法值原样返回', () => {
    for (const v of ['off', 'low', 'medium', 'high'] as const) {
      expect(coerceThinkingDepthCap(v, 'medium')).toBe(v);
    }
  });
  it('非法值回落 fallback', () => {
    expect(coerceThinkingDepthCap('ultra', 'medium')).toBe('medium');
    expect(coerceThinkingDepthCap(undefined, 'high')).toBe('high');
    expect(coerceThinkingDepthCap(3, 'low')).toBe('low');
  });
});

describe('clampDepthToCap', () => {
  it('请求不超过上限时原样返回', () => {
    expect(clampDepthToCap('low', 'high')).toBe('low');
    expect(clampDepthToCap('medium', 'medium')).toBe('medium');
  });
  it('请求超过上限时收紧到上限', () => {
    expect(clampDepthToCap('high', 'medium')).toBe('medium');
    expect(clampDepthToCap('high', 'low')).toBe('low');
    expect(clampDepthToCap('medium', 'low')).toBe('low');
  });
  it('cap=off 恒返回 off', () => {
    expect(clampDepthToCap('high', 'off')).toBe('off');
    expect(clampDepthToCap('low', 'off')).toBe('off');
  });
});

describe('resolveRoleQuotas 能力开关', () => {
  it('FREE 无配置 → 思考封顶 medium、两摘要开（保留历史行为）', async () => {
    const q = await resolveRoleQuotas('FREE');
    expect(q.maxThinkingDepth).toBe('medium');
    expect(q.allowRealtimeSummary).toBe(true);
    expect(q.allowFinalSummary).toBe(true);
  });

  it('PRO / ADMIN 无配置 → 思考 high、两摘要开', async () => {
    expect((await resolveRoleQuotas('PRO')).maxThinkingDepth).toBe('high');
    expect((await resolveRoleQuotas('ADMIN')).maxThinkingDepth).toBe('high');
  });

  it('group_config 显式收紧被采纳', async () => {
    setSiteSettings({
      group_config_FREE: {
        transcriptionMinutesLimit: 60,
        storageHoursLimit: 10,
        allowedModels: 'gpt-4o-mini',
        maxThinkingDepth: 'off',
        allowRealtimeSummary: false,
        allowFinalSummary: false,
      },
    });
    const q = await resolveRoleQuotas('FREE');
    expect(q.maxThinkingDepth).toBe('off');
    expect(q.allowRealtimeSummary).toBe(false);
    expect(q.allowFinalSummary).toBe(false);
    expect(q.allowedModels).toBe('gpt-4o-mini');
  });

  it('group_config 中非法 maxThinkingDepth 回落角色默认', async () => {
    setSiteSettings({
      group_config_PRO: { maxThinkingDepth: 'bogus' },
    });
    expect((await resolveRoleQuotas('PRO')).maxThinkingDepth).toBe('high');
  });
});

describe('resolveCustomGroupPermissions', () => {
  it('自定义组缺失能力开关字段 → 默认全开', async () => {
    setSiteSettings({
      custom_groups: [
        {
          id: 'custom_a',
          name: 'A',
          permissions: {
            transcriptionMinutesLimit: 120,
            storageHoursLimit: 20,
            allowedModels: 'gpt-4o',
          },
        },
      ],
    });
    const p = await resolveCustomGroupPermissions('custom_a');
    expect(p).not.toBeNull();
    expect(p!.maxThinkingDepth).toBe('high');
    expect(p!.allowRealtimeSummary).toBe(true);
    expect(p!.allowFinalSummary).toBe(true);
  });

  it('自定义组显式关闭被采纳', async () => {
    setSiteSettings({
      custom_groups: [
        {
          id: 'custom_b',
          name: 'B',
          permissions: {
            allowedModels: '*',
            maxThinkingDepth: 'low',
            allowRealtimeSummary: false,
            allowFinalSummary: true,
          },
        },
      ],
    });
    const p = await resolveCustomGroupPermissions('custom_b');
    expect(p!.maxThinkingDepth).toBe('low');
    expect(p!.allowRealtimeSummary).toBe(false);
    expect(p!.allowFinalSummary).toBe(true);
  });

  it('组不存在 → null', async () => {
    setSiteSettings({ custom_groups: [] });
    expect(await resolveCustomGroupPermissions('nope')).toBeNull();
  });
});

describe('resolveUserFeatureFlags', () => {
  it('ADMIN 恒全开，忽略所属自定义组的限制', async () => {
    setSiteSettings({
      custom_groups: [
        {
          id: 'custom_locked',
          permissions: {
            maxThinkingDepth: 'off',
            allowRealtimeSummary: false,
            allowFinalSummary: false,
          },
        },
      ],
    });
    const f = await resolveUserFeatureFlags({
      role: 'ADMIN',
      customGroupId: 'custom_locked',
    });
    expect(f).toEqual({
      maxThinkingDepth: 'high',
      allowRealtimeSummary: true,
      allowFinalSummary: true,
    });
  });

  it('自定义组优先于角色', async () => {
    setSiteSettings({
      custom_groups: [
        {
          id: 'custom_c',
          permissions: {
            maxThinkingDepth: 'off',
            allowRealtimeSummary: false,
            allowFinalSummary: true,
          },
        },
      ],
    });
    const f = await resolveUserFeatureFlags({
      role: 'PRO',
      customGroupId: 'custom_c',
    });
    expect(f.maxThinkingDepth).toBe('off');
    expect(f.allowRealtimeSummary).toBe(false);
    expect(f.allowFinalSummary).toBe(true);
  });

  it('自定义组不存在 → 回落底层角色（FREE 默认 medium）', async () => {
    setSiteSettings({ custom_groups: [] });
    const f = await resolveUserFeatureFlags({
      role: 'FREE',
      customGroupId: 'ghost',
    });
    expect(f.maxThinkingDepth).toBe('medium');
    expect(f.allowRealtimeSummary).toBe(true);
  });

  it('无自定义组 → 按角色 group_config 解析', async () => {
    setSiteSettings({
      group_config_FREE: { maxThinkingDepth: 'off', allowRealtimeSummary: false },
    });
    const f = await resolveUserFeatureFlags({ role: 'FREE', customGroupId: null });
    expect(f.maxThinkingDepth).toBe('off');
    expect(f.allowRealtimeSummary).toBe(false);
    // allowFinalSummary 未在配置中 → 回落 FREE 默认 true
    expect(f.allowFinalSummary).toBe(true);
  });
});
