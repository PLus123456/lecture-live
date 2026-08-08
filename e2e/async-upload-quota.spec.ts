import { expect, test } from '@playwright/test';
import { fulfillJson, installBrowserStubs, loginViaForm } from './helpers';

/**
 * 上传转录的配额门禁契约（P5-19 / P1-3）—— 全 route mock，不连真库、不连 Soniox。
 *
 * 修之前：客户端**从不**发 `estimatedDurationMs`，服务端只能按文件大小折一个时长下界；
 * 而那个下界的除数取的是「典型码率」，对无损/高码率音频恒大于真实时长 → 额度充足的用户
 * 照样被 403。所以「只补客户端字段」和「只改服务端下界」各修一半都不够，这条同时钉住两侧的
 * 客户端一侧：浏览器探到了时长，就必须把它带进 init。
 *
 * 红绿要点：
 *  1. init 请求体必须携带浏览器实测的 estimatedDurationMs（去掉 modal 里那一行即转红）；
 *  2. 且必须是实测值、不是按 file.size 的粗估（传成 effectiveDurationMs 也会转红——
 *     构造的 WAV 故意让「按大小折算」和「真实时长」相差一个数量级）。
 */

const user = {
  id: 'user-1',
  email: 'qa@example.com',
  displayName: 'QA',
  role: 'ADMIN',
};

const quotaPayload = {
  quotas: {
    id: 'user-1',
    role: 'ADMIN',
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 999999,
    remainingTranscriptionMinutes: 999999,
    remainingTranscriptionMs: 999999 * 60_000,
    storageHoursUsed: 0,
    storageHoursLimit: 999999,
    storageBytesUsed: 0,
    storageBytesLimit: 1_000_000_000,
    remainingStorageBytes: 1_000_000_000,
    allowedModels: '*',
    quotaResetAt: null,
  },
};

/** 浏览器里真解码得出时长的最小 WAV：8kHz / 单声道 / 8bit PCM，正好 3 秒。 */
const WAV_SAMPLE_RATE = 8000;
const WAV_SECONDS = 3;

let capturedInit: { body: Record<string, unknown> | null } = { body: null };

test.beforeEach(async ({ page }) => {
  capturedInit = { body: null };
  await installBrowserStubs(page);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();

    if (p === '/api/site-config')
      return fulfillJson(route, { site_name: 'QA', allow_registration: true });
    if (p === '/api/auth/login' && method === 'POST')
      return fulfillJson(route, { user, token: '__cookie_session__' });
    if (p === '/api/auth/refresh' && method === 'GET')
      return fulfillJson(route, { user, token: '__cookie_session__' });
    if (p === '/api/users/quota') return fulfillJson(route, quotaPayload);
    if (p === '/api/folders') return fulfillJson(route, []);

    if (p === '/api/sessions' && method === 'POST')
      return fulfillJson(route, { id: 'sess-upload-1' });
    if (p === '/api/sessions') return fulfillJson(route, { items: [], nextCursor: null });

    if (p.endsWith('/async-upload/init') && method === 'POST') {
      capturedInit.body = request.postDataJSON();
      // 停在这里：本用例只关心 init 的请求体，不需要真跑完分片上传流水线。
      return fulfillJson(route, { error: 'stop-after-init' }, 500);
    }

    return fulfillJson(route, {});
  });
});

/** 在页面里合成 WAV 并派发一次真实的 drop 事件（dropzone 监听在 window 上）。 */
async function dropSynthesizedWav(
  page: import('@playwright/test').Page,
  sampleRate: number,
  seconds: number
) {
  await page.evaluate(
    ({ sampleRate: rate, seconds: secs }) => {
      const dataLen = rate * secs; // 8bit 单声道：1 字节 1 采样
      const buffer = new ArrayBuffer(44 + dataLen);
      const view = new DataView(buffer);
      const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i += 1)
          view.setUint8(offset + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, 36 + dataLen, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      view.setUint32(16, 16, true); // PCM fmt chunk size
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, rate, true);
      view.setUint32(28, rate, true); // byteRate = rate * 1ch * 1byte
      view.setUint16(32, 1, true); // blockAlign
      view.setUint16(34, 8, true); // bitsPerSample
      ascii(36, 'data');
      view.setUint32(40, dataLen, true);
      // 无声即可 —— 只需要容器头正确到浏览器肯报 duration。
      new Uint8Array(buffer, 44).fill(128);

      const file = new File([buffer], 'lossless-lecture.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    },
    { sampleRate, seconds }
  );
}

test('P5-19 上传转录：init 请求带上浏览器实测时长，而不是按文件大小的粗估', async ({
  page,
}) => {
  await loginViaForm(page, {
    email: 'qa@example.com',
    password: 'whatever',
    prewarm: ['/home'],
  });

  await dropSynthesizedWav(page, WAV_SAMPLE_RATE, WAV_SECONDS);

  // 松手后弹配置弹窗；等浏览器把时长探完再开始（探测是个 effect，慢一拍）。
  const startButton = page.getByRole('button', {
    name: /start transcription|开始转录/i,
  });
  await expect(startButton).toBeVisible({ timeout: 15_000 });
  await startButton.click();

  await expect.poll(() => capturedInit.body, { timeout: 20_000 }).not.toBeNull();

  const body = capturedInit.body as Record<string, unknown>;
  const estimated = Number(body.estimatedDurationMs);

  // 1) 字段必须在（修之前这里恒为 undefined）。
  expect(Number.isFinite(estimated)).toBe(true);

  // 2) 必须贴近真实的 3 秒，而不是按 file.size 折出来的粗估。
  //    这段 WAV 约 24KB，按「典型压缩音频码率」折出来是数量级更大的时长 —— 正是老实现
  //    把额度充足的用户误判成超额的原因。容差给 1s，覆盖浏览器解码的取整差异。
  expect(estimated).toBeGreaterThan(WAV_SECONDS * 1000 - 1000);
  expect(estimated).toBeLessThan(WAV_SECONDS * 1000 + 1000);
});
