import { describe, expect, it } from 'vitest';
import {
  encodeCompressedHistorySystemMessage,
  findCompressionBoundary,
  parseCompressedHistorySystemMessage,
} from '@/lib/llm/chatCompression';

describe('chatCompression', () => {
  it('解析压缩 system 消息并隐藏内部边界标记', () => {
    const encoded = encodeCompressedHistorySystemMessage('早期摘要', 'msg-a2');
    const parsed = parseCompressedHistorySystemMessage(encoded);

    expect(parsed).toEqual({
      summary: '早期摘要',
      compressedThroughMessageId: 'msg-a2',
    });
  });

  it('用 compressed-through 标记切分已折叠和可见消息', () => {
    const messages = [
      { id: 'msg-u1', role: 'user', content: '问题 1' },
      { id: 'msg-a1', role: 'assistant', content: '回答 1' },
      { id: 'msg-u2', role: 'user', content: '问题 2' },
      { id: 'msg-a2', role: 'assistant', content: '回答 2' },
      { id: 'msg-u3', role: 'user', content: '问题 3' },
      {
        id: 'sys-1',
        role: 'system',
        content: encodeCompressedHistorySystemMessage('压缩摘要', 'msg-a2'),
      },
    ];

    const boundary = findCompressionBoundary(messages);
    const archived = messages
      .slice(0, boundary.splitIndex + 1)
      .filter((message) => message.role !== 'system')
      .map((message) => message.id);
    const visible = messages
      .slice(boundary.splitIndex + 1)
      .filter((message) => message.role !== 'system')
      .map((message) => message.id);

    expect(boundary.summary).toBe('压缩摘要');
    expect(archived).toEqual(['msg-u1', 'msg-a1', 'msg-u2', 'msg-a2']);
    expect(visible).toEqual(['msg-u3']);
  });
});
