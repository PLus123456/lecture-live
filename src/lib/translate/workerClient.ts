import 'server-only';

import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getSiteSettings } from '@/lib/siteSettings';

/**
 * 文档翻译 worker（独立机器上的 pdf2zh-next wrapper）的 HTTP 客户端。
 * 协议契约见主仓库根 TRANSLATION_WORKER_PROTOCOL.md（wrapper 在独立仓库照此实现）。
 *
 * 端点（全部 Bearer token 鉴权，语义与 audio-enhance-worker 同构）：
 *   GET    {base}/healthz                 探活（带鉴权返回 version/queue/engine）
 *   PUT    {base}/jobs/:id/input          上传源 PDF
 *   POST   {base}/jobs/:id/start          入队翻译（JSON 参数，含 LLM 代理配置）
 *   GET    {base}/jobs/:id                查询状态/进度
 *   GET    {base}/jobs/:id/output/mono    下载译文单语 PDF
 *   GET    {base}/jobs/:id/output/dual    下载双语对照 PDF
 *   DELETE {base}/jobs/:id                清理（幂等）
 *
 * 与音频增强的关键差异：worker 集群配置来自 TranslationWorker 表（一机一行一套设置，
 * token 每台独立加密存储），而非 SiteSetting 单键。worker 完全被动可随时重启，
 * 重试/重派由 translateProcessor 状态机对账驱动。
 */

const CONTROL_TIMEOUT_MS = 30_000;
// 论文级 PDF 通常 <50MB，传输给 10 分钟余量
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** 单台 worker 的连接配置（token 已解密） */
export interface TranslateWorkerConfig {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  concurrency: number;
  weight: number;
  qps: number;
}

/** 集群配置：enabled 的全部 worker 行（保持 sortOrder 顺序） */
export interface TranslateFleetConfig {
  workers: TranslateWorkerConfig[];
  /** 站点级参数（报价/上限在 API 层用，这里带上 watermark 供派发组参数） */
  watermark: boolean;
}

/** worker 侧 start 的任务参数（协议契约；wrapper 按此驱动 pdf2zh_next） */
export interface TranslateJobParams {
  langIn: string;
  langOut: string;
  /** pdf2zh --qps（该台对 LLM 后端的每秒请求上限，来自 worker 行配置） */
  qps: number;
  /** false（默认）→ 交付无水印产物；true → 保留 pdf2zh 水印 */
  watermark: boolean;
  /** 术语表（转成 pdf2zh glossary CSV 喂给 CLI）；null/空 = 不用 */
  glossary: { src: string; dst: string }[] | null;
  /** LLM 走主应用 OpenAI 兼容代理（OpenAICompatible 后端）：所有 token 消耗回流网关计量 */
  llm: {
    /** 形如 https://主应用/api/translate/llm-proxy/v1 */
    baseUrl: string;
    /** 任务级代理凭据（只对该任务有效，任务终态即失效） */
    apiKey: string;
    /** 透传给 pdf2zh 的模型名占位（代理端点服务端强制真实路由，不信任此值） */
    model: string;
  };
}

export interface TranslateJobStatus {
  jobId: string;
  status: 'created' | 'queued' | 'running' | 'succeeded' | 'failed';
  /** pdf2zh 阶段名（解析/翻译/排版…），仅展示 */
  stage: string | null;
  /** 0-100 整体进度 */
  progress: number;
  error: string | null;
  output: {
    monoBytes?: number;
    dualBytes?: number;
    totalSeconds?: number;
  } | null;
}

export interface TranslateWorkerHealth {
  ok: boolean;
  version?: string;
  queue?: { running: number; queued: number; capacity: number; queueLimit: number };
  engine?: { pdf2zh?: string };
}

/** worker 返回非 2xx 时抛出；status 供调用方区分 404（任务丢失）/429（队列满）等语义 */
export class TranslateWorkerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'TranslateWorkerError';
  }
}

/**
 * 读 TranslationWorker 表组装集群配置。文档翻译未启用 / 无可用 worker 返回 null。
 * token 逐台解密；解密失败（密钥轮换后遗留）的台跳过并在行上记 lastError，不拖垮整个集群。
 */
export async function getTranslateFleetConfig(): Promise<TranslateFleetConfig | null> {
  const settings = await getSiteSettings();
  if (!settings.translation_doc_enabled) return null;

  const rows = await prisma.translationWorker.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const workers: TranslateWorkerConfig[] = [];
  for (const row of rows) {
    let token = '';
    try {
      token = decrypt(row.token);
    } catch {
      token = '';
    }
    if (!token || !row.baseUrl) {
      // 配置残缺的台标记出来（best effort），选台时跳过
      prisma.translationWorker
        .update({
          where: { id: row.id },
          data: { status: 'FAILED', lastError: 'token 解密失败或 baseUrl 为空' },
        })
        .catch(() => {});
      continue;
    }
    workers.push({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl.replace(/\/+$/, ''),
      token,
      concurrency: Math.max(1, row.concurrency),
      weight: Math.max(1, row.weight),
      qps: Math.max(1, row.qps),
    });
  }
  if (workers.length === 0) return null;
  return { workers, watermark: settings.translation_doc_watermark };
}

function authHeaders(config: Pick<TranslateWorkerConfig, 'token'>): Record<string, string> {
  return { Authorization: `Bearer ${config.token}` };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const plain = /<\s*html/i.test(text)
      ? text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      : text;
    return plain.slice(0, 300);
  } catch {
    return '';
  }
}

async function requestJson<T>(
  config: Pick<TranslateWorkerConfig, 'baseUrl' | 'token'>,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(config), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(init?.timeoutMs ?? CONTROL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new TranslateWorkerError(
      `worker ${init?.method ?? 'GET'} ${path} 失败: HTTP ${res.status} ${await readErrorBody(res)}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

/** 探活 + 队列详情（admin「测试连接」与派发前选台共用） */
export async function pingTranslateWorker(
  config: Pick<TranslateWorkerConfig, 'baseUrl' | 'token'>,
  options?: { timeoutMs?: number }
): Promise<TranslateWorkerHealth> {
  return requestJson<TranslateWorkerHealth>(config, '/healthz', {
    timeoutMs: options?.timeoutMs ?? 10_000,
  });
}

/** 上传源 PDF（整包 Buffer；文档 ≤30MB，一次传输） */
export async function uploadTranslateInput(
  config: TranslateWorkerConfig,
  jobId: string,
  data: Buffer
): Promise<void> {
  await requestJson<{ received: number }>(config, `/jobs/${encodeURIComponent(jobId)}/input`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: new Uint8Array(data),
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
}

/** 入队开始翻译。worker 队列满抛 TranslateWorkerError(status=429)，调用方留待下轮 */
export async function startTranslateJob(
  config: TranslateWorkerConfig,
  jobId: string,
  params: TranslateJobParams
): Promise<void> {
  await requestJson<{ status: string }>(config, `/jobs/${encodeURIComponent(jobId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

/** 查询任务状态；任务不存在（worker 重启丢失/已清理）抛 status=404 */
export async function getTranslateJob(
  config: TranslateWorkerConfig,
  jobId: string
): Promise<TranslateJobStatus> {
  return requestJson<TranslateJobStatus>(config, `/jobs/${encodeURIComponent(jobId)}`);
}

/** 下载产物 PDF（variant: mono=单语 / dual=双语对照） */
export async function downloadTranslateOutput(
  config: TranslateWorkerConfig,
  jobId: string,
  variant: 'mono' | 'dual'
): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetch(
    `${config.baseUrl}/jobs/${encodeURIComponent(jobId)}/output/${variant}`,
    {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new TranslateWorkerError(
      `worker 下载 ${variant} 产物失败: HTTP ${res.status} ${await readErrorBody(res)}`,
      res.status
    );
  }
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType: res.headers.get('content-type') ?? 'application/pdf' };
}

/** best-effort 清理 worker 侧任务目录；404 视为已清理 */
export async function deleteTranslateJob(
  config: TranslateWorkerConfig,
  jobId: string
): Promise<void> {
  const res = await fetch(`${config.baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: authHeaders(config),
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    throw new TranslateWorkerError(`worker 清理任务失败: HTTP ${res.status}`, res.status);
  }
}

/**
 * 探测单台 worker 并把结果落库（status/lastCheckedAt/lastError）——admin verify 与
 * 调度健康检查共用，让「翻译服务」面板的健康灯反映最近一次真实探测。
 */
export async function verifyAndRecordWorker(
  config: Pick<TranslateWorkerConfig, 'id' | 'baseUrl' | 'token'>
): Promise<TranslateWorkerHealth | null> {
  try {
    const health = await pingTranslateWorker(config);
    await prisma.translationWorker.update({
      where: { id: config.id },
      data: {
        status: health.ok ? 'OK' : 'FAILED',
        lastCheckedAt: new Date(),
        lastError: health.ok ? null : 'healthz 返回 ok=false',
      },
    });
    return health;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.translationWorker
      .update({
        where: { id: config.id },
        data: { status: 'FAILED', lastCheckedAt: new Date(), lastError: message.slice(0, 500) },
      })
      .catch(() => {});
    return null;
  }
}
