import type { Page, Route } from '@playwright/test';

export async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200
) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export async function installBrowserStubs(page: Page) {
  await page.addInitScript(() => {
    class FakeAnalyserNode {
      fftSize = 2048;
      frequencyBinCount = 1024;

      connect() {}

      disconnect() {}

      getByteFrequencyData(array: Uint8Array) {
        array.fill(0);
      }

      getByteTimeDomainData(array: Uint8Array) {
        array.fill(128);
      }
    }

    class FakeMediaStreamSource {
      connect() {}

      disconnect() {}
    }

    class FakeAudioContext {
      state = 'running';

      createAnalyser() {
        return new FakeAnalyserNode();
      }

      createMediaStreamSource() {
        return new FakeMediaStreamSource();
      }

      close() {
        return Promise.resolve();
      }
    }

    const mediaDevices = {
      enumerateDevices: async () => [
        {
          kind: 'audioinput',
          deviceId: 'mic-1',
          label: 'Built-in Mic',
          groupId: 'group-1',
        },
      ],
      getUserMedia: async () => new MediaStream(),
      getDisplayMedia: async () => new MediaStream(),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    });

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });

    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
  });
}
