import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAsyncUpload } from '@/lib/transcribe/asyncUploadClient';

/**
 * U22/P5-19 回归：分片上传的 init 请求必须带上浏览器实测的 `estimatedDurationMs`。
 *
 * 服务端门禁取 max(声明时长, 按文件大小折的时长下界)。此前客户端**从不**发这个字段，于是门禁只剩
 * 下界；对无损/高码率文件下界远大于真实时长，额度充足的用户照样被 403。拿不到时长时则必须省略该
 * 字段（发 0 会被服务端当作「未声明」，但显式发 0 也容易被后续改动误当成合法声明）。
 */
function makeFile(bytes: number, type: string) {
  return new File([new Uint8Array(bytes)], 'lecture.wav', { type });
}

/**
 * 让 init 请求本身失败：调用参数已被记录，管线随即抛出，用例无需等待分片重试退避。
 */
function fetchStub() {
  return vi.fn(
    async (): Promise<Response> => {
      throw new TypeError('stop-at-init');
    }
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startAsyncUpload init 请求体', () => {
  it('▶ 传入实测时长 → init body 带 estimatedDurationMs（四舍五入到整毫秒）', async () => {
    const fetchMock = fetchStub();
    vi.stubGlobal('fetch', fetchMock);

    const handle = startAsyncUpload({
      file: makeFile(16, 'audio/wav'),
      sessionId: 's1',
      authToken: 't',
      estimatedDurationMs: 305_000.7,
    });
    await expect(handle.promise).rejects.toThrow();

    const initCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/async-upload/init')
    );
    expect(initCall).toBeTruthy();
    const body = JSON.parse(String((initCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      originalMimeType: 'audio/wav',
      originalSize: 16,
      estimatedDurationMs: 305_001,
    });
  });

  it('探测不到时长（未传 / 0）→ 不带该字段，服务端回落大小下界', async () => {
    const fetchMock = fetchStub();
    vi.stubGlobal('fetch', fetchMock);

    const handle = startAsyncUpload({
      file: makeFile(16, 'audio/wav'),
      sessionId: 's1',
      authToken: 't',
      estimatedDurationMs: 0,
    });
    await expect(handle.promise).rejects.toThrow();

    const initCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/async-upload/init')
    );
    const body = JSON.parse(String((initCall![1] as RequestInit).body));
    expect(body).not.toHaveProperty('estimatedDurationMs');
  });
});
