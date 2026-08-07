import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P5-18 回归：完整版补全转录在 CAS 抢不到时只删了 Soniox **file**，泄漏 transcription。
 *
 * 走到那一步时 fullSonioxFileId / fullSonioxTranscriptionId 都还没写进 DB（正是这条 CAS 要写的），
 * 所以漏掉的 transcription 是谁都查不到的孤儿：回收 cron 只按 DB 里的 ID 去删。对照
 * asyncUploadProcessor 的同一处（两个都删）。
 */
const {
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  loadAudioMock,
  probeDurationMock,
  uploadSonioxFileMock,
  createTranscriptionMock,
  deleteSonioxFileMock,
  deleteSonioxTranscriptionMock,
  settleFullMock,
  resolveRegionMock,
} = vi.hoisted(() => ({
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  loadAudioMock: vi.fn(),
  probeDurationMock: vi.fn(),
  uploadSonioxFileMock: vi.fn(),
  createTranscriptionMock: vi.fn(),
  deleteSonioxFileMock: vi.fn(),
  deleteSonioxTranscriptionMock: vi.fn(),
  settleFullMock: vi.fn(),
  resolveRegionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findUnique: sessionFindUniqueMock, updateMany: sessionUpdateManyMock },
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(() => Promise.resolve(undefined)),
    writeFile: vi.fn(() => Promise.resolve(undefined)),
    rm: vi.fn(() => Promise.resolve(undefined)),
  },
}));
vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  probeDurationSec: probeDurationMock,
  transcodeToMp3: vi.fn(() => Promise.resolve(undefined)),
  validateMediaContainer: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionAudioArtifact: loadAudioMock,
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveAndPersistTaskRegion: resolveRegionMock,
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  uploadSonioxFile: uploadSonioxFileMock,
  createSonioxTranscription: createTranscriptionMock,
  deleteSonioxFile: deleteSonioxFileMock,
  deleteSonioxTranscription: deleteSonioxTranscriptionMock,
}));
vi.mock('@/lib/quota', () => ({ settleFullReservation: settleFullMock }));

import { processFullTranscribe } from '@/lib/audio/fullTranscribeProcessor';

const CONFIG = { region: 'eu', restBaseUrl: 'https://x', apiKey: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  sessionFindUniqueMock.mockResolvedValue({
    id: 's1',
    userId: 'u1',
    sourceLang: 'en',
    targetLang: 'zh',
    sonioxRegion: 'eu',
  });
  loadAudioMock.mockResolvedValue({ data: Buffer.from('audio'), fileName: 'in.webm' });
  probeDurationMock.mockResolvedValue(120);
  resolveRegionMock.mockResolvedValue(CONFIG);
  uploadSonioxFileMock.mockResolvedValue({ id: 'file-1' });
  createTranscriptionMock.mockResolvedValue({ id: 'job-1' });
  deleteSonioxFileMock.mockResolvedValue(true);
  deleteSonioxTranscriptionMock.mockResolvedValue(true);
  settleFullMock.mockResolvedValue(0);
  sessionUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe('processFullTranscribe Soniox 资源清理 (P5-18)', () => {
  it('▶ 负向（核心）：transcribing CAS 抢不到 → transcription 与 file **都**要删，且先 transcription 后 file', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // pending → transcoding
      .mockResolvedValueOnce({ count: 0 }); // transcoding → transcribing 抢不到（被取消/重置）

    await expect(processFullTranscribe('s1')).resolves.toBeUndefined();

    // 旧实现只删 file，把已创建的 transcription 留成 DB 里没有 ID 的永久孤儿。
    expect(deleteSonioxTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'job-1');
    expect(deleteSonioxFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    expect(
      deleteSonioxTranscriptionMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteSonioxFileMock.mock.invocationCallOrder[0]);
  });

  it('▶ 负向：建完 transcription 后的非 halt 异常（CAS 抛错）同样两个都清', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // pending → transcoding
      .mockRejectedValueOnce(new Error('db down')) // transcribing CAS 抛错
      .mockResolvedValue({ count: 1 }); // 标 failed

    await expect(processFullTranscribe('s1')).resolves.toBeUndefined();

    expect(deleteSonioxTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'job-1');
    expect(deleteSonioxFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    // 抢到 failed 终态 → 释放入口预留（R4 既有行为，不能被本次改动破坏）
    expect(settleFullMock).toHaveBeenCalledWith('s1');
  });

  it('正常路径：CAS 抢到 → 不删任何 Soniox 资源（转录还要跑）', async () => {
    await expect(processFullTranscribe('s1')).resolves.toBeUndefined();

    expect(deleteSonioxTranscriptionMock).not.toHaveBeenCalled();
    expect(deleteSonioxFileMock).not.toHaveBeenCalled();
    // CAS 写入两个 Soniox 引用
    const casCall = sessionUpdateManyMock.mock.calls[1][0];
    expect(casCall.data).toMatchObject({
      fullTranscribeStatus: 'transcribing',
      fullSonioxFileId: 'file-1',
      fullSonioxTranscriptionId: 'job-1',
    });
  });
});
