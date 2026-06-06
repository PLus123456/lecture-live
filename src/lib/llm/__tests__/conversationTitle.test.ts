import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));

vi.mock('@/lib/llm/gateway', () => ({ callLLM: callLLMMock }));

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

import {
  sanitizeTitle,
  generateConversationTitle,
} from '@/lib/llm/conversationTitle';

describe('sanitizeTitle', () => {
  it('去包裹引号 + 首尾标点', () => {
    expect(sanitizeTitle('“讨论 React 性能优化。”')).toBe('讨论 React 性能优化');
    expect(sanitizeTitle('"Hello world!"')).toBe('Hello world');
  });
  it('只取首行', () => {
    expect(sanitizeTitle('标题在这\n其它说明')).toBe('标题在这');
  });
  it('空白 → null', () => {
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle('')).toBeNull();
  });
  it('超长截断到 40', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeTitle(long)?.length).toBe(40);
  });
});

describe('generateConversationTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('基于首条用户消息生成并规整标题', async () => {
    callLLMMock.mockResolvedValueOnce('  “React 性能优化”  ');
    const title = await generateConversationTitle({
      firstUserMessage: '怎么优化 React 列表渲染性能？',
    });
    expect(title).toBe('React 性能优化');
    expect(callLLMMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('用户：'),
      { purpose: 'KEYWORD_EXTRACTION' }
    );
  });

  it('空消息 → null，不调用 LLM', async () => {
    const title = await generateConversationTitle({ firstUserMessage: '   ' });
    expect(title).toBeNull();
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it('剥离 markdown 图片语法后仍为空 → null，不调用 LLM', async () => {
    const title = await generateConversationTitle({
      firstUserMessage: '![image](data:image/png;base64,xxx)',
    });
    expect(title).toBeNull();
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it('LLM 抛错 → 返回 null', async () => {
    callLLMMock.mockRejectedValueOnce(new Error('boom'));
    const title = await generateConversationTitle({
      firstUserMessage: '你好',
    });
    expect(title).toBeNull();
  });
});
