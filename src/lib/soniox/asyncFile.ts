/**
 * Soniox 异步文件转录 REST API 封装。
 *
 * 流程：upload file → create transcription → poll status → fetch transcript → delete file。
 *
 * 用 main API key（temporary key 只支持 transcribe_websocket / tts_rt，不能调 files
 * 和 transcriptions endpoints）。
 *
 * 配额限制（来自 Soniox docs）：
 * - 单文件音频时长 ≤ 300 分钟（5 小时）
 * - 同时最多 100 个 pending transcriptions
 * - 总历史（pending + completed + failed） ≤ 2000
 * - 总文件数 ≤ 1000，总存储 ≤ 10 GB
 * - 文件不会自动删，必须手动 DELETE
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import type { SonioxRuntimeConfig } from './env';

export const SONIOX_ASYNC_MODEL = 'stt-async-v4';

export interface SonioxFileUploadResponse {
  id: string;
  filename: string;
  size: number;
  created_at: string;
  client_reference_id: string | null;
}

export interface SonioxTranslationOneWay {
  type: 'one_way';
  target_language: string;
}

export interface SonioxTranslationTwoWay {
  type: 'two_way';
  language_a: string;
  language_b: string;
}

export type SonioxTranslationConfig = SonioxTranslationOneWay | SonioxTranslationTwoWay;

export interface CreateTranscriptionInput {
  fileId: string;
  languageHints?: string[];
  enableLanguageIdentification?: boolean;
  enableSpeakerDiarization?: boolean;
  translation?: SonioxTranslationConfig;
  context?: string;
  clientReferenceId?: string;
}

export type SonioxTranscriptionStatus = 'queued' | 'processing' | 'completed' | 'error';

export interface SonioxTranscriptionJob {
  id: string;
  status: SonioxTranscriptionStatus;
  created_at: string;
  model: string;
  file_id: string | null;
  filename: string;
  audio_duration_ms: number | null;
  error_type: string | null;
  error_message: string | null;
  client_reference_id: string | null;
}

export interface SonioxAsyncToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  speaker?: string | null;
  language?: string | null;
  is_audio_event?: boolean | null;
  /** Soniox 文档：翻译 token 上有 translation_status: "translation"。原文 token 不带该字段 */
  translation_status?: string | null;
}

export interface SonioxTranscriptResponse {
  id: string;
  text: string;
  tokens: SonioxAsyncToken[];
}

function authHeader(config: SonioxRuntimeConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

/**
 * 上传文件到 Soniox。流式读，不全 buffer。
 */
export async function uploadSonioxFile(
  config: SonioxRuntimeConfig,
  filePath: string,
  options?: { filename?: string; clientReferenceId?: string }
): Promise<SonioxFileUploadResponse> {
  const stat = await fs.promises.stat(filePath);
  const filename = path.basename(
    options?.filename || path.basename(filePath) || 'upload.bin'
  );
  const body = createMultipartFileBody(filePath, {
    filename,
    fileSize: stat.size,
    contentType: 'audio/mpeg',
    clientReferenceId: options?.clientReferenceId,
  });

  const res = await fetch(`${config.restBaseUrl}/v1/files`, {
    method: 'POST',
    headers: {
      ...authHeader(config),
      'Content-Type': `multipart/form-data; boundary=${body.boundary}`,
      'Content-Length': String(body.contentLength),
    },
    body: body.stream as unknown as BodyInit,
    // Node fetch 在发送流式请求体时需要显式声明 duplex。
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error(
      { status: res.status, errSnippet: errText.slice(0, 200), fileSize: stat.size },
      'Soniox file upload failed'
    );
    throw new Error(`Soniox file upload failed: HTTP ${res.status}`);
  }

  return (await res.json()) as SonioxFileUploadResponse;
}

/**
 * 生成流式 multipart/form-data 请求体，避免把转码后的音频整体读进内存。
 * Node 的内置 FormData 对文件流支持不稳定，手写边界更可控。
 */
function createMultipartFileBody(
  filePath: string,
  options: {
    filename: string;
    fileSize: number;
    contentType: string;
    clientReferenceId?: string;
  }
): {
  boundary: string;
  contentLength: number;
  stream: AsyncGenerator<Buffer>;
} {
  const boundary = `lecturelive-soniox-${randomUUID()}`;
  const chunks: Buffer[] = [];

  if (options.clientReferenceId) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="client_reference_id"\r\n\r\n' +
          `${options.clientReferenceId.slice(0, 256)}\r\n`
      )
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(
          options.filename
        )}"\r\n` +
        `Content-Type: ${options.contentType}\r\n\r\n`
    )
  );

  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const headerLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const contentLength = headerLength + options.fileSize + footer.length;

  async function* stream(): AsyncGenerator<Buffer> {
    for (const chunk of chunks) {
      yield chunk;
    }
    for await (const chunk of fs.createReadStream(filePath)) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    yield footer;
  }

  return {
    boundary,
    contentLength,
    stream: stream(),
  };
}

function escapeMultipartValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '%22').replace(/[\r\n]/g, '_');
}

export async function createSonioxTranscription(
  config: SonioxRuntimeConfig,
  input: CreateTranscriptionInput
): Promise<SonioxTranscriptionJob> {
  const body: Record<string, unknown> = {
    model: SONIOX_ASYNC_MODEL,
    file_id: input.fileId,
  };
  if (input.languageHints && input.languageHints.length > 0) {
    body.language_hints = input.languageHints;
  }
  if (input.enableLanguageIdentification) body.enable_language_identification = true;
  if (input.enableSpeakerDiarization) body.enable_speaker_diarization = true;
  if (input.translation) body.translation = input.translation;
  if (input.context) body.context = input.context;
  if (input.clientReferenceId) {
    body.client_reference_id = input.clientReferenceId.slice(0, 256);
  }

  const res = await fetch(`${config.restBaseUrl}/v1/transcriptions`, {
    method: 'POST',
    headers: { ...authHeader(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error(
      { status: res.status, errSnippet: errText.slice(0, 200) },
      'Soniox create transcription failed'
    );
    throw new Error(`Soniox create transcription failed: HTTP ${res.status}`);
  }

  return (await res.json()) as SonioxTranscriptionJob;
}

export async function getSonioxTranscription(
  config: SonioxRuntimeConfig,
  transcriptionId: string
): Promise<SonioxTranscriptionJob> {
  const res = await fetch(`${config.restBaseUrl}/v1/transcriptions/${transcriptionId}`, {
    headers: authHeader(config),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error(
      { status: res.status, errSnippet: errText.slice(0, 200), transcriptionId },
      'Soniox get transcription failed'
    );
    throw new Error(`Soniox get transcription failed: HTTP ${res.status}`);
  }

  return (await res.json()) as SonioxTranscriptionJob;
}

export async function getSonioxTranscript(
  config: SonioxRuntimeConfig,
  transcriptionId: string
): Promise<SonioxTranscriptResponse> {
  const res = await fetch(
    `${config.restBaseUrl}/v1/transcriptions/${transcriptionId}/transcript`,
    { headers: authHeader(config) }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error(
      { status: res.status, errSnippet: errText.slice(0, 200), transcriptionId },
      'Soniox get transcript failed'
    );
    throw new Error(`Soniox get transcript failed: HTTP ${res.status}`);
  }

  const response = (await res.json()) as SonioxTranscriptResponse;

  // 诊断日志：确认 Soniox 是否返回了 speaker / translation token（用于排查"上传录音
  // 无说话人分段/无翻译"类问题）。单次遍历统计，避免在大 transcript 上多次扫描。
  const speakers = new Set<string>();
  let speakerSampleCount = 0;
  let translationSampleCount = 0;
  for (const t of response.tokens) {
    if (t.speaker) {
      speakerSampleCount++;
      speakers.add(t.speaker);
    }
    if (t.translation_status === 'translation') translationSampleCount++;
  }
  logger.info(
    {
      transcriptionId,
      tokenCount: response.tokens.length,
      speakerSampleCount,
      translationSampleCount,
      uniqueSpeakers: speakers.size,
    },
    'Soniox async transcript received'
  );

  return response;
}

/**
 * 删除 Soniox 上的文件。404 当成已删除（幂等）。
 */
export async function deleteSonioxFile(
  config: SonioxRuntimeConfig,
  fileId: string
): Promise<void> {
  const res = await fetch(`${config.restBaseUrl}/v1/files/${fileId}`, {
    method: 'DELETE',
    headers: authHeader(config),
  });

  if (res.status === 404 || res.ok) return;

  const errText = await res.text().catch(() => '');
  logger.warn(
    { status: res.status, errSnippet: errText.slice(0, 200), fileId },
    'Soniox delete file non-fatal failure'
  );
  // 不抛错 —— transcript 已经拿到，删失败由 cron 兜底
}

/**
 * 删除 Soniox 上的 transcription job 记录（释放历史配额）。
 */
export async function deleteSonioxTranscription(
  config: SonioxRuntimeConfig,
  transcriptionId: string
): Promise<void> {
  const res = await fetch(`${config.restBaseUrl}/v1/transcriptions/${transcriptionId}`, {
    method: 'DELETE',
    headers: authHeader(config),
  });
  if (res.status === 404 || res.ok) return;

  const errText = await res.text().catch(() => '');
  logger.warn(
    { status: res.status, errSnippet: errText.slice(0, 200), transcriptionId },
    'Soniox delete transcription non-fatal failure'
  );
}
