import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P0-6：artifact 临时对象 + CAS 发布/回滚。强制本地模式（Cloudreve 未配置）以隔离网络。
vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: {
    create: vi.fn().mockRejectedValue(new Error('cloudreve not configured')),
  },
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: vi.fn().mockResolvedValue(null),
  deleteCloudreveFile: vi.fn().mockResolvedValue(undefined),
}));

async function loadModule(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return import('@/lib/sessionPersistence');
}

const session = { id: 'sess-1', userId: 'user-1' };

describe('sessionPersistence 临时对象 + CAS 发布/回滚 (P0-6)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-persist-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function localPathOf(reference: string): string {
    // reference 形如 local:recordings/{fileName}
    const rel = reference.slice('local:'.length);
    return path.join(tmpDir, 'data', rel);
  }

  it('stage 写版本化对象（唯一名，绝不覆盖旧固定 key），reference 指向该对象', async () => {
    const mod = await loadModule(tmpDir);
    const staged = await mod.stageArtifact(session, 'recordings', Buffer.from('NEW'), {
      mimeType: 'audio/webm',
    });
    expect(staged.storage).toBe('local');
    expect(staged.reference).toMatch(/^local:recordings\/sess-1-.+\.webm$/);
    // 版本化对象已落盘。
    await expect(fs.readFile(localPathOf(staged.reference), 'utf-8')).resolves.toBe('NEW');
  });

  it('CAS 失败回滚：删掉刚写的版本化对象，绝不触碰旧 artifact', async () => {
    const mod = await loadModule(tmpDir);
    // 预置一条「旧的已定稿录音」。
    await fs.mkdir(path.join(tmpDir, 'data', 'recordings'), { recursive: true });
    const prevRef = 'local:recordings/sess-1.webm';
    await fs.writeFile(localPathOf(prevRef), 'OLD-FINAL');

    const staged = await mod.stageSessionAudioArtifact(
      { ...session, recordingPath: prevRef },
      Buffer.from('NEW-STAGED'),
      'audio/webm'
    );
    // stage 后旧文件仍在（append-only，未覆盖）。
    await expect(fs.readFile(localPathOf(prevRef), 'utf-8')).resolves.toBe('OLD-FINAL');

    await mod.rollbackStagedArtifact(session, staged);

    // 回滚删掉版本化临时对象……
    await expect(fs.access(localPathOf(staged.reference))).rejects.toBeTruthy();
    // ……旧 artifact 原封不动（旧代码会在 CAS 前就把它覆盖/删除）。
    await expect(fs.readFile(localPathOf(prevRef), 'utf-8')).resolves.toBe('OLD-FINAL');
  });

  it('CAS 成功发布：删旧 previousReference，版本化对象成为最终录音', async () => {
    const mod = await loadModule(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data', 'recordings'), { recursive: true });
    const prevRef = 'local:recordings/sess-1-old.webm';
    await fs.writeFile(localPathOf(prevRef), 'OLD-FINAL');

    const staged = await mod.stageSessionAudioArtifact(
      { ...session, recordingPath: prevRef },
      Buffer.from('NEW-STAGED'),
      'audio/webm'
    );
    const result = await mod.finalizeStagedArtifactPublish(session, staged);

    expect(result.path).toBe(staged.reference);
    // 旧文件被删除（发布后清理孤儿）。
    await expect(fs.access(localPathOf(prevRef))).rejects.toBeTruthy();
    // 新录音仍在。
    await expect(fs.readFile(localPathOf(staged.reference), 'utf-8')).resolves.toBe('NEW-STAGED');
  });
});
