import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * C51/P6-8 + C47/L27：登出必须把「账号相关的本机残留」一起扫掉。
 *
 * 修复前 logout 只清了 auth/conversation/chat store 与 `lecture-live-auth` 这一个
 * localStorage 键：IndexedDB 里的录音音频原封不动（下一个在本机登录的账号会看到、
 * 甚至在 finalize 时被 syncRemoteDraft 上传），已浏览的分享链接（含 share token）
 * 也照旧留着。
 */

const { clearAllAudioArchivesMock, backing } = vi.hoisted(() => {
  // 本仓库的 jsdom 环境里 `localStorage` 只是个空对象（没有 setItem），
  // 而 sharedLinksStore 的 zustand persist 在**模块导入时**就会把它捕获下来。
  // 所以替身必须在 import 之前装好——放在 vi.hoisted 里。
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return {
    clearAllAudioArchivesMock: vi.fn(async () => {}),
    backing: store,
  };
});

vi.mock('@/lib/audio/audioChunkStore', () => ({
  clearAllAudioArchives: clearAllAudioArchivesMock,
}));

import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useSharedLinksStore } from '@/stores/sharedLinksStore';

const SHARE_LINKS_KEY = 'lecture-live-viewed-share-links';

beforeEach(() => {
  vi.clearAllMocks();
  backing.clear();
  useSharedLinksStore.setState({ viewedLinks: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAuth().logout 的本机清扫 (C51/P6-8 + C47/L27)', () => {
  it('清空 IndexedDB 里的录音归档', async () => {
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });
    expect(clearAllAudioArchivesMock).toHaveBeenCalledTimes(1);
  });

  it('清空已浏览的分享链接（含 share token）以及它的 localStorage 键', async () => {
    useSharedLinksStore.getState().rememberViewedLink({
      token: 'share-token-1',
      url: 'https://example.com/shared/share-token-1',
      sessionId: 's1',
      title: 'T',
      sourceLang: 'zh',
      targetLang: 'en',
      status: 'LIVE',
      viewedAt: new Date().toISOString(),
    });
    localStorage.setItem(SHARE_LINKS_KEY, '{"state":{}}');
    expect(useSharedLinksStore.getState().viewedLinks).toHaveLength(1);

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });

    expect(useSharedLinksStore.getState().viewedLinks).toHaveLength(0);
    expect(localStorage.getItem(SHARE_LINKS_KEY)).toBeNull();
  });

  it('归档清理失败也不阻断登出：仍清 auth store 并请求服务端清 cookie', async () => {
    clearAllAudioArchivesMock.mockRejectedValueOnce(new Error('IndexedDB blocked'));
    useAuthStore.getState().setAuth(
      {
        id: 'u1',
        email: 'u@example.com',
        displayName: 'U',
        role: 'FREE',
        createdAt: new Date().toISOString(),
      },
      'token-1'
    );

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });

    expect(useAuthStore.getState().user).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
