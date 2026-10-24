import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SettingsDrawer：抽屉打开期间切换麦克风会改变 currentMicDeviceId。草稿快照只应在「打开」时
 * 重做；此前快照 effect 依赖 currentMicDeviceId，一点麦克风就把用户尚未「应用」的修改清掉。
 */

const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/translation/localTranslator', () => ({
  LocalTranslator: { isSupported: () => true },
}));
vi.mock('@/stores/toastStore', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
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

const { default: SettingsDrawer } = await import('@/components/SettingsDrawer');
const { useSettingsStore } = await import('@/stores/settingsStore');
const { useTranscriptStore } = await import('@/stores/transcriptStore');

const enumerateDevices = vi.fn(async () => [
  { deviceId: 'mic-a', kind: 'audioinput', label: 'Mic A', groupId: 'g' },
  { deviceId: 'mic-b', kind: 'audioinput', label: 'Mic B', groupId: 'g' },
]);

describe('SettingsDrawer 草稿快照', () => {
  beforeEach(() => {
    memStorage.clear();
    enumerateDevices.mockClear();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices },
    });
    useSettingsStore.setState({ topic: 'Original topic', domain: 'University Lecture', terms: [] });
    useTranscriptStore.setState({ recordingState: 'recording', currentMicDeviceId: 'mic-a' });
  });

  afterEach(() => {
    useTranscriptStore.setState({ recordingState: 'idle', currentMicDeviceId: null, availableMics: [] });
  });

  it('打开期间切换麦克风不清掉未应用的修改，但会刷新麦克风列表；重新打开才重新快照', async () => {
    const user = userEvent.setup();
    const onSwitchMic = (deviceId: string) =>
      useTranscriptStore.getState().setCurrentMicDeviceId(deviceId);
    const { rerender } = render(
      <SettingsDrawer isOpen onClose={() => {}} onSwitchMic={onSwitchMic} />
    );

    await screen.findByText('Mic B');
    expect(enumerateDevices).toHaveBeenCalledTimes(1);

    const topic = screen.getByPlaceholderText('settingsDrawer.topicPlaceholder');
    expect(topic).toHaveValue('Original topic');
    await user.clear(topic);
    await user.type(topic, 'Linear algebra');

    await user.click(screen.getByText('Mic B'));
    expect(useTranscriptStore.getState().currentMicDeviceId).toBe('mic-b');
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledTimes(2));

    expect(screen.getByPlaceholderText('settingsDrawer.topicPlaceholder')).toHaveValue('Linear algebra');

    // 对照：关闭后重新打开（未应用）→ 回到 store 里的值
    rerender(<SettingsDrawer isOpen={false} onClose={() => {}} onSwitchMic={onSwitchMic} />);
    await act(async () => {});
    rerender(<SettingsDrawer isOpen onClose={() => {}} onSwitchMic={onSwitchMic} />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('settingsDrawer.topicPlaceholder')).toHaveValue('Original topic')
    );
  });
});
