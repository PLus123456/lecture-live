import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLM_PURPOSES,
  normalizeDefaultModelsByPurpose,
  pickDefaultModelIdsByPurpose,
} from '@/lib/llm/defaults';

const updateManyMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmModel: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

beforeEach(() => {
  updateManyMock.mockReset();
  updateMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 0 });
  updateMock.mockResolvedValue({});
});

describe('LLM_PURPOSES', () => {
  it('包含全部 5 个用途，特别是 EMBEDDING —— 否则 admin 设默认会静默丢失', () => {
    expect(LLM_PURPOSES).toContain('CHAT');
    expect(LLM_PURPOSES).toContain('REALTIME_SUMMARY');
    expect(LLM_PURPOSES).toContain('FINAL_SUMMARY');
    expect(LLM_PURPOSES).toContain('KEYWORD_EXTRACTION');
    expect(LLM_PURPOSES).toContain('EMBEDDING');
    expect(LLM_PURPOSES).toHaveLength(5);
  });
});

describe('pickDefaultModelIdsByPurpose', () => {
  it('把 isDefault=true 的 EMBEDDING 模型 id 收进结果（修复前 EMBEDDING 会被静默跳过）', () => {
    const defaults = pickDefaultModelIdsByPurpose([
      { id: 'chat-1', purpose: 'CHAT', isDefault: true },
      { id: 'emb-1', purpose: 'EMBEDDING', isDefault: true },
      { id: 'emb-2', purpose: 'EMBEDDING', isDefault: false },
    ]);

    expect(defaults).toEqual({
      CHAT: 'chat-1',
      EMBEDDING: 'emb-1',
    });
  });

  it('忽略 isDefault=false 的模型', () => {
    expect(
      pickDefaultModelIdsByPurpose([
        { id: 'emb-1', purpose: 'EMBEDDING', isDefault: false },
        { id: 'chat-1', purpose: 'CHAT', isDefault: false },
      ])
    ).toEqual({});
  });

  it('忽略未知的 purpose（防御未来 enum 加新值但 LLM_PURPOSES 没同步）', () => {
    expect(
      pickDefaultModelIdsByPurpose([
        { id: 'x-1', purpose: 'UNKNOWN_PURPOSE', isDefault: true },
        { id: 'emb-1', purpose: 'EMBEDDING', isDefault: true },
      ])
    ).toEqual({ EMBEDDING: 'emb-1' });
  });
});

describe('normalizeDefaultModelsByPurpose', () => {
  it('给 EMBEDDING 设默认时也会调用 updateMany 把其他 EMBEDDING 模型的 isDefault 清掉', async () => {
    await normalizeDefaultModelsByPurpose({ EMBEDDING: 'emb-keep' });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        purpose: 'EMBEDDING',
        id: { not: 'emb-keep' },
      },
      data: { isDefault: false },
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'emb-keep' },
      data: { isDefault: true },
    });
  });

  it('多用途同时设默认时，每个用途都被 normalize（CHAT + EMBEDDING）', async () => {
    await normalizeDefaultModelsByPurpose({
      CHAT: 'chat-keep',
      EMBEDDING: 'emb-keep',
    });

    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledTimes(2);

    const purposes = updateManyMock.mock.calls.map(
      ([arg]) => (arg as { where: { purpose: string } }).where.purpose
    );
    expect(purposes).toContain('CHAT');
    expect(purposes).toContain('EMBEDDING');
  });

  it('某 purpose 没指定 keepModelId 时跳过（不去强制清空已有 default）', async () => {
    await normalizeDefaultModelsByPurpose({ CHAT: 'chat-keep' });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [arg] = updateManyMock.mock.calls[0] as [{ where: { purpose: string } }];
    expect(arg.where.purpose).toBe('CHAT');
  });
});
