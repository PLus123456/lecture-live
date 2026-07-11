import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { chatUrlTransform } from '@/components/chat/markdownUrlTransform';

const DATA_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA';

describe('chatUrlTransform（M4：放行 data:image 让 base64 图片可见）', () => {
  it('data:image/ URL 原样返回', () => {
    expect(chatUrlTransform(DATA_IMG)).toBe(DATA_IMG);
  });

  it('非 data:image 仍走 react-markdown 默认净化', () => {
    // 普通相对/绝对 URL 透传
    expect(chatUrlTransform('/uploads/x.png')).toBe('/uploads/x.png');
    // 可执行协议被默认净化清空
    expect(chatUrlTransform('javascript:alert(1)')).toBe('');
    // 非图片 data: 也被默认净化（只放行图片）
    expect(chatUrlTransform('data:text/html,<h1>x')).toBe(
      defaultUrlTransform('data:text/html,<h1>x')
    );
  });

  it('回归对照：react-markdown 默认会把 data:image 清成 src=""（证明本修复必要）', () => {
    const { container } = render(
      <ReactMarkdown>{`![img](${DATA_IMG})`}</ReactMarkdown>
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('');
  });

  it('加上 chatUrlTransform 后，data:image 的 src 被完整保留', () => {
    const { container } = render(
      <ReactMarkdown urlTransform={chatUrlTransform}>
        {`![img](${DATA_IMG})`}
      </ReactMarkdown>
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(DATA_IMG);
  });
});
