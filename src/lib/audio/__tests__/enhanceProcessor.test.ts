import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 音频增强调度状态机单测：mock prisma + worker 客户端，逐分支验证
 * claim 竞争 / 派发 / 429 让位 / 对账（成功收割、失败退避、404 回炉、超时）/ 自动重试。
 */

const {
  prismaMock,
  workerMock,
  persistenceMock,
} = vi.hoisted(() => {
  const prismaMock = {
    jobQueue: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  };
  const workerMock = {
    getEnhanceFleetConfig: vi.fn(),
    pingEnhanceWorker: vi.fn(),
    uploadEnhanceInput: vi.fn(),
    startEnhanceJob: vi.fn(),
    getEnhanceJob: vi.fn(),
    downloadEnhanceOutput: vi.fn(),
    deleteEnhanceJob: vi.fn(),
  };
  const persistenceMock = {
    loadSessionAudioArtifact: vi.fn(),
    stageArtifact: vi.fn(),
    finalizeStagedArtifactPublish: vi.fn(),
    rollbackStagedArtifact: vi.fn(),
  };
  return { prismaMock, workerMock, persistenceMock };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

vi.mock('@/lib/audio/enhanceWorkerClient', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/audio/enhanceWorkerClient')
  >();
  return {
    ...original, // EnhanceWorkerError / workerConfigFor / parseWorkerUrls 用真实现
    getEnhanceFleetConfig: workerMock.getEnhanceFleetConfig,
    pingEnhanceWorker: workerMock.pingEnhanceWorker,
    uploadEnhanceInput: workerMock.uploadEnhanceInput,
    startEnhanceJob: workerMock.startEnhanceJob,
    getEnhanceJob: workerMock.getEnhanceJob,
    downloadEnhanceOutput: workerMock.downloadEnhanceOutput,
    deleteEnhanceJob: workerMock.deleteEnhanceJob,
  };
});

vi.mock('@/lib/sessionPersistence', () => persistenceMock);

import { EnhanceWorkerError } from '@/lib/audio/enhanceWorkerClient';
import {
  enqueueAudioEnhance,
  runAudioEnhanceTick,
} from '@/lib/audio/enhanceProcessor';

const WORKER_URL = 'https://enhance.test';
const FLEET = {
  workerUrls: [WORKER_URL],
  token: 't'.repeat(32),
  targetLufs: -14,
  attenLimDb: 30,
  concurrency: 1,
};
/** PROCESSING 任务的绑定 params（对账分支要求有效绑定，否则直接回炉） */
const BOUND_PARAMS = JSON.stringify({ workerUrl: WORKER_URL });

const SESSION = {
  id: 'sess-1',
  userId: 'user-1',
  recordingPath: '/user-1/recordings/sess-1-abc.webm',
  transcriptPath: null,
  summaryPath: null,
  enhancedAudioPath: null,
  audioEnhanceStatus: 'pending',
  durationMs: 60_000,
};

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: 'audio_enhance',
    status: 'SUBMITTED',
    sessionId: 'sess-1',
    userId: 'user-1',
    params: null,
    attempt: 1,
    maxAttempts: 3,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认空世界：没有任务、claim 都成功
  workerMock.getEnhanceFleetConfig.mockResolvedValue(FLEET);
  workerMock.pingEnhanceWorker.mockResolvedValue({
    ok: true,
    engines: { ffmpeg: true, deepFilter: true },
    queue: { running: 0, queued: 0, capacity: 1, queueLimit: 8 },
  });
  prismaMock.jobQueue.findMany.mockResolvedValue([]);
  prismaMock.jobQueue.count.mockResolvedValue(0);
  prismaMock.jobQueue.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.jobQueue.update.mockResolvedValue({});
  prismaMock.session.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.session.findUnique.mockResolvedValue(SESSION);
  // 被 `.catch(...)` 链式调用的 mock 必须返回 Promise，否则 undefined.catch 抛 TypeError
  workerMock.uploadEnhanceInput.mockResolvedValue(undefined);
  workerMock.startEnhanceJob.mockResolvedValue(undefined);
  workerMock.deleteEnhanceJob.mockResolvedValue(undefined);
  persistenceMock.finalizeStagedArtifactPublish.mockResolvedValue({
    path: 'x',
    storage: 'cloudreve',
  });
  persistenceMock.rollbackStagedArtifact.mockResolvedValue(undefined);
});

describe('enqueueAudioEnhance', () => {
  it('已有在途任务时幂等返回其 id，不重复创建', async () => {
    prismaMock.jobQueue.findFirst.mockResolvedValue({ id: 'existing' });
    const jobId = await enqueueAudioEnhance({ sessionId: 'sess-1', userId: 'user-1' });
    expect(jobId).toBe('existing');
    expect(prismaMock.jobQueue.create).not.toHaveBeenCalled();
  });

  it('新任务：createJob(maxAttempts=3) 并把会话标记 pending', async () => {
    prismaMock.jobQueue.findFirst.mockResolvedValue(null);
    prismaMock.jobQueue.create.mockResolvedValue({ id: 'job-new' });
    const jobId = await enqueueAudioEnhance({ sessionId: 'sess-1', userId: 'user-1' });
    expect(jobId).toBe('job-new');
    expect(prismaMock.jobQueue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'audio_enhance', maxAttempts: 3 }),
      })
    );
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { audioEnhanceStatus: 'pending', audioEnhanceError: null },
      })
    );
  });
});

describe('enqueueAudioEnhance — 手动重试的残留清理', () => {
  it('创建新任务前剥掉同会话 FAILED 残留的 nextRetryAt（防自动复活双跑）', async () => {
    prismaMock.jobQueue.findFirst.mockResolvedValue(null);
    prismaMock.jobQueue.findMany.mockResolvedValueOnce([
      {
        id: 'old-failed',
        params: JSON.stringify({
          workerUrl: WORKER_URL,
          nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    ]);
    prismaMock.jobQueue.create.mockResolvedValue({ id: 'job-new' });

    await enqueueAudioEnhance({ sessionId: 'sess-1', userId: 'user-1' });

    const strip = prismaMock.jobQueue.update.mock.calls.find(
      (c) => c[0]?.where?.id === 'old-failed'
    );
    expect(strip).toBeTruthy();
    const written = JSON.parse(strip![0].data.params);
    expect(written.nextRetryAt).toBeUndefined();
    expect(written.workerUrl).toBe(WORKER_URL); // 其它字段保留
  });
});

describe('runAudioEnhanceTick — 派发', () => {
  it('站点未配置 worker 时整轮短路', async () => {
    workerMock.getEnhanceFleetConfig.mockResolvedValue(null);
    await runAudioEnhanceTick();
    expect(prismaMock.jobQueue.findMany).not.toHaveBeenCalled();
  });

  it('正常派发：查 worker(404) → 推 input → start → 会话标记 processing', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([]) // PROCESSING 对账
      .mockResolvedValueOnce([]) // FAILED 自动重试
      .mockResolvedValueOnce([]) // PROCESSING busy 统计（按台并发）
      .mockResolvedValueOnce([jobRow()]); // SUBMITTED 待派发
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));
    persistenceMock.loadSessionAudioArtifact.mockResolvedValue({
      data: Buffer.from([1]),
      contentType: 'audio/webm',
      fileName: 'x.webm',
      path: SESSION.recordingPath,
    });

    await runAudioEnhanceTick();

    // claim：SUBMITTED → PROCESSING
    expect(prismaMock.jobQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'job-1', status: 'SUBMITTED' } })
    );
    expect(workerMock.uploadEnhanceInput).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      expect.any(Buffer),
      'audio/webm'
    );
    expect(workerMock.startEnhanceJob).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      expect.objectContaining({ targetLufs: -14, attenLimDb: 30, outputFormat: 'm4a' })
    );
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { audioEnhanceStatus: 'processing', audioEnhanceError: null },
      })
    );
  });

  it('claim 竞争失败（其它进程抢走）时跳过，不触碰 worker', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    prismaMock.jobQueue.updateMany.mockResolvedValue({ count: 0 }); // claim 失败
    await runAudioEnhanceTick();
    expect(workerMock.uploadEnhanceInput).not.toHaveBeenCalled();
  });

  it('会话已删：终态失败，不重试（nextRetryAt 不写入）', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    prismaMock.session.findUnique.mockResolvedValue(null);
    prismaMock.jobQueue.findUnique.mockResolvedValue(jobRow({ status: 'PROCESSING' }));

    await runAudioEnhanceTick();

    const failUpdate = prismaMock.jobQueue.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'FAILED'
    );
    expect(failUpdate).toBeTruthy();
    expect(failUpdate![0].data.params).toBe(JSON.stringify({}));
  });

  it('worker 队列满（429）：让位回 SUBMITTED，不标失败', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));
    persistenceMock.loadSessionAudioArtifact.mockResolvedValue({
      data: Buffer.from([1]),
      contentType: 'audio/webm',
      fileName: 'x.webm',
      path: SESSION.recordingPath,
    });
    workerMock.uploadEnhanceInput.mockResolvedValue(undefined);
    workerMock.startEnhanceJob.mockRejectedValue(new EnhanceWorkerError('full', 429));

    await runAudioEnhanceTick();

    // 回炉：PROCESSING → SUBMITTED
    expect(prismaMock.jobQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING' },
        data: { status: 'SUBMITTED', startedAt: null },
      })
    );
    expect(prismaMock.jobQueue.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
    );
  });

  it('worker 已在跑（对账发现 running）：只标记会话 processing，不重推', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    workerMock.getEnhanceJob.mockResolvedValue({ status: 'running' });

    await runAudioEnhanceTick();

    expect(workerMock.uploadEnhanceInput).not.toHaveBeenCalled();
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { audioEnhanceStatus: 'processing', audioEnhanceError: null },
      })
    );
  });
});

describe('runAudioEnhanceTick — 确定性 4xx 快速终态', () => {
  it('上传 413：立即终态失败（不写 nextRetryAt），会话标 failed', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));
    persistenceMock.loadSessionAudioArtifact.mockResolvedValue({
      data: Buffer.from([1]),
      contentType: 'audio/webm',
      fileName: 'x.webm',
      path: SESSION.recordingPath,
    });
    workerMock.uploadEnhanceInput.mockRejectedValue(
      new EnhanceWorkerError('worker PUT 失败: HTTP 413 Request Entity Too Large', 413)
    );
    prismaMock.jobQueue.findUnique.mockResolvedValue(
      jobRow({ status: 'PROCESSING', attempt: 1 })
    );

    await runAudioEnhanceTick();

    const failUpdate = prismaMock.jobQueue.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'FAILED'
    );
    expect(failUpdate).toBeTruthy();
    // 确定性失败：不安排自动重试
    expect(JSON.parse(failUpdate![0].data.params).nextRetryAt).toBeUndefined();
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ audioEnhanceStatus: 'failed' }),
      })
    );
  });

  it('上传 503（可自愈）：仍走退避重试（写 nextRetryAt，会话回 pending）', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));
    persistenceMock.loadSessionAudioArtifact.mockResolvedValue({
      data: Buffer.from([1]),
      contentType: 'audio/webm',
      fileName: 'x.webm',
      path: SESSION.recordingPath,
    });
    workerMock.uploadEnhanceInput.mockRejectedValue(
      new EnhanceWorkerError('bad gateway', 503)
    );
    prismaMock.jobQueue.findUnique.mockResolvedValue(
      jobRow({ status: 'PROCESSING', attempt: 1 })
    );

    await runAudioEnhanceTick();

    const failUpdate = prismaMock.jobQueue.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'FAILED'
    );
    expect(failUpdate).toBeTruthy();
    expect(typeof JSON.parse(failUpdate![0].data.params).nextRetryAt).toBe('string');
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { audioEnhanceStatus: 'pending', audioEnhanceError: null },
      })
    );
  });
});

describe('runAudioEnhanceTick — 多 worker 负载均衡', () => {
  it('派发选最空的可达台，并把绑定写进 params', async () => {
    const W1 = 'https://w1.test';
    const W2 = 'https://w2.test';
    workerMock.getEnhanceFleetConfig.mockResolvedValue({
      ...FLEET,
      workerUrls: [W1, W2],
    });
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([]) // PROCESSING 对账
      .mockResolvedValueOnce([]) // FAILED 自动重试
      .mockResolvedValueOnce([]) // PROCESSING busy 统计
      .mockResolvedValueOnce([jobRow()]); // SUBMITTED 待派发
    // 新任务：全 fleet 找回都 404
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));
    // w1 忙（队列 3）、w2 空 → 应选 w2
    workerMock.pingEnhanceWorker.mockImplementation(async (config: { baseUrl: string }) => ({
      ok: true,
      engines: { ffmpeg: true, deepFilter: true },
      queue: {
        running: config.baseUrl === W1 ? 1 : 0,
        queued: config.baseUrl === W1 ? 2 : 0,
        capacity: 1,
        queueLimit: 8,
      },
    }));
    persistenceMock.loadSessionAudioArtifact.mockResolvedValue({
      data: Buffer.from([1]),
      contentType: 'audio/webm',
      fileName: 'x.webm',
      path: SESSION.recordingPath,
    });

    await runAudioEnhanceTick();

    expect(workerMock.uploadEnhanceInput).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: W2 }),
      'job-1',
      expect.any(Buffer),
      'audio/webm'
    );
    // 绑定落库：params.workerUrl = w2
    const bindWrite = prismaMock.jobQueue.update.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0]?.data?.params ?? '{}').workerUrl === W2;
      } catch {
        return false;
      }
    });
    expect(bindWrite).toBeTruthy();
  });

  it('全部 worker 不可达：让位回 SUBMITTED，不标失败不耗 attempt', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([jobRow()]);
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));
    workerMock.pingEnhanceWorker.mockRejectedValue(new Error('ECONNREFUSED'));

    await runAudioEnhanceTick();

    expect(workerMock.uploadEnhanceInput).not.toHaveBeenCalled();
    expect(prismaMock.jobQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING' },
        data: { status: 'SUBMITTED', startedAt: null },
      })
    );
    expect(prismaMock.jobQueue.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
    );
  });

  it('PROCESSING 无有效绑定（升级前旧任务）：回炉重派', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: new Date(), params: null })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAudioEnhanceTick();

    expect(workerMock.getEnhanceJob).not.toHaveBeenCalled();
    expect(prismaMock.jobQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING' },
        data: { status: 'SUBMITTED', startedAt: null },
      })
    );
  });
});

describe('runAudioEnhanceTick — 对账 PROCESSING', () => {
  it('succeeded：下载 → stage → CAS 落库 → publish → SUCCESS → 清 worker', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: new Date(), params: BOUND_PARAMS })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    workerMock.getEnhanceJob.mockResolvedValue({
      status: 'succeeded',
      output: { bytes: 2, format: 'm4a', durationMs: 60_000, denoiseEngine: 'deepfilternet', normalized: true },
    });
    workerMock.downloadEnhanceOutput.mockResolvedValue({
      data: Buffer.from([9, 9]),
      contentType: 'audio/mp4',
    });
    persistenceMock.stageArtifact.mockResolvedValue({
      category: 'recordings',
      reference: '/user-1/recordings/sess-1-enh.mp4',
      localReference: 'local:recordings/sess-1-enh.mp4',
      storage: 'cloudreve',
      previousReference: null,
    });

    await runAudioEnhanceTick();

    expect(persistenceMock.stageArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1' }),
      'recordings',
      expect.any(Buffer),
      expect.objectContaining({ mimeType: 'audio/mp4' })
    );
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          enhancedAudioPath: '/user-1/recordings/sess-1-enh.mp4',
          audioEnhanceStatus: 'completed',
        }),
      })
    );
    expect(persistenceMock.finalizeStagedArtifactPublish).toHaveBeenCalled();
    expect(prismaMock.jobQueue.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) })
    );
    expect(workerMock.deleteEnhanceJob).toHaveBeenCalledWith(expect.anything(), 'job-1');
  });

  it('succeeded 但会话在下载期间被删：回滚 staged 对象并终态失败', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: new Date(), params: BOUND_PARAMS })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    workerMock.getEnhanceJob.mockResolvedValue({ status: 'succeeded', output: {} });
    workerMock.downloadEnhanceOutput.mockResolvedValue({
      data: Buffer.from([9]),
      contentType: 'audio/mp4',
    });
    persistenceMock.stageArtifact.mockResolvedValue({
      category: 'recordings',
      reference: '/user-1/recordings/x.mp4',
      localReference: 'local:recordings/x.mp4',
      storage: 'cloudreve',
      previousReference: null,
    });
    prismaMock.session.updateMany.mockResolvedValue({ count: 0 }); // CAS 失败=会话没了
    prismaMock.jobQueue.findUnique.mockResolvedValue(
      jobRow({ status: 'PROCESSING', attempt: 1, params: BOUND_PARAMS })
    );

    await runAudioEnhanceTick();

    expect(persistenceMock.rollbackStagedArtifact).toHaveBeenCalled();
    expect(persistenceMock.finalizeStagedArtifactPublish).not.toHaveBeenCalled();
  });

  it('failed 且 attempt 未用尽：FAILED + params 写入 nextRetryAt，会话回 pending', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: new Date(), attempt: 1, params: BOUND_PARAMS })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    workerMock.getEnhanceJob.mockResolvedValue({ status: 'failed', error: 'ffmpeg exploded' });
    prismaMock.jobQueue.findUnique.mockResolvedValue(
      jobRow({ status: 'PROCESSING', attempt: 1, params: BOUND_PARAMS })
    );

    await runAudioEnhanceTick();

    const failUpdate = prismaMock.jobQueue.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'FAILED'
    );
    expect(failUpdate).toBeTruthy();
    const params = JSON.parse(failUpdate![0].data.params);
    expect(typeof params.nextRetryAt).toBe('string');
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { audioEnhanceStatus: 'pending', audioEnhanceError: null },
      })
    );
  });

  it('failed 且 attempt 用尽：终态失败，会话标 failed 带错误', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: new Date(), attempt: 3, params: BOUND_PARAMS })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    workerMock.getEnhanceJob.mockResolvedValue({ status: 'failed', error: 'boom' });
    prismaMock.jobQueue.findUnique.mockResolvedValue(
      jobRow({ status: 'PROCESSING', attempt: 3, params: BOUND_PARAMS })
    );

    await runAudioEnhanceTick();

    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audioEnhanceStatus: 'failed',
          audioEnhanceError: 'boom',
        }),
      })
    );
  });

  it('worker 404（重启丢任务）：回炉 SUBMITTED 等下轮重推', async () => {
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: new Date(), params: BOUND_PARAMS })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    workerMock.getEnhanceJob.mockRejectedValue(new EnhanceWorkerError('nf', 404));

    await runAudioEnhanceTick();

    expect(prismaMock.jobQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING' },
        data: { status: 'SUBMITTED', startedAt: null },
      })
    );
  });

  it('queued/running 超时：清 worker 并按可重试失败处理', async () => {
    const stale = new Date(Date.now() - 3 * 60 * 60_000); // 3h 前
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([jobRow({ status: 'PROCESSING', startedAt: stale, attempt: 1, params: BOUND_PARAMS })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    workerMock.getEnhanceJob.mockResolvedValue({ status: 'running' });
    prismaMock.jobQueue.findUnique.mockResolvedValue(
      jobRow({ status: 'PROCESSING', attempt: 1, params: BOUND_PARAMS })
    );

    await runAudioEnhanceTick();

    expect(workerMock.deleteEnhanceJob).toHaveBeenCalled();
    const failUpdate = prismaMock.jobQueue.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'FAILED'
    );
    expect(failUpdate).toBeTruthy();
  });
});

describe('runAudioEnhanceTick — 自动重试', () => {
  it('FAILED 且过了 nextRetryAt：retryJob 回炉（attempt+1 → SUBMITTED）', async () => {
    const failedJob = jobRow({
      status: 'FAILED',
      attempt: 1,
      params: JSON.stringify({ nextRetryAt: new Date(Date.now() - 1000).toISOString() }),
    });
    prismaMock.jobQueue.findMany
      .mockResolvedValueOnce([]) // PROCESSING
      .mockResolvedValueOnce([failedJob]) // FAILED
      .mockResolvedValueOnce([]); // SUBMITTED
    // retryJob 内部：findUnique + update
    prismaMock.jobQueue.findUnique.mockResolvedValue(failedJob);

    await runAudioEnhanceTick();

    expect(prismaMock.jobQueue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'SUBMITTED', attempt: { increment: 1 } }),
      })
    );
  });

  it('未到 nextRetryAt / 无重试标记 / attempt 用尽：一律不回炉', async () => {
    const cases = [
      jobRow({ status: 'FAILED', attempt: 1, params: JSON.stringify({ nextRetryAt: new Date(Date.now() + 60_000).toISOString() }) }),
      jobRow({ status: 'FAILED', attempt: 1, params: null }),
      jobRow({ status: 'FAILED', attempt: 3, params: JSON.stringify({ nextRetryAt: new Date(Date.now() - 1000).toISOString() }) }),
    ];
    for (const failedJob of cases) {
      vi.clearAllMocks();
      workerMock.getEnhanceFleetConfig.mockResolvedValue(FLEET);
  workerMock.pingEnhanceWorker.mockResolvedValue({
    ok: true,
    engines: { ffmpeg: true, deepFilter: true },
    queue: { running: 0, queued: 0, capacity: 1, queueLimit: 8 },
  });
      prismaMock.jobQueue.count.mockResolvedValue(0);
      prismaMock.jobQueue.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([failedJob])
        .mockResolvedValueOnce([]);
      await runAudioEnhanceTick();
      expect(prismaMock.jobQueue.update).not.toHaveBeenCalled();
    }
  });
});
