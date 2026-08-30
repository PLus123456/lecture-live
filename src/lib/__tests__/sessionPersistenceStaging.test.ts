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
  deleteCloudreveFile: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (callback) => callback({})),
  },
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: {
    ACTIVE: 'ACTIVE',
    RESERVED: 'RESERVED',
  },
  STORED_ARTIFACT_TYPE: {
    RECORDING: 'recording',
    ENHANCED_AUDIO: 'enhanced_audio',
    TRANSCRIPT: 'transcript',
    SUMMARY: 'summary',
    REPORT: 'report',
    FULL_TRANSCRIPT: 'full_transcript',
  },
  reserveStoredArtifact: vi.fn(async () => ({
    id: 'artifact-test',
    userId: 'user-1',
    logicalKey: 'logical-test',
    expectedBytes: BigInt(0),
    state: 'RESERVED',
    reservationKey: 'reservation-test',
  })),
  recordReservedStoredArtifactLocation: vi.fn(async () => undefined),
  settleStoredArtifact: vi.fn(async () => ({ artifact: {}, previous: null })),
  settleStoredArtifactInTransaction: vi.fn(async () => ({
    artifact: {},
    previous: null,
  })),
  rollbackStoredArtifact: vi.fn(async () => true),
  markStoredArtifactOrphan: vi.fn(async () => undefined),
  releaseStoredArtifact: vi.fn(async () => true),
  findBillableStoredArtifactsByOwner: vi.fn(async () => []),
  getStoredArtifactById: vi.fn(async () => null),
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
    vi.clearAllMocks();
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

  it('转录已 stage 但摘要预留失败时，回滚首个物理对象和账本行', async () => {
    const mod = await loadModule(tmpDir);
    const ledger = await import('@/lib/storage/storedArtifactLedger');
    vi.mocked(ledger.reserveStoredArtifact)
      .mockResolvedValueOnce({
        id: 'artifact-transcript',
        userId: 'user-1',
        logicalKey: 'logical-transcript',
        expectedBytes: BigInt(2),
        state: 'RESERVED',
        reservationKey: 'reservation-transcript',
        replacesArtifactId: null,
      })
      .mockRejectedValueOnce(new Error('summary quota rejected'));

    await expect(
      mod.stageSessionTranscriptArtifacts(session, {
        segments: [],
        summaries: [],
        translations: {},
      })
    ).rejects.toThrow('summary quota rejected');

    expect(ledger.rollbackStoredArtifact).toHaveBeenCalledWith(
      'artifact-transcript'
    );
    const transcriptDir = path.join(tmpDir, 'data', 'transcripts');
    await expect(fs.readdir(transcriptDir)).resolves.toEqual([]);
  });

  it('事务 ACK 丢失时仅在 owner 与 ACTIVE ledger 都精确匹配后判定已提交', async () => {
    const mod = await loadModule(tmpDir);
    const ledger = await import('@/lib/storage/storedArtifactLedger');
    const staged = {
      category: 'recordings' as const,
      reference: 'local:recordings/sess-1-generation.webm',
      localReference: 'local:recordings/sess-1-generation.webm',
      storage: 'local' as const,
      storedArtifactId: 'artifact-generation',
      expectedPreviousArtifactId: null,
      actualBytes: 3,
      artifactType: 'recording' as const,
    };
    vi.mocked(ledger.getStoredArtifactById).mockResolvedValueOnce({
      id: staged.storedArtifactId,
      userId: 'user-1',
      ownerType: 'session',
      ownerId: 'sess-1',
      conversationId: null,
      sessionId: 'sess-1',
      artifactType: 'recording',
      storage: 'local',
      reference: staged.reference,
      state: 'ACTIVE',
      bytes: BigInt(3),
      chargedBytes: BigInt(3),
      reservationKey: 'reservation-generation',
      logicalKey: 'logical-generation',
      identityKey: 'logical-generation',
      replacesArtifactId: null,
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      mod.readbackStagedArtifactPublication([staged], [staged.reference])
    ).resolves.toMatchObject({ outcome: 'committed' });
  });

  it('只在 owner 未发布且 ledger 仍为 RESERVED 时判定可安全回滚', async () => {
    const mod = await loadModule(tmpDir);
    const ledger = await import('@/lib/storage/storedArtifactLedger');
    const staged = {
      category: 'recordings' as const,
      reference: 'local:recordings/sess-1-generation.webm',
      localReference: 'local:recordings/sess-1-generation.webm',
      storage: 'local' as const,
      storedArtifactId: 'artifact-generation',
      expectedPreviousArtifactId: null,
      actualBytes: 3,
      artifactType: 'recording' as const,
    };
    vi.mocked(ledger.getStoredArtifactById).mockResolvedValueOnce({
      id: staged.storedArtifactId,
      userId: 'user-1',
      ownerType: 'session',
      ownerId: 'sess-1',
      conversationId: null,
      sessionId: 'sess-1',
      artifactType: 'recording',
      storage: 'local',
      reference: staged.reference,
      state: 'RESERVED',
      bytes: BigInt(3),
      chargedBytes: BigInt(3),
      reservationKey: 'reservation-generation',
      logicalKey: 'logical-generation',
      identityKey: null,
      replacesArtifactId: null,
      expiresAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      mod.readbackStagedArtifactPublication([staged], ['local:recordings/old.webm'])
    ).resolves.toEqual({ outcome: 'not_committed', publications: [] });
  });
});
