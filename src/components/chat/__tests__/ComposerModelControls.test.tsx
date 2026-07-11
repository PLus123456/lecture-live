import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelOption, ThinkingDepth } from '@/types/llm';

/**
 * M6 回归：思考深度 UI 必须尊重用户组能力（supportsThinking / allowedDepths），
 * 不能只看模型 thinkingMode。组上限 medium 时菜单不得出现「高」；组禁思考时入口置灰。
 */

const { mockChatState } = vi.hoisted(() => ({
  mockChatState: { current: null as unknown },
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { token: string }) => unknown) =>
    selector({ token: 'test-token' }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => mockChatState.current,
}));

import ComposerModelControls from '@/components/chat/ComposerModelControls';

function depthModel(allowedDepths: ThinkingDepth[], supportsThinking = true): ChatModelOption {
  return {
    name: 'depth-model',
    displayName: 'Depth Model',
    supportsThinking,
    thinkingMode: 'DEPTH',
    supportsThinkingDepth: supportsThinking,
    allowedDepths,
    supportsImage: false,
    contextWindow: 100_000,
  };
}

function setStore(model: ChatModelOption, pref = 'medium') {
  mockChatState.current = {
    selectedModel: model.name,
    selectedThinkingPreference: pref,
    availableModels: [model],
    modelsLoaded: true, // 避免触发 fetch effect
    setSelectedModel: vi.fn(),
    setSelectedThinkingPreference: vi.fn(),
    setAvailableModels: vi.fn(),
  };
}

describe('ComposerModelControls — 思考深度尊重用户组上限（M6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('组上限 medium（allowedDepths=[low,medium]）→ 菜单有「中」，无「高」', async () => {
    setStore(depthModel(['low', 'medium']), 'medium');
    const user = userEvent.setup();
    render(<ComposerModelControls />);

    // 打开思考菜单（按钮 title 以「思考:」开头）
    await user.click(screen.getByTitle(/^思考:/));

    expect(screen.getByText('低')).toBeInTheDocument();
    expect(screen.getByText('中')).toBeInTheDocument();
    // 关键：被组上限挡掉的「高」不得作为可选项出现
    expect(screen.queryByText('高')).toBeNull();
  });

  it('组上限 high（allowedDepths=[low,medium,high]）→ 菜单出现「高」', async () => {
    setStore(depthModel(['low', 'medium', 'high']), 'medium');
    const user = userEvent.setup();
    render(<ComposerModelControls />);

    await user.click(screen.getByTitle(/^思考:/));
    expect(screen.getByText('高')).toBeInTheDocument();
  });

  it('组禁思考（supportsThinking=false）→ 思考入口置灰显示「不支持思考」', () => {
    setStore(depthModel([], false), 'medium');
    render(<ComposerModelControls />);
    expect(screen.getByText('不支持思考')).toBeInTheDocument();
  });
});
