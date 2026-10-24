import 'server-only';

import { prisma } from '@/lib/prisma';
import { deleteTaskFiles } from '@/lib/translate/taskStorage';

/**
 * 文档翻译任务的 API 层公共件：序列化（剥敏感列）、报价、glossary 校验、
 * 未确认报价的懒清理。路由层组合这些纯件。
 */

/** 任务对前端的序列化形态（proxyTokenHash/workerId 等内部列不出网） */
export interface TranslationTaskView {
  id: string;
  fileName: string;
  fileBytes: number;
  pageCount: number;
  status: string;
  progress: number;
  sourceLang: string;
  targetLang: string;
  /** 本单定格的翻译模型（LlmModel DB id）；null = 跟随全局 TRANSLATION 默认 */
  modelId: string | null;
  estimatedCents: number;
  chargedCents: number;
  refunded: boolean;
  hasMono: boolean;
  hasDual: boolean;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface TaskRowForView {
  id: string;
  fileName: string;
  fileBytes: number;
  pageCount: number;
  status: string;
  progress: number;
  sourceLang: string;
  targetLang: string;
  modelId: string | null;
  estimatedCents: number;
  chargedCents: number;
  refundedAt: Date | null;
  monoPath: string | null;
  dualPath: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export const TASK_VIEW_SELECT = {
  id: true,
  fileName: true,
  fileBytes: true,
  pageCount: true,
  status: true,
  progress: true,
  sourceLang: true,
  targetLang: true,
  modelId: true,
  estimatedCents: true,
  chargedCents: true,
  refundedAt: true,
  monoPath: true,
  dualPath: true,
  errorMessage: true,
  createdAt: true,
  completedAt: true,
} as const;

export function toTaskView(row: TaskRowForView): TranslationTaskView {
  return {
    id: row.id,
    fileName: row.fileName,
    fileBytes: row.fileBytes,
    pageCount: row.pageCount,
    status: row.status,
    progress: row.progress,
    sourceLang: row.sourceLang,
    targetLang: row.targetLang,
    modelId: row.modelId,
    estimatedCents: row.estimatedCents,
    chargedCents: row.chargedCents,
    refunded: Boolean(row.refundedAt),
    hasMono: Boolean(row.monoPath),
    hasDual: Boolean(row.dualPath),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** 报价：页数 × 单价（分）。0 单价 = 免费站点。 */
export function quoteCents(pageCount: number, pricePerPage: number): number {
  return Math.max(0, Math.round(pageCount * Math.max(0, pricePerPage)));
}

/** 清洗前端传来的术语表：[{src,dst}]，每条 ≤100 字符，≤500 条；非法返回 null（= 不用） */
export function sanitizeGlossary(raw: unknown): { src: string; dst: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { src: string; dst: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = typeof (item as { src?: unknown }).src === 'string' ? (item as { src: string }).src.trim() : '';
    const dst = typeof (item as { dst?: unknown }).dst === 'string' ? (item as { dst: string }).dst.trim() : '';
    if (!src || !dst || src.length > 100 || dst.length > 100) continue;
    out.push({ src, dst });
    if (out.length >= 500) break;
  }
  return out.length > 0 ? out : null;
}

/** 未确认报价的保留时长 */
export const QUOTE_TTL_MS = 30 * 60_000;

/**
 * 单用户同时持有的未确认（且未过期）报价上限。每个报价都在本地盘留一份 ≤30MB 的源 PDF、
 * 不计任何存储配额；此前只有「本人下次上传时懒清理 20 条」，一个开通了文档翻译的账号
 * 按限流 60 次/分钟持续上传不确认，30 分钟就能堆出 ~54GB（与录音共用 data/ 盘）。
 */
export const MAX_OUTSTANDING_QUOTES_PER_USER = 10;

/** 全局清扫单轮上限（调度 tick 里跑，每 20s 一轮，足以追平任何上传速率） */
const GLOBAL_QUOTE_SWEEP_BATCH = 50;

async function deleteExpiredQuoteRows(
  rows: ReadonlyArray<{ id: string }>
): Promise<number> {
  let swept = 0;
  for (const row of rows) {
    // 条件删除：并发 confirm 已把它推进 PENDING 时 count=0，文件原样保留。
    const res = await prisma.translationTask
      .deleteMany({ where: { id: row.id, status: 'QUOTED' } })
      .catch(() => ({ count: 0 }));
    if (res.count > 0) {
      swept += 1;
      await deleteTaskFiles(row.id).catch(() => undefined);
    }
  }
  return swept;
}

/**
 * 懒清理该用户超时未确认的 QUOTED 任务（连文件）。上传新文件时顺手调用，
 * 防止反复报价不确认把 data/translations 堆满。
 */
export async function sweepExpiredQuotes(userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - QUOTE_TTL_MS);
  const stale = await prisma.translationTask.findMany({
    where: { userId, status: 'QUOTED', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 20,
  });
  await deleteExpiredQuoteRows(stale);
}

/**
 * 全局清扫所有用户的过期报价（由文档翻译调度 tick 驱动）。只靠「本人下次上传时懒清理」
 * 的话，用户停止上传后剩下的过期报价与源文件会永久留在盘上。
 */
export async function sweepAllExpiredQuotes(
  limit = GLOBAL_QUOTE_SWEEP_BATCH
): Promise<number> {
  const cutoff = new Date(Date.now() - QUOTE_TTL_MS);
  const stale = await prisma.translationTask.findMany({
    where: { status: 'QUOTED', createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  return deleteExpiredQuoteRows(stale);
}

/** 该用户当前持有的未过期、未确认报价数（上传前的数量闸）。 */
export async function countOutstandingQuotes(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - QUOTE_TTL_MS);
  return prisma.translationTask.count({
    where: { userId, status: 'QUOTED', createdAt: { gte: cutoff } },
  });
}

/** 语言代码白名单校验（pdf2zh 的 lang 代码形态：字母/连字符，2-10 位） */
export function sanitizeLangCode(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim();
  return /^[A-Za-z][A-Za-z-]{1,9}$/.test(v) ? v : fallback;
}
