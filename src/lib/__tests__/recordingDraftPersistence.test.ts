import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 每个测试前重新解析模块，并将 cwd 指向独立的临时目录，
// 确保 DRAFTS_ROOT (process.cwd()/data/recording-drafts) 互不干扰。
async function loadModule(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return import('@/lib/recordingDraftPersistence');
}

describe('recordingDraftPersistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-draft-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const session = { id: 'sess-1', userId: 'user-1' };
  const mkChunk = (seq: number) =>
    Buffer.from(`chunk-${String(seq).padStart(4, '0')}`);

  it('顺序写入的 seq 都能被 manifest 保留', async () => {
    const mod = await loadModule(tmpDir);
    for (const seq of [0, 1, 2, 3, 4]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('并发写入不会因为 manifest 竞态丢失 seq', async () => {
    const mod = await loadModule(tmpDir);
    const seqs = Array.from({ length: 50 }, (_, i) => i);
    await Promise.all(
      seqs.map((seq) =>
        mod.persistRecordingDraftChunk(session, {
          seq,
          mimeType: 'audio/webm',
          data: mkChunk(seq),
        })
      )
    );
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual(seqs);
    const scanned = await mod.listRecordingDraftSeqs(session);
    expect(scanned).toEqual(seqs);
  });

  it('即使 manifest.json 丢失了部分 seq 记录，也能从磁盘恢复', async () => {
    const mod = await loadModule(tmpDir);
    for (const seq of [0, 1, 2, 3]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    // 模拟历史版本写入的陈旧 manifest（receivedSeqs 只记录了部分 seq）
    const manifestPath = path.join(
      tmpDir,
      'data',
      'recording-drafts',
      'sess-1',
      'manifest.json'
    );
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        sessionId: 'sess-1',
        userId: 'user-1',
        mimeType: 'audio/webm',
        createdAt: 1,
        updatedAt: 2,
        receivedSeqs: [0, 2],
      }),
      'utf-8'
    );
    const manifest = await mod.loadRecordingDraftManifest(session);
    // scanChunkSeqsOnDisk 应忽略 manifest 里陈旧的 receivedSeqs，用磁盘扫描结果
    expect(manifest?.receivedSeqs).toEqual([0, 1, 2, 3]);
  });

  it('mergeRecordingDraftChunks 按 seq 升序拼接全部 chunk', async () => {
    const mod = await loadModule(tmpDir);
    const seqs = [2, 0, 4, 1, 3];
    for (const seq of seqs) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged).not.toBeNull();
    expect(merged!.buffer.toString('utf-8')).toBe(
      'chunk-0000chunk-0001chunk-0002chunk-0003chunk-0004'
    );
    expect(merged!.manifest.receivedSeqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('deleteRecordingDraft 同时清掉 manifest 和全部 chunks', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });
    await mod.deleteRecordingDraft(session);
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest).toBeNull();
    const seqs = await mod.listRecordingDraftSeqs(session);
    expect(seqs).toEqual([]);
  });
});
