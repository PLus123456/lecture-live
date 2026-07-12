import 'server-only';

import { getSiteSettings } from '@/lib/siteSettings';

/**
 * 音频增强 worker（worker/audio-enhance-worker.mjs，部署在独立机器）的 HTTP 客户端。
 *
 * 协议（全部 Bearer token 鉴权）：
 *   GET    {base}/healthz            探活（带鉴权时返回引擎/队列详情）
 *   PUT    {base}/jobs/:id/input     上传原始音频
 *   POST   {base}/jobs/:id/start     入队处理（JSON 参数）
 *   GET    {base}/jobs/:id           查询状态
 *   GET    {base}/jobs/:id/output    下载结果
 *   DELETE {base}/jobs/:id           清理（幂等）
 *
 * worker 是完全被动方、可随时重启：这里所有函数只做单次请求 + 超时，
 * 重试/续传由 enhanceProcessor 的状态机对账驱动（与 soniox/asyncFile 同风格）。
 */

const ENHANCE_CONTROL_TIMEOUT_MS = 30_000;
// 课堂录音可达数百 MB，上传/下载放宽到 15 分钟
const ENHANCE_TRANSFER_TIMEOUT_MS = 15 * 60_000;

export interface EnhanceWorkerConfig {
  baseUrl: string;
  token: string;
}

export interface EnhanceJobParams {
  targetLufs: number;
  truePeakDb?: number;
  attenLimDb: number;
  denoise?: 'auto' | 'deep' | 'afftdn' | 'off';
  outputFormat?: 'm4a' | 'opus';
}

export interface EnhanceJobStatus {
  jobId: string;
  status: 'created' | 'queued' | 'running' | 'succeeded' | 'failed';
  stage: string | null;
  progress: number;
  error: string | null;
  output: {
    bytes: number;
    format: string;
    durationMs: number | null;
    normalized?: boolean;
    denoiseEngine?: string;
  } | null;
}

export interface EnhanceWorkerHealth {
  ok: boolean;
  version?: string;
  queue?: { running: number; queued: number; capacity: number; queueLimit: number };
  engines?: { ffmpeg: boolean; deepFilter: boolean };
}

/** worker 返回非 2xx 时抛出；status 便于调用方区分 404（任务丢失）/429（队列满）等语义。 */
export class EnhanceWorkerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'EnhanceWorkerError';
  }
}

/** 读站点设置组装 worker 配置；未启用或未配置返回 null（调用方据此短路）。 */
export async function getEnhanceWorkerConfig(): Promise<
  (EnhanceWorkerConfig & { targetLufs: number; attenLimDb: number; concurrency: number }) | null
> {
  const settings = await getSiteSettings();
  const baseUrl = settings.audio_enhance_worker_url.trim().replace(/\/+$/, '');
  if (!settings.audio_enhance_enabled || !baseUrl || !settings.audio_enhance_worker_token) {
    return null;
  }
  return {
    baseUrl,
    token: settings.audio_enhance_worker_token,
    targetLufs: settings.audio_enhance_target_lufs,
    attenLimDb: settings.audio_enhance_atten_lim_db,
    concurrency: settings.audio_enhance_concurrency,
  };
}

function authHeaders(config: EnhanceWorkerConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.token}` };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

async function requestJson<T>(
  config: EnhanceWorkerConfig,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(config), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(init?.timeoutMs ?? ENHANCE_CONTROL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new EnhanceWorkerError(
      `worker ${init?.method ?? 'GET'} ${path} 失败: HTTP ${res.status} ${await readErrorBody(res)}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

/** 探活 + 引擎/队列详情（admin「测试连接」与派发前预检共用）。 */
export async function pingEnhanceWorker(
  config: EnhanceWorkerConfig
): Promise<EnhanceWorkerHealth> {
  return requestJson<EnhanceWorkerHealth>(config, '/healthz', { timeoutMs: 10_000 });
}

/** 上传原始音频（整包 Buffer；录音已按现有链路整包读出，此处不再重复流式化）。 */
export async function uploadEnhanceInput(
  config: EnhanceWorkerConfig,
  jobId: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  await requestJson<{ received: number }>(config, `/jobs/${encodeURIComponent(jobId)}/input`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: new Uint8Array(data),
    timeoutMs: ENHANCE_TRANSFER_TIMEOUT_MS,
  });
}

/** 入队开始处理。若 worker 队列已满抛 EnhanceWorkerError(status=429)，调用方留待下轮。 */
export async function startEnhanceJob(
  config: EnhanceWorkerConfig,
  jobId: string,
  params: EnhanceJobParams
): Promise<void> {
  await requestJson<{ status: string }>(config, `/jobs/${encodeURIComponent(jobId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

/** 查询任务状态；任务不存在（worker 重启丢失/已清理）抛 status=404。 */
export async function getEnhanceJob(
  config: EnhanceWorkerConfig,
  jobId: string
): Promise<EnhanceJobStatus> {
  return requestJson<EnhanceJobStatus>(config, `/jobs/${encodeURIComponent(jobId)}`);
}

/** 下载处理结果，返回 { data, contentType }。 */
export async function downloadEnhanceOutput(
  config: EnhanceWorkerConfig,
  jobId: string
): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetch(
    `${config.baseUrl}/jobs/${encodeURIComponent(jobId)}/output`,
    {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(ENHANCE_TRANSFER_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new EnhanceWorkerError(
      `worker 下载结果失败: HTTP ${res.status} ${await readErrorBody(res)}`,
      res.status
    );
  }
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType: res.headers.get('content-type') ?? 'audio/mp4' };
}

/** best-effort 清理 worker 侧任务目录；404 视为已清理，其它失败仅由调用方忽略。 */
export async function deleteEnhanceJob(
  config: EnhanceWorkerConfig,
  jobId: string
): Promise<void> {
  const res = await fetch(`${config.baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: authHeaders(config),
    signal: AbortSignal.timeout(ENHANCE_CONTROL_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    throw new EnhanceWorkerError(
      `worker 清理任务失败: HTTP ${res.status}`,
      res.status
    );
  }
}
