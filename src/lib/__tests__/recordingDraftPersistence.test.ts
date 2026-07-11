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
    expect(merged!.hasGap).toBe(false);
  });

  it('seq 空洞时只合并连续前缀并标记 hasGap（不静默拼出损坏音频）', async () => {
    const mod = await loadModule(tmpDir);
    // 写入 0,1,3,4，缺中间的 seq 2
    for (const seq of [0, 1, 3, 4]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged).not.toBeNull();
    // 只拼接连续前缀 0,1（遇 seq 2 空洞即停），丢弃空洞后的 3,4
    expect(merged!.buffer.toString('utf-8')).toBe('chunk-0000chunk-0001');
    expect(merged!.hasGap).toBe(true);
  });

  it('P0-4 append-only：同一 seq 内容不同 → 抛冲突且绝不覆盖已有分片', async () => {
    const mod = await loadModule(tmpDir);
    const first = await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: Buffer.from('original-header'),
    });
    expect(first.idempotent).toBe(false);

    await expect(
      mod.persistRecordingDraftChunk(session, {
        seq: 0,
        mimeType: 'audio/webm',
        data: Buffer.from('DIFFERENT-header-overwrite'),
      })
    ).rejects.toBeInstanceOf(mod.RecordingDraftChunkConflictError);

    // 磁盘上的 seq 0 仍是最初内容（旧代码会被无条件覆盖 → 冷设备续录毁掉录音开头）。
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged!.buffer.toString('utf-8')).toBe('original-header');
  });

  it('P0-4 append-only：同一 seq 内容相同 → 幂等成功（网络重试）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 3,
      mimeType: 'audio/webm',
      data: mkChunk(3),
    });
    const retry = await mod.persistRecordingDraftChunk(session, {
      seq: 3,
      mimeType: 'audio/webm',
      data: mkChunk(3),
    });
    expect(retry.idempotent).toBe(true);
    // P1-6：幂等重传不重复计数；权威 seq 集合仍以磁盘为准。
    expect(retry.chunkCount).toBe(1);
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual([3]);
  });

  it('P0-4 清单摘要 nextSeq = maxSeq+1；无草稿时 maxSeq=-1/nextSeq=0', async () => {
    const mod = await loadModule(tmpDir);
    const empty = await mod.getRecordingDraftManifestSummary(session);
    expect(empty).toMatchObject({ maxSeq: -1, nextSeq: 0, sealed: false });

    for (const seq of [0, 1, 2]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const summary = await mod.getRecordingDraftManifestSummary(session);
    expect(summary.maxSeq).toBe(2);
    expect(summary.nextSeq).toBe(3);
    expect(summary.sealed).toBe(false);
    expect(summary.revision).toBeGreaterThan(0);
  });

  it('P0-5 leading gap：缺首块 seq 0（seqs[0]!==0）必须 hasGap=true', async () => {
    const mod = await loadModule(tmpDir);
    // 只有 seq 1,2（缺 seq 0）——旧代码 expected=seqs[0]=1，会误判 hasGap=false。
    for (const seq of [1, 2]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    const merged = await mod.mergeRecordingDraftChunks(session);
    expect(merged).not.toBeNull();
    expect(merged!.hasGap).toBe(true);
    // 从 seq 0 起无连续前缀 → 合并结果为空，不得当作完整录音。
    expect(merged!.buffer.length).toBe(0);
  });

  it('P1-7 seal 后拒绝任何新分片写入（迟到写 → 抛 sealed）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });
    const summary = await mod.sealRecordingDraft(session);
    expect(summary.sealed).toBe(true);
    expect(await mod.isRecordingDraftSealed(session)).toBe(true);

    await expect(
      mod.persistRecordingDraftChunk(session, {
        seq: 1,
        mimeType: 'audio/webm',
        data: mkChunk(1),
      })
    ).rejects.toBeInstanceOf(mod.RecordingDraftSealedError);

    // 迟到写未落盘：磁盘仍只有 seq 0。
    expect(await mod.listRecordingDraftSeqs(session)).toEqual([0]);
  });

  it('P1-7 unseal 释放封存：seal 后 unseal 可再次写入（补传缺片重试收尾）', async () => {
    const mod = await loadModule(tmpDir);
    await mod.persistRecordingDraftChunk(session, {
      seq: 0,
      mimeType: 'audio/webm',
      data: mkChunk(0),
    });
    await mod.sealRecordingDraft(session);
    expect(await mod.isRecordingDraftSealed(session)).toBe(true);

    await mod.unsealRecordingDraft(session);
    expect(await mod.isRecordingDraftSealed(session)).toBe(false);

    // 解封后可补传之前缺失的分片。
    const after = await mod.persistRecordingDraftChunk(session, {
      seq: 1,
      mimeType: 'audio/webm',
      data: mkChunk(1),
    });
    expect(after.chunkCount).toBe(2);
    const manifest = await mod.loadRecordingDraftManifest(session);
    expect(manifest?.receivedSeqs).toEqual([0, 1]);
  });

  it('P1-6 写入热路径不再每片 readdir 全目录（维护式计数，O(1)）', async () => {
    const mod = await loadModule(tmpDir);
    const readdirSpy = vi.spyOn(fs, 'readdir');
    for (const seq of [0, 1, 2, 3, 4]) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }
    // 旧实现每片都 scanChunkSeqsOnDisk → 5 次 readdir（4h 录音累计 O(n²)）；
    // 新实现仅首片元数据缺计数时播种一次，其余写入零 readdir。
    expect(readdirSpy.mock.calls.length).toBeLessThanOrEqual(1);
    readdirSpy.mockRestore();
  });

  it('P1-6 流式合并顺序读取分片（不再一次性打开全部 FD）', async () => {
    const mod = await loadModule(tmpDir);
    for (let seq = 0; seq < 30; seq += 1) {
      await mod.persistRecordingDraftChunk(session, {
        seq,
        mimeType: 'audio/webm',
        data: mkChunk(seq),
      });
    }

    let active = 0;
    let maxActive = 0;
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi
      .spyOn(fs, 'readFile')
      .mockImplementation((...args: Parameters<typeof fs.readFile>) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return (originalReadFile as (...a: unknown[]) => Promise<unknown>)(
          ...(args as unknown[])
        ).finally(() => {
          active -= 1;
        }) as ReturnType<typeof fs.readFile>;
      });

    const merged = await mod.mergeRecordingDraftChunks(session);
    readFileSpy.mockRestore();

    expect(merged).not.toBeNull();
    expect(merged!.buffer.length).toBeGreaterThan(0);
    // 旧实现 Promise.all(seqs.map(readFile)) 会让 30 个读并发在飞（maxActive=30，数万分片时 EMFILE）；
    // 新实现逐片顺序读，任一时刻最多 1 个读在飞。
    expect(maxActive).toBe(1);
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
