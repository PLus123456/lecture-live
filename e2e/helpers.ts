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

/**
 * 把一串 {event,data} 编码成后端 `POST /api/llm/chat` 用的 SSE 帧格式：
 *   event: <name>\ndata: <json>\n\n
 * 与 src/app/api/llm/chat/route.ts 的 `sseFrame` 完全一致（GlobalChat 的
 * consumeSse 靠空行 `\n\n` 切帧、`event:`/`data:` 前缀解析、data 走 JSON.parse）。
 */
export function encodeSse(
  events: Array<{ event: string; data: unknown }>
): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

/**
 * 用 SSE 流回应一次 chat 请求。关键：Content-Type 必须含 `text/event-stream`，
 * 否则 GlobalChat 会把响应当成 JSON 错误处理（见 GlobalChat.tsx 的 content-type gate）。
 */
export async function fulfillSse(
  route: Route,
  events: Array<{ event: string; data: unknown }>
) {
  await route.fulfill({
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
    body: encodeSse(events),
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
