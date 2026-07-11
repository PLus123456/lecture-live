import os from 'os';
import path from 'path';
import fsSync from 'fs';
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-14 / P1-15：async 上传分片持久化的负向回归。用真实 fs（临时目录 + stub process.cwd），
 * 覆盖旧代码放行的两类问题：
 *  - P1-14：re-init 换文件不清旧分片 → 旧 seq 混入新清单（新文件更小时永远无法 finalize）；
 *  - P1-15：merge 不核对每片精确长度 / 总字节 / 整文件 hash → 声明可撒谎绕过大小与配额估算。
 */

const session = { id: 'sess-abc', userId: 'user-1' };
let tmpRoot: string;
let mod: typeof import('../asyncUploadChunkPersistence');

beforeAll(async () => {
  tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'asyncupload-test-'));
  // 模块顶层 const UPLOADS_ROOT = path.join(process.cwd(), ...)，须在 import 前 stub。
  vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
  mod = await import('../asyncUploadChunkPersistence');
});

afterAll(() => {
  fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

beforeEach(async () => {
  // 每个用例前清掉本会话的上传目录，互不干扰。
  await mod.deleteAsyncUpload({ id: session.id });
});

function buf(byte: string, len: number): Buffer {
  return Buffer.alloc(len, byte);
}

describe('P1-14 re-init 分片清理', () => {
  it('换文件（布局不同）re-init → 旧分片被清空，不混入新清单', async () => {
    await mod.initAsyncUpload(session, {
      originalFileName: 'a.webm',
      originalMimeType: 'video/webm',
      originalSize: 150,
      totalChunks: 3,
      chunkSize: 50,
    });
    await mod.persistAsyncUploadChunk(session, { seq: 0, data: buf('A', 50) });
    await mod.persistAsyncUploadChunk(session, { seq: 1, data: buf('A', 50) });
    await mod.persistAsyncUploadChunk(session, { seq: 2, data: buf('A', 50) });
    expect((await mod.loadAsyncUploadManifest(session))!.receivedSeqs).toEqual([0, 1, 2]);

    // 换一个更小的新文件 re-init
    const m = await mod.initAsyncUpload(session, {
      originalFileName: 'b.mp3',
      originalMimeType: 'audio/mpeg',
      originalSize: 50,
      totalChunks: 1,
      chunkSize: 50,
    });
    // 旧代码：旧 3 片残留 → receivedSeqs=[0,1,2] > totalChunks=1，永远无法 finalize。
    expect(m.receivedSeqs).toEqual([]);
    expect((await mod.loadAsyncUploadManifest(session))!.receivedSeqs).toEqual([]);
  });

  it('相同布局 re-init（断点续传）→ 保留已收分片', async () => {
    const input = {
      originalFileName: 'a.webm',
      originalMimeType: 'video/webm',
      originalSize: 100,
      totalChunks: 2,
      chunkSize: 50,
    };
    await mod.initAsyncUpload(session, input);
    await mod.persistAsyncUploadChunk(session, { seq: 0, data: buf('A', 50) });

    const m = await mod.initAsyncUpload(session, input);
    expect(m.receivedSeqs).toEqual([0]);
  });
});

describe('P1-15 merge 精确长度 / 总字节 / hash 校验', () => {
  async function seed(sizeOverrides?: { originalSize?: number }) {
    await mod.initAsyncUpload(session, {
      originalFileName: 'a.webm',
      originalMimeType: 'video/webm',
      originalSize: sizeOverrides?.originalSize ?? 100,
      totalChunks: 2,
      chunkSize: 50,
    });
  }

  it('末片长度不符声明 → merge 拒绝', async () => {
    await seed();
    await mod.persistAsyncUploadChunk(session, { seq: 0, data: buf('A', 50) });
    // 末片声明应为 50，实际只传 20（persist 层不校验长度，旧 merge 会静默拼成 70 字节）。
    await mod.persistAsyncUploadChunk(session, { seq: 1, data: buf('B', 20) });
    await expect(mod.mergeAsyncUploadChunks(session)).rejects.toThrow(/length 20 !== expected 50/);
  });

  it('合法分片 → merge 成功并返回精确总字节与 sha256', async () => {
    await seed();
    const c0 = buf('A', 50);
    const c1 = buf('B', 50);
    await mod.persistAsyncUploadChunk(session, { seq: 0, data: c0 });
    await mod.persistAsyncUploadChunk(session, { seq: 1, data: c1 });
    const res = await mod.mergeAsyncUploadChunks(session);
    expect(res.totalBytes).toBe(100);
    const expectedHash = crypto.createHash('sha256').update(Buffer.concat([c0, c1])).digest('hex');
    expect(res.sha256).toBe(expectedHash);
  });

  it('声明 expectedSha256 与实际不符 → merge 拒绝', async () => {
    await mod.initAsyncUpload(session, {
      originalFileName: 'a.webm',
      originalMimeType: 'video/webm',
      originalSize: 100,
      totalChunks: 2,
      chunkSize: 50,
      expectedSha256: '0'.repeat(64),
    });
    await mod.persistAsyncUploadChunk(session, { seq: 0, data: buf('A', 50) });
    await mod.persistAsyncUploadChunk(session, { seq: 1, data: buf('B', 50) });
    await expect(mod.mergeAsyncUploadChunks(session)).rejects.toThrow(/sha256 mismatch/);
  });
});
