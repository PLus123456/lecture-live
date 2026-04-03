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
