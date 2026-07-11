// chatStore 运行时态按 conversationId 隔离的不变量测试（批7 ①治本重构）。
// 核心：任一对话的流式写入只动自己那一片，结构上无法串到别的对话 —— 根治
// "流式途中切对话/切录音 → 旧 SSE 流污染当前对话 / 产生孤儿消息"。
//
// 文件名用 .tsx 以走 vitest 的 jsdom 环境。注意：store 经 zustand persist 在每次
// setState 都会写 localStorage，而 vitest 自带的 localStorage 在 --localstorage-file
// 下写入会抛错；createJSONStorage 又在模块加载时即捕获 localStorage 引用，故必须在
// import store 之前用内存实现整体替换，再动态加载 store。

import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatMessage, ChatModelOption } from '@/types/llm';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  },
});

// 替换 localStorage 后再动态加载 store，使其 persist 捕获到内存实现。
const { useChatStore, EMPTY_CONVERSATION_RUNTIME } = await import(
  '@/stores/chatStore'
);

const msg = (id: string, content = ''): ChatMessage => ({
  id,
  role: 'user',
  content,
  timestamp: 0,
});

const fakeModel = (name: string): ChatModelOption => ({
  name,
  displayName: name.toUpperCase(),
  supportsThinking: false,
  thinkingMode: 'NONE',
  supportsThinkingDepth: false,
  allowedDepths: [],
  supportsImage: false,
  contextWindow: 8000,
});

describe('chatStore — 按 conversationId 隔离的运行时切片', () => {
  beforeEach(() => {
    useChatStore.getState().resetSession();
  });

  it('addMessage 只追加到目标对话，不串到其它对话', () => {
    const s = useChatStore.getState();
    s.addMessage('A', msg('a1'));
    s.addMessage('B', msg('b1'));
    s.addMessage('A', msg('a2'));

    const { byConversation } = useChatStore.getState();
    expect(byConversation['A'].messages.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(byConversation['B'].messages.map((m) => m.id)).toEqual(['b1']);
  });

  it('updateMessage 只改目标对话里的对应消息（同 id 不同对话互不影响）', () => {
    const s = useChatStore.getState();
    s.addMessage('A', msg('x', 'A-old'));
    s.addMessage('B', msg('x', 'B-old'));
    s.updateMessage('A', 'x', { content: 'A-new' });

    const { byConversation } = useChatStore.getState();
    expect(byConversation['A'].messages[0].content).toBe('A-new');
    expect(byConversation['B'].messages[0].content).toBe('B-old');
  });

  it('动一个对话切片时，其它对话切片保持同一引用（不触发无谓重渲染）', () => {
    const s = useChatStore.getState();
    s.addMessage('A', msg('a1'));
    s.addMessage('B', msg('b1'));
    const refA = useChatStore.getState().byConversation['A'];

    useChatStore.getState().addMessage('B', msg('b2'));
    expect(useChatStore.getState().byConversation['A']).toBe(refA);
  });

  it('串台场景：B 活跃时 A 的旧流继续写，B 完全不受污染', () => {
    const s = useChatStore.getState();
    // B 是当前活跃、已加载
    s.setActiveConversation('B');
    s.setMessages('B', [msg('b1')]);

    // A 的"旧流"仍在写（SSE 回调闭包捕获 convId='A'）
    s.addMessage('A', msg('a-orphan'));
    s.setLoading('A', true);
    s.setContextFull('A', true);
    s.updateMessage('A', 'a-orphan', { content: 'streamed' });

    const { byConversation, activeConversationId } = useChatStore.getState();
    expect(activeConversationId).toBe('B');
    // B 干净：消息不变、未被置 loading / contextFull
    expect(byConversation['B'].messages.map((m) => m.id)).toEqual(['b1']);
    expect(byConversation['B'].isLoading).toBe(false);
    expect(byConversation['B'].contextFull).toBe(false);
    // A 的孤儿写入只落在 A 自己片里（已非活跃、不可见）
    expect(byConversation['A'].messages[0].content).toBe('streamed');
    expect(byConversation['A'].isLoading).toBe(true);
  });

  it('setLoading / setTokenUsage / setContextFull 按对话隔离', () => {
    const s = useChatStore.getState();
    s.setLoading('A', true);
    s.setContextFull('A', true);
    s.setTokenUsage('A', {
      used: 10,
      budget: 100,
      level: 2,
      breakdown: {
        systemPrompt: 0,
        transcript: 0,
        summary: 0,
        history: 10,
        userInput: 0,
      },
    });

    const { byConversation } = useChatStore.getState();
    expect(byConversation['A'].isLoading).toBe(true);
    expect(byConversation['A'].contextFull).toBe(true);
    expect(byConversation['A'].tokenUsage?.used).toBe(10);
    // 未初始化的对话回落到稳定的空切片常量
    expect(byConversation['B'] ?? EMPTY_CONVERSATION_RUNTIME).toBe(
      EMPTY_CONVERSATION_RUNTIME
    );
  });

  it('resetConversation 只清目标对话；resetSession 清全部切片+导航态但保留模型/偏好', () => {
    const s = useChatStore.getState();
    s.setAvailableModels([fakeModel('m1')], 'm1');
    s.setSelectedModel('m1');
    s.addMessage('A', msg('a1'));
    s.addMessage('B', msg('b1'));

    useChatStore.getState().resetConversation('A');
    expect(useChatStore.getState().byConversation['A']).toBeUndefined();
    expect(useChatStore.getState().byConversation['B'].messages).toHaveLength(1);

    useChatStore.getState().resetSession();
    const after = useChatStore.getState();
    expect(after.byConversation).toEqual({});
    expect(after.conversations).toEqual([]);
    expect(after.activeConversationId).toBeNull();
    // 模型列表（全局）与用户偏好（持久化）不被 resetSession 清空
    expect(after.selectedModel).toBe('m1');
    expect(after.availableModels).toHaveLength(1);
    expect(after.modelsLoaded).toBe(true);
  });

  it('resetForAccountSwitch 额外清空模型列表并复位 modelsLoaded（M2 换账号）', () => {
    const s = useChatStore.getState();
    s.setAvailableModels([fakeModel('m1'), fakeModel('m2')], 'm1');
    s.addMessage('A', msg('a1'));
    s.setActiveConversation('A');

    // 前置：resetSession 保留模型列表（对照）
    expect(useChatStore.getState().modelsLoaded).toBe(true);
    expect(useChatStore.getState().availableModels).toHaveLength(2);

    useChatStore.getState().resetForAccountSwitch();
    const after = useChatStore.getState();
    // 对话切片 + 导航态清空
    expect(after.byConversation).toEqual({});
    expect(after.conversations).toEqual([]);
    expect(after.activeConversationId).toBeNull();
    // 关键：模型列表被清、modelsLoaded 复位 false → 新账号会重新拉取自己（按组授权）的模型
    expect(after.availableModels).toEqual([]);
    expect(after.modelsLoaded).toBe(false);
  });
});
