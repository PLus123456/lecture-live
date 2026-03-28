import { describe, expect, it } from 'vitest';
import {
  LLMValidationError,
  normalizeChatHistory,
  readOptionalIdentifier,
  readRequiredText,
  sanitizePromptValue,
  wrapPromptBlock,
} from '@/lib/llm/security';

describe('llm security helpers', () => {
  it('规范化 chat history', () => {
    expect(
      normalizeChatHistory([
        { role: 'user', content: ' Hello ' },
        { role: 'assistant', content: 'World' },
      ])
    ).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ]);
  });

  it('在 chat history 非法时抛出校验错误', () => {
    expect(() => normalizeChatHistory([{ role: 'system', content: 'bad' }])).toThrow(
      LLMValidationError
    );
  });

  it('读取必填文本并处理可选标识符', () => {
    expect(readRequiredText('  lecture  ', 'question', 20)).toBe('lecture');
    expect(readOptionalIdentifier('  gpt-4o  ', 'model', 20)).toBe('gpt-4o');
  });

  it('清洗 prompt 控制字符与尖括号', () => {
    expect(sanitizePromptValue('a\u0000<b>')).toBe('a &lt;b&gt;');
    expect(wrapPromptBlock('context', '')).toContain('[empty]');
  });
});
