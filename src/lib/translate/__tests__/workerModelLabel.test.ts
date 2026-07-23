// buildWorkerModelLabel 单测：下发给 pdf2zh 的模型标识必须随真实路由变化
//（模型/温度/路由行任一变 → 标识变 → pdf2zh 缓存分键），解析失败给稳定占位。
import { describe, expect, it } from 'vitest';

import { buildWorkerModelLabel } from '@/lib/translate/workerClient';

describe('buildWorkerModelLabel', () => {
  const base = {
    name: 'OpenAI 主力',
    model: 'deepseek-chat',
    temperature: 0.2,
    dbModelId: 'clxx12345678abcdef',
  };

  it('包含供应商+模型+温度+路由行后缀，奇异字符 slug 化', () => {
    const label = buildWorkerModelLabel(base);
    expect(label).toContain('deepseek-chat');
    expect(label).toContain('t2');
    expect(label).toContain('bcdef'.slice(-5)); // dbModelId 后缀
    expect(label).not.toMatch(/\s/); // 空格已被 slug 化
  });

  it('换模型 / 换温度 / 换路由行 → 标识必然不同（缓存分键的根本保证）', () => {
    const a = buildWorkerModelLabel(base);
    expect(buildWorkerModelLabel({ ...base, model: 'gpt-4o' })).not.toBe(a);
    expect(buildWorkerModelLabel({ ...base, temperature: 0.7 })).not.toBe(a);
    expect(buildWorkerModelLabel({ ...base, dbModelId: 'other-route-id-999999' })).not.toBe(a);
  });

  it('同配置 → 标识稳定（同模型重复翻译能命中 pdf2zh 缓存）', () => {
    expect(buildWorkerModelLabel(base)).toBe(buildWorkerModelLabel({ ...base }));
  });

  it('env 兜底（无 dbModelId）与解析失败（null）各给稳定值', () => {
    expect(buildWorkerModelLabel({ ...base, dbModelId: undefined })).toContain('-env');
    expect(buildWorkerModelLabel(null)).toBe('lecture-live-gateway');
  });
});
