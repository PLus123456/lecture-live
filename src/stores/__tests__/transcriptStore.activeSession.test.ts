/**
 * transcriptStore activeSessionId 绑定测试（P0-3）。
 *
 * 全局实时 store 是 SPA 内单例，必须记录归属会话，供别的会话页判定 segments/计时/
 * recordingState 是否属于自己，杜绝跨会话串数据。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 提供内存 sessionStorage（persist 中间件需要）
beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => map.set(k, String(v)),
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage);
});

import { useTranscriptStore } from '../transcriptStore';

describe('transcriptStore activeSessionId（P0-3）', () => {
  it('默认 null；setActiveSessionId 写入；clearAll 复位为 null', () => {
    useTranscriptStore.setState({ activeSessionId: null });
    expect(useTranscriptStore.getState().activeSessionId).toBeNull();

    useTranscriptStore.getState().setActiveSessionId('sess-A');
    expect(useTranscriptStore.getState().activeSessionId).toBe('sess-A');

    useTranscriptStore.getState().clearAll();
    expect(useTranscriptStore.getState().activeSessionId).toBeNull();
  });
});
