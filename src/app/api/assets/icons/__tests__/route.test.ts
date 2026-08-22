import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * L64：`sanitizePath` 对「清洗后为空」的输入是 **throw**（fileNames.ts:16-21 —— `..`
 * 去掉 `..` 之后成空串就抛 Invalid path after sanitization），而这一句原本写在
 * try 之外，`GET /api/assets/icons/%2e%2e` 于是冒泡成 500 而不是 400。
 *
 * 路径穿越本身一直被挡住（无越权读），坏的只是状态码与噪音日志 —— 但 500 会污染
 * 告警与错误率指标，也让扫描器把它当成可疑面继续戳。
 */

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock('fs/promises', () => {
  const api = { readFile: readFileMock };
  return { ...api, default: api };
});

import { GET } from '@/app/api/assets/icons/[fileName]/route';

function get(fileName: string) {
  return GET(new Request(`http://localhost/api/assets/icons/${fileName}`), {
    params: Promise.resolve({ fileName }),
  });
}

describe('GET /api/assets/icons/[fileName]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockResolvedValue(Buffer.from('<svg/>'));
  });

  it.each(['..', '.', '../', '/', '\\'])(
    'L64：清洗后为空的文件名 %j → 400（不是 500）',
    async (fileName) => {
      const response = await get(fileName);
      expect(response.status).toBe(400);
      expect(readFileMock).not.toHaveBeenCalled();
    }
  );

  it('穿越尝试 ../../etc/passwd → 400，且不读盘', async () => {
    const response = await get('../../etc/passwd');
    expect(response.status).toBe(400);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('合法文件名照常返回，SVG 带 sandbox CSP', async () => {
    const response = await get('logo.svg');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('文件不存在 → 404', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    const response = await get('missing.png');
    expect(response.status).toBe(404);
  });
});
