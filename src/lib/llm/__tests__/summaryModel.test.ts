import { describe, expect, it, vi, beforeEach } from 'vitest';

// 摘要模型路由解析：组绑定模型 > 全局用途默认；失效 id 静默回落。
// mock gateway 的 getModelById / getProviderForPurpose，不触真实 DB。

const { getModelByIdMock, getProviderForPurposeMock } = vi.hoisted(() => ({
  getModelByIdMock: vi.fn(),
  getProviderForPurposeMock: vi.fn(),
}));

vi.mock('@/lib/llm/gateway', () => ({
  getModelById: getModelByIdMock,
  getProviderForPurpose: getProviderForPurposeMock,
}));

import { resolveSummaryModel } from '@/lib/llm/summaryModel';

beforeEach(() => {
  getModelByIdMock.mockReset();
  getProviderForPurposeMock.mockReset();
});

describe('resolveSummaryModel', () => {
  it('未配组模型（null/空）→ 回落 purpose 默认，不查 getModelById', async () => {
    getProviderForPurposeMock.mockResolvedValue({ contextWindow: 8000, dbModelId: 'default-rt' });
    const r = await resolveSummaryModel(null, 'REALTIME_SUMMARY');
    expect(r.routing).toEqual({ purpose: 'REALTIME_SUMMARY' });
    expect(getModelByIdMock).not.toHaveBeenCalled();
    expect(getProviderForPurposeMock).toHaveBeenCalledWith('REALTIME_SUMMARY');
    expect(r.provider?.contextWindow).toBe(8000);
  });

  it('组模型存在 → 用 { modelId } 且带回该模型 provider（不查用途默认）', async () => {
    getModelByIdMock.mockResolvedValue({ dbModelId: 'grp-mini', contextWindow: 4000 });
    const r = await resolveSummaryModel('grp-mini', 'FINAL_SUMMARY');
    expect(r.routing).toEqual({ modelId: 'grp-mini' });
    expect(r.provider?.contextWindow).toBe(4000);
    expect(getProviderForPurposeMock).not.toHaveBeenCalled();
  });

  it('组模型 id 失效（getModelById 回落 env active provider，dbModelId 不等）→ 回落 purpose 默认', async () => {
    getModelByIdMock.mockResolvedValue({ name: 'env-active', dbModelId: undefined });
    getProviderForPurposeMock.mockResolvedValue({ contextWindow: 8192 });
    const r = await resolveSummaryModel('stale-id', 'FINAL_SUMMARY');
    expect(r.routing).toEqual({ purpose: 'FINAL_SUMMARY' });
    expect(getProviderForPurposeMock).toHaveBeenCalledWith('FINAL_SUMMARY');
  });

  it('getModelById 抛错 → 回落 purpose 默认', async () => {
    getModelByIdMock.mockRejectedValue(new Error('db down'));
    getProviderForPurposeMock.mockResolvedValue({ contextWindow: 8192 });
    const r = await resolveSummaryModel('some-id', 'REALTIME_SUMMARY');
    expect(r.routing).toEqual({ purpose: 'REALTIME_SUMMARY' });
  });

  it('purpose 默认也解析失败 → provider=null，仍返回 purpose 路由（调用方兜底 contextWindow）', async () => {
    getProviderForPurposeMock.mockRejectedValue(new Error('no models'));
    const r = await resolveSummaryModel('', 'FINAL_SUMMARY');
    expect(r.routing).toEqual({ purpose: 'FINAL_SUMMARY' });
    expect(r.provider).toBeNull();
  });
});
