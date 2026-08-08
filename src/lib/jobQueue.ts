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
  AUDIO_ENHANCE: 'audio_enhance',
  DOC_TRANSLATE: 'doc_translate',
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

/**
 * L10：只有这两类任务真的有消费者会去捞 SUBMITTED 行执行
 * （enhanceProcessor.tick / translateProcessor.tick）。其余 10 个 JOB_TYPE 都是
 * trackJob 包在请求内同步跑完的「执行记录」，把行改回 SUBMITTED 之后没有任何调度器
 * 会执行它 —— admin 点「重试」拿到成功提示、任务却永远停在 SUBMITTED，纯误导。
 */
export const RETRYABLE_JOB_TYPES: ReadonlySet<string> = new Set<string>([
  JOB_TYPE.AUDIO_ENHANCE,
  JOB_TYPE.DOC_TRANSLATE,
]);

export function isJobTypeRetryable(type: string): boolean {
  return RETRYABLE_JOB_TYPES.has(type);
}

/**
 * P5-16：「每会话至多一个在途 audio_enhance」的排他键。
 *
 * 原来靠「先 findFirst 有没有 SUBMITTED/PROCESSING，没有再 createJob」这种 check-then-act，
 * 两个并发请求（双击按钮 / finalize 自动入队撞上用户手动触发）会各自查到空、各建一行，
 * 同一份录音被两台 worker 同时增强 + 两次回存互相覆盖。
 *
 * 改用 JobQueue.activeKey 的唯一索引：非终态期间持键，落终态（SUCCESS/FAILED）时置 null。
 * MySQL 允许重复 NULL，所以这个唯一索引等价于部分唯一索引 —— 把 check-then-act 压成
 * 一次插入冲突。
 */
export function audioEnhanceActiveKey(sessionId: string): string {
  return `audio_enhance:${sessionId}`;
}

/** activeKey 已被在途任务占用。让调用方区分「已有在途任务」与「建行失败」。 */
export class ActiveJobConflictError extends Error {
  constructor(readonly activeKey: string) {
    super(`Active job already exists for ${activeKey}`);
    this.name = 'ActiveJobConflictError';
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

// ─── 创建任务 ───
interface CreateJobOptions {
  type: JobType;
  sessionId?: string;
  userId?: string;
  triggeredBy?: string;
  params?: Record<string, unknown>;
  maxAttempts?: number;
  /** 排他键：同一 key 同时只允许一个非终态任务。冲突时抛 ActiveJobConflictError。 */
  activeKey?: string;
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
        activeKey: options.activeKey ?? null,
      },
    });
    return job.id;
  } catch (error) {
    // P5-16：排他键冲突不是"建行失败"，而是"已有在途任务"，必须让调用方能分辨。
    if (options.activeKey && isUniqueConstraintError(error)) {
      throw new ActiveJobConflictError(options.activeKey);
    }
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
        // P5-16：落终态即释放排他键（重复 NULL 不受唯一索引约束）。
        activeKey: null,
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
        activeKey: null,
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
  // L10：无消费者的类型不能假装重试成功（见 RETRYABLE_JOB_TYPES）。
  if (!isJobTypeRetryable(job.type)) return false;
  if (job.status !== JOB_STATUS.FAILED) return false;
  if (job.attempt >= job.maxAttempts && job.maxAttempts > 1) return false;

  // P5-16：回炉即重新进入非终态，必须把 activeKey 拿回来（落终态时已被释放为 null），
  // 否则回炉后的 SUBMITTED 行不持键，并发入队会给同一会话再建一行。
  // 若此时该会话已有另一个在途任务持键 → P2002 → 本次重试直接判失败（语义正确：
  // 同会话已在处理中，不该再复活一个旧任务）。
  const reacquire =
    job.activeKey === null &&
    job.type === JOB_TYPE.AUDIO_ENHANCE &&
    job.sessionId
      ? { activeKey: audioEnhanceActiveKey(job.sessionId) }
      : {};

  try {
    await prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.SUBMITTED,
        attempt: { increment: 1 },
        error: null,
        result: null,
        startedAt: null,
        completedAt: null,
        ...reacquire,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return false;
    throw error;
  }

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
      // P5-16：僵尸回收是排他键的安全阀 —— 不释放的话该会话再也入不了队。
      activeKey: null,
    },
  });
  return result.count;
}
