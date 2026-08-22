import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L48 回归锁：/interpret 的「测试麦克风」（3 秒）必须注册卸载清理。
 *
 * 旧代码里 setInterval / setTimeout / MediaStream / AudioContext 全是裸创建，
 * 组件卸载后定时器仍在跑（对已卸载组件 setState），麦克风与 AudioContext 要等那条
 * 3 秒 timeout 自己跑完才释放。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));

const interpretMocks = vi.hoisted(() => ({
  isRunning: false,
  connectionState: 'disconnected' as const,
  linesA: [] as never[],
  linesB: [] as never[],
  previewText: { finalText: '', nonFinalText: '' },
  previewTranslation: {
    finalText: '',
    nonFinalText: '',
    state: 'idle' as const,
    sourceLanguage: null,
  },
  previewLang: 'en',
  elapsedMs: 0,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock('@/hooks/useInterpret', () => ({ useInterpret: () => interpretMocks }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'test-token', fetchQuotas: vi.fn(async () => {}) }),
}));

const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memStorage.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStorage.delete(k);
    },
    clear: () => memStorage.clear(),
    key: () => null,
    length: 0,
  },
});

const { default: InterpretPage } = await import('@/app/(dashboard)/interpret/page');
const { useAuthStore } = await import('@/stores/authStore');

const trackStop = vi.fn();
const ctxClose = vi.fn(async () => {});

function installMediaMocks() {
  const fakeStream = {
    getTracks: () => [{ stop: trackStop }],
  } as unknown as MediaStream;

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'mic-1', label: '麦克风 1' },
      ],
      getUserMedia: async () => fakeStream,
    },
  });

  vi.stubGlobal(
    'AudioContext',
    class {
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          frequencyBinCount: 128,
          getByteFrequencyData: () => {},
        };
      }
      close = ctxClose;
    }
  );
}

describe('/interpret 麦克风测试的资源清理（L48）', () => {
  beforeEach(() => {
    memStorage.clear();
    trackStop.mockClear();
    ctxClose.mockClear();
    useAuthStore.setState({
      quotas: {
        transcriptionMinutesUsed: 0,
        transcriptionMinutesLimit: 600,
        remainingTranscriptionMinutes: 600,
      } as never,
    });
    installMediaMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('测试进行中卸载页面：定时器停摆、麦克风与 AudioContext 立即释放', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<InterpretPage />);

    await user.click(screen.getByText('测试'));
    await waitFor(() => {
      expect(screen.getByText('测试中…')).toBeInTheDocument();
    });

    // 3 秒自愈计时还没到就离开页面
    act(() => {
      unmount();
    });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(ctxClose).toHaveBeenCalledTimes(1);
    // 定时器已被清掉：再推进到 3 秒也不会有第二次释放（旧代码是靠这条 timeout 才释放的）
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(ctxClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('不卸载时 3 秒后照常自愈（清理逻辑没有把正常路径改坏）', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InterpretPage />);

    await user.click(screen.getByText('测试'));
    await waitFor(() => {
      expect(screen.getByText('测试中…')).toBeInTheDocument();
    });

    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(ctxClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('测试')).toBeInTheDocument();
    });
  });
});
