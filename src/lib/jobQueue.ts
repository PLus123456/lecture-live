import { prisma } from '@/lib/prisma';

// ─── 任务类型常量 ───
export const JOB_TYPE = {
  KEYWORD_EXTRACTION: 'keyword_extraction',
  REPORT_GENERATION: 'report_generation',
  QUOTA_RESET: 'quota_reset',
  STALE_SESSION_RECLAIM: 'stale_session_reclaim',
  RECONCILIATION: 'reconciliation',
  STORAGE_CLEANUP: 'storage_cleanup',
  STORAGE_MIGRATION: 'storage_migration',
  BILLING_MAINTENANCE: 'billing_maintenance',
  TITLE_GENERATION: 'title_generation',
  CHAT_FILES_CLEANUP: 'chat_files_cleanup',
} as const;

export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

// ─── 状态常量 ───
export const JOB_STATUS = {
  SUBMITTED: 'SUBMITTED',
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

// ─── 创建任务 ───
interface CreateJobOptions {
  type: JobType;
  sessionId?: string;
  userId?: string;
  triggeredBy?: string;
  params?: Record<string, unknown>;
  maxAttempts?: number;
}

export async function createJob(options: CreateJobOptions): Promise<string> {
  try {
    const job = await prisma.jobQueue.create({
      data: {
        type: options.type,
        status: JOB_STATUS.SUBMITTED,
        sessionId: options.sessionId ?? null,
        userId: options.userId ?? null,
        triggeredBy: options.triggeredBy ?? 'system',
        params: options.params ? JSON.stringify(options.params) : null,
        maxAttempts: options.maxAttempts ?? 1,
      },
    });
    return job.id;
  } catch (error) {
    console.error('[jobQueue] createJob failed:', error);
    return '';
  }
}

// ─── 状态更新（fire-and-forget） ───
export function markJobProcessing(jobId: string): void {
  if (!jobId) return;
  prisma.jobQueue
    .update({
      where: { id: jobId },
      data: { status: JOB_STATUS.PROCESSING, startedAt: new Date() },
    })
    .catch((err) => console.error('[jobQueue] markProcessing failed:', err));
}

export function markJobSuccess(
  jobId: string,
  result?: Record<string, unknown>
): void {
  if (!jobId) return;
  prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: result ? JSON.stringify(result) : null,
        completedAt: new Date(),
      },
    })
    .catch((err) => console.error('[jobQueue] markSuccess failed:', err));
}

export function markJobFailed(jobId: string, error: unknown): void {
  if (!jobId) return;
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.FAILED,
        error: message,
        completedAt: new Date(),
      },
    })
    .catch((err) => console.error('[jobQueue] markFailed failed:', err));
}

// ─── trackJob: 自动包装异步函数 ───
interface TrackJobOptions {
  type: JobType;
  sessionId?: string;
  userId?: string;
  triggeredBy?: string;
  params?: Record<string, unknown>;
  maxAttempts?: number;
}

export async function trackJob<T>(
  options: TrackJobOptions,
  fn: () => Promise<T>
): Promise<T> {
  const jobId = await createJob(options);
  if (jobId) markJobProcessing(jobId);

  try {
    const result = await fn();
    if (jobId) {
      const serializable =
        result && typeof result === 'object'
          ? (result as Record<string, unknown>)
          : { value: result };
      markJobSuccess(jobId, serializable);
    }
    return result;
  } catch (error) {
    if (jobId) markJobFailed(jobId, error);
    throw error;
  }
}

// ─── 查询任务列表（Admin API 用） ───
interface QueryJobsFilters {
  type?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export async function queryJobs(filters: QueryJobsFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {};
  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = filters.status;

  const [jobs, total] = await Promise.all([
    prisma.jobQueue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.jobQueue.count({ where }),
  ]);

  return {
    jobs,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

// ─── 重试失败任务 ───
export async function retryJob(jobId: string): Promise<boolean> {
  const job = await prisma.jobQueue.findUnique({ where: { id: jobId } });
  if (!job) return false;
  if (job.status !== JOB_STATUS.FAILED) return false;
  if (job.attempt >= job.maxAttempts && job.maxAttempts > 1) return false;

  await prisma.jobQueue.update({
    where: { id: jobId },
    data: {
      status: JOB_STATUS.SUBMITTED,
      attempt: { increment: 1 },
      error: null,
      result: null,
      startedAt: null,
      completedAt: null,
    },
  });

  return true;
}

// ─── 僵尸任务回收：PROCESSING 卡死超时标失败 ───
// trackJob 在请求内执行、markJob* 是 fire-and-forget；进程被部署 / OOM kill 时，
// 任务会永久卡在 PROCESSING（startedAt 已设、completedAt 始终为空），前端指示器一直转圈，
// 且 retryJob 只能重试 FAILED。这里把超时的 PROCESSING 任务原子标为 FAILED，
// 让状态机解锁、前端停转、并可被 retryJob 重试。
// 阈值取足够大的值（默认 2 小时）：远大于任何单个任务的正常耗时（报告生成 / 对账 / 清理
// 等最重的任务也在分钟级），避免误杀正在执行的任务（含 billing maintenance 自身）。
export const STALE_PROCESSING_JOB_THRESHOLD_MS = 2 * 60 * 60_000;

export async function reclaimStaleProcessingJobs(
  now: Date = new Date(),
  thresholdMs: number = STALE_PROCESSING_JOB_THRESHOLD_MS
): Promise<number> {
  const threshold = new Date(now.getTime() - thresholdMs);
  const thresholdHours = Math.round(thresholdMs / 3_600_000);
  // PROCESSING 必然已由 markJobProcessing 写过 startedAt（status 与 startedAt 同一次 update 落库），
  // 故以 startedAt 为超时判据；条件原子更新，避免与正常的 markJobSuccess/Failed 竞争。
  const result = await prisma.jobQueue.updateMany({
    where: {
      status: JOB_STATUS.PROCESSING,
      startedAt: { lte: threshold },
    },
    data: {
      status: JOB_STATUS.FAILED,
      error: `自动回收：任务卡在 PROCESSING 超过 ${thresholdHours} 小时（疑似进程中断）`,
      completedAt: now,
    },
  });
  return result.count;
}
