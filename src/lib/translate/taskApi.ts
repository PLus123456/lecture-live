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
const QUOTE_TTL_MS = 30 * 60_000;

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
  for (const row of stale) {
    await prisma.translationTask
      .deleteMany({ where: { id: row.id, status: 'QUOTED' } })
      .then(async (res) => {
        if (res.count > 0) await deleteTaskFiles(row.id);
      })
      .catch(() => undefined);
  }
}

/** 语言代码白名单校验（pdf2zh 的 lang 代码形态：字母/连字符，2-10 位） */
export function sanitizeLangCode(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim();
  return /^[A-Za-z][A-Za-z-]{1,9}$/.test(v) ? v : fallback;
}
