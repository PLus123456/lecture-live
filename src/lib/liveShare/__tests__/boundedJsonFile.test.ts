import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundedJsonFileError,
  readJsonFileBounded,
} from '@/lib/liveShare/boundedJsonFile';

describe('readJsonFileBounded', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function tempFile(contents: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-share-json-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'snapshot.json');
    await fs.writeFile(file, contents);
    return file;
  }

  it('读取不超过实际 UTF-8 字节上限的 JSON', async () => {
    const contents = JSON.stringify({ text: '😀中文' });
    const file = await tempFile(contents);
    await expect(
      readJsonFileBounded(file, Buffer.byteLength(contents, 'utf8'))
    ).resolves.toEqual({ text: '😀中文' });
  });

  it('在 JSON.parse 前拒绝超过上限的文件', async () => {
    const file = await tempFile(JSON.stringify({ text: 'x'.repeat(100) }));
    await expect(readJsonFileBounded(file, 16)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    } satisfies Partial<BoundedJsonFileError>);
  });

  it('有界读取后仍严格拒绝损坏 JSON', async () => {
    const file = await tempFile('{"broken":');
    await expect(readJsonFileBounded(file, 1024)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    } satisfies Partial<BoundedJsonFileError>);
  });
});
