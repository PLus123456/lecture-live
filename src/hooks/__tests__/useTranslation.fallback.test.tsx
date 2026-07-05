/**
 * useLocalTranslation 本地模型加载失败回退云端测试（v3-R3 / U81）。
 *
 * 本地模型初始化失败时应：
 *  1. 把 translationMode 切到 'soniox'（回退云端翻译）；
 *  2. 触发 onFallbackToCloud，供上层重建活跃 Soniox 会话使云翻译真正生效
 *     （否则活跃会话的 translation config 在连接时已固定、之后不更新，回退后仍零翻译）。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const make = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: make(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: make(),
    configurable: true,
    writable: true,
  });
});

// 让 initLocalTranslator 抛错，模拟 CDN 不可达 / 模型加载失败。
const initLocalTranslatorMock = vi.fn(async () => {
  throw new Error('model download failed');
});

vi.mock('@/lib/translation/scheduler', () => ({
  TranslationScheduler: class {
    setTargetLang() {}
    onFinalizedSentence() {}
    destroy() {}
    initLocalTranslator = initLocalTranslatorMock;
  },
}));

import { useLocalTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/stores/settingsStore';

beforeEach(() => {
  initLocalTranslatorMock.mockClear();
  useSettingsStore.setState({
    translationMode: 'local',
    sourceLang: 'en',
    targetLang: 'zh',
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('U81：本地模型加载失败回退云端 + 触发会话重建', () => {
  it('initLocal 失败时应切到 soniox 并触发 onFallbackToCloud', async () => {
    const onFallbackToCloud = vi.fn();
    const { result } = renderHook(() => useLocalTranslation({ onFallbackToCloud }));

    await act(async () => {
      await result.current.initLocal();
    });

    expect(initLocalTranslatorMock).toHaveBeenCalledTimes(1);
    // 回退到云端翻译
    expect(useSettingsStore.getState().translationMode).toBe('soniox');
    // 触发上层重建活跃 Soniox 会话
    expect(onFallbackToCloud).toHaveBeenCalledTimes(1);
  });

  it('已是 soniox 模式时（无需回退）不重复触发 onFallbackToCloud', async () => {
    useSettingsStore.setState({ translationMode: 'soniox' } as never);
    const onFallbackToCloud = vi.fn();
    const { result } = renderHook(() => useLocalTranslation({ onFallbackToCloud }));

    await act(async () => {
      await result.current.initLocal();
    });

    // translationMode 已是 soniox，不改动、也不重建
    expect(useSettingsStore.getState().translationMode).toBe('soniox');
    expect(onFallbackToCloud).not.toHaveBeenCalled();
  });
});
