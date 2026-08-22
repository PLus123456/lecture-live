import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '@prisma/client';
import fixWebmDuration from 'fix-webm-duration';
import {
  measureDecodedAudioDurationSec,
  probeAudioStreamCount,
  probeDurationSec,
  probeFormatName,
  validateMediaContainer,
} from '@/lib/audio/ffmpegTranscode';
import {
  copyFileRange,
  scanWebmDocumentRanges,
} from '@/lib/audio/webmDocuments';
import { loadSessionTranscriptBundle } from '@/lib/sessionPersistence';
import type { PersistedTranscriptBundle } from '@/lib/sessionPersistence';

type DurationSessionSource = Pick<
  Session,
  | 'id'
  | 'userId'
  | 'durationMs'
  | 'recordingPath'
  | 'transcriptPath'
  | 'summaryPath'
  | 'serverStartedAt'
  | 'serverPausedMs'
  | 'serverPausedAt'
>;

export function resolveTranscriptDurationMs(
  transcriptBundle: PersistedTranscriptBundle | null | undefined
): number {
  return Array.isArray(transcriptBundle?.segments)
    ? transcriptBundle.segments.reduce<number>((maxDuration, segment) => {
        if (!segment || typeof segment !== 'object') {
          return maxDuration;
        }

        const record = segment as {
          globalEndMs?: unknown;
          endMs?: unknown;
        };

        const rawEndMs =
          typeof record.globalEndMs === 'number'
            ? record.globalEndMs
            : typeof record.endMs === 'number'
              ? record.endMs
              : 0;
        const endMs = Number(rawEndMs);

        return Number.isFinite(endMs)
          ? Math.max(maxDuration, endMs)
          : maxDuration;
      }, 0)
    : 0;
}

export function resolveServerRecordingDurationMs(
  session: Pick<Session, 'serverStartedAt' | 'serverPausedMs' | 'serverPausedAt'>,
  now = new Date()
): number {
  if (!session.serverStartedAt) {
    return 0;
  }

  const startedAtMs = session.serverStartedAt.getTime();
  const pausedMs = Number.isFinite(session.serverPausedMs)
    ? Math.max(0, session.serverPausedMs)
    : 0;
  const pendingPausedMs = session.serverPausedAt
    ? Math.max(0, now.getTime() - session.serverPausedAt.getTime())
    : 0;

  return Math.max(0, now.getTime() - startedAtMs - pausedMs - pendingPausedMs);
}

export async function resolveExpectedRecordingDurationMs(
  session: DurationSessionSource
): Promise<number> {
  const transcriptBundle = await loadSessionTranscriptBundle(session).catch(
    () => null
  );
  const transcriptDurationMs = resolveTranscriptDurationMs(transcriptBundle);
  const serverDurationMs = resolveServerRecordingDurationMs(session);

  return Math.max(session.durationMs ?? 0, transcriptDurationMs, serverDurationMs);
}

/** MIME → 临时文件扩展名。ffprobe 主要靠内容嗅探，扩展名只是帮它少猜一步。 */
const PROBE_EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
};

const MAX_DATABASE_DURATION_MS = 2_147_483_647;
const AUTHORITATIVE_MEASUREMENT_MAX_WALL_MS = 2 * 60 * 60_000;

/**
 * 前端到角色时长上限后要先同步状态再停止 MediaRecorder；慢请求和 codec 尾帧会让权威媒体时长
 * 略超 UI 计时。允许一分钟收尾余量，超过才拒绝发布；余量内仍保存并计入真实实测时长。
 */
export const RECORDING_DURATION_LIMIT_GRACE_MS = 60_000;

export class RecordingDurationMeasurementError extends Error {
  constructor(
    message = 'Could not determine recording duration',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RecordingDurationMeasurementError';
  }
}

export interface AuthoritativeRecordingDurationOptions {
  /** Claim-scoped work directory for temporary per-document files. */
  tempRoot?: string;
}

function isEbmlMediaFormat(formatName: string): boolean {
  return formatName
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === 'webm' || part === 'matroska');
}

function remainingMeasurementTimeMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new RecordingDurationMeasurementError();
  return remaining;
}

async function measureOneRecordingDocument(
  inputPath: string,
  deadlineMs: number,
  alreadyValidated = false
): Promise<number> {
  if (!alreadyValidated) await validateMediaContainer(inputPath);
  if ((await probeAudioStreamCount(inputPath)) !== 1) {
    throw new RecordingDurationMeasurementError();
  }
  const remainingMs = remainingMeasurementTimeMs(deadlineMs);
  const durationSec = await measureDecodedAudioDurationSec(inputPath, {
    idleTimeoutMs: Math.min(5 * 60_000, remainingMs),
    maxTimeoutMs: remainingMs,
  });
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RecordingDurationMeasurementError();
  }
  return durationSec;
}

/**
 * 从调用方拥有的本地文件路径测量可发布录音的权威时长。
 *
 * 容器头里的 duration 同样属于攻击者可控字节，不能把一个伪造的小正值当成已验证。所有输入都
 * 完整解码到 null muxer，并以固定采样率的累计解码样本重建单调时间轴。这样切换输入产生的多个
 * 独立 WebM 文档即使 PTS 都从 0 重启，也会按各段总和计时。权威录音只接受恰好一个音频流：
 * ffmpeg 的 progress 在多音轨 null 输出中可能只反映第一轨，直接接受多轨会允许用短 a:0 掩盖
 * 长音轨。这同时兼容单音轨且没有 format.duration 的 streaming/headerless WebM。失败必须抛错，
 * 调用方不得退回客户端、墙钟或转录时间戳后发布录音。函数从不改写或删除 inputPath。
 */
export async function measureAuthoritativeRecordingDurationMs(
  inputPath: string,
  options: AuthoritativeRecordingDurationOptions = {}
): Promise<number> {
  const deadlineMs = Date.now() + AUTHORITATIVE_MEASUREMENT_MAX_WALL_MS;
  let documentTempDir: string | null = null;
  try {
    await validateMediaContainer(inputPath);
    const formatName = await probeFormatName(inputPath);
    if (!formatName) throw new RecordingDurationMeasurementError();

    let durationSec: number;
    if (!isEbmlMediaFormat(formatName)) {
      durationSec = await measureOneRecordingDocument(
        inputPath,
        deadlineMs,
        true
      );
    } else {
      // MediaRecorder restarts are stored as byte-concatenated independent EBML documents. Whole-
      // file ffprobe reports only the first track table, and ffmpeg may ignore an incompatible later
      // document while exiting 0. Scan offsets with bounded heap, then validate/decode every document.
      const ranges = await scanWebmDocumentRanges(inputPath);
      if (ranges.length === 1) {
        durationSec = await measureOneRecordingDocument(
          inputPath,
          deadlineMs,
          true
        );
      } else {
        const tempRoot = options.tempRoot ?? os.tmpdir();
        await fs.mkdir(tempRoot, { recursive: true });
        documentTempDir = await fs.mkdtemp(
          path.join(tempRoot, 'll-audio-doc-measure-')
        );
        durationSec = 0;
        for (let index = 0; index < ranges.length; index += 1) {
          remainingMeasurementTimeMs(deadlineMs);
          const documentPath = path.join(
            documentTempDir,
            `document-${index}.webm`
          );
          await copyFileRange(inputPath, ranges[index], documentPath);
          durationSec += await measureOneRecordingDocument(
            documentPath,
            deadlineMs
          );
          await fs.rm(documentPath, { force: true });
        }
      }
    }

    const durationMs = Math.round(durationSec * 1000);
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      durationMs > MAX_DATABASE_DURATION_MS
    ) {
      throw new RecordingDurationMeasurementError();
    }
    return durationMs;
  } catch (error) {
    if (error instanceof RecordingDurationMeasurementError) throw error;
    throw new RecordingDurationMeasurementError(
      'Could not determine recording duration',
      { cause: error }
    );
  } finally {
    if (documentTempDir) {
      await fs
        .rm(documentTempDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}

/**
 * Buffer 入口仅负责建立受控临时文件；发布路径用完即删。路径版供已持有本地/下载临时文件的
 * 后台任务复用，避免再次把整段录音读入内存。
 */
export async function measureAuthoritativeRecordingDurationMsFromBuffer(
  buffer: Buffer,
  mimeType?: string | null
): Promise<number> {
  if (!buffer || buffer.length === 0) {
    throw new RecordingDurationMeasurementError();
  }
  const ext = PROBE_EXTENSION_BY_MIME[mimeType ?? ''] ?? '.bin';
  const tmpPath = path.join(
    os.tmpdir(),
    `ll-audio-measure-${crypto.randomUUID()}${ext}`
  );
  try {
    await fs.writeFile(tmpPath, buffer);
    return await measureAuthoritativeRecordingDurationMs(tmpPath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

/**
 * P5-14：直接从音频字节读时长（ffprobe 兜底）。
 *
 * resolveExpectedRecordingDurationMs 的三个来源（session.durationMs / transcript 的
 * globalEndMs / serverStartedAt 计时）全都建立在「这场录音走过实时链路」的前提上。
 * 但直传口 POST /api/sessions/[id]/audio 完全可以往一个从没连过 WS、没有任何转录的会话
 * 落一段音频：三个来源同时为 0 → durationMs 落 0 → 这段录音对 storage_hours 的贡献恒为 0，
 * 用户可以在 32MB × 20 次/小时的限速内一直灌而永远不占存储小时额度。
 *
 * 读不到（没装 ffprobe / 坏文件 / 超时）一律返回 0，退回原有语义，绝不抛。
 */
export async function probeAudioDurationMsFromBuffer(
  buffer: Buffer,
  mimeType?: string | null
): Promise<number> {
  if (!buffer || buffer.length === 0) return 0;
  const ext = PROBE_EXTENSION_BY_MIME[mimeType ?? ''] ?? '.bin';
  const tmpPath = path.join(
    os.tmpdir(),
    `ll-audio-probe-${crypto.randomUUID()}${ext}`
  );
  try {
    await fs.writeFile(tmpPath, buffer);
    const seconds = await probeDurationSec(tmpPath);
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
  } catch {
    return 0;
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

const WEBM_HEADER_BYTES = [0x1a, 0x45, 0xdf, 0xa3] as const;

/**
 * P4-1 / audio-recording#150：允许做 webm 时长修正的总字节上限。
 *
 * normalizeRecordedAudioDuration 会在输入之上再做 3-4 份整份拷贝（切段 → Blob →
 * arrayBuffer → concat），几百 MB 的录音就足以把 2GB 容器的主进程 OOM 掉。此前这道闸
 * 只长在草稿定稿路由里（局部常量），直传口 POST /audio 完全没有 —— 现在提到本模块，
 * 由**所有**调用点共用同一个常量与同一条短路。
 * 128MiB 对应 128kbps 下约 2.3 小时录音，绝大多数会话都在阈值内、行为完全不变。
 */
export const MAX_DURATION_FIX_BYTES = 128 * 1024 * 1024;

/**
 * audio-recording#150：单次输入允许识别出的 WebM 文档边界数上限。
 *
 * 真实的多段录音来自「暂停/断网重开 MediaRecorder」，一场课几十段已属极端；512 给足冗余。
 * 超过即判定为伪造载荷（见下方 MIN_WEBM_SEGMENT_BYTES 的说明），放弃分段而不是硬着头皮切。
 */
const MAX_WEBM_DOCUMENT_SEGMENTS = 512;

/**
 * audio-recording#150：相邻两个文档边界之间的最小间隔。
 *
 * 攻击载荷是 8 字节的 `1A 45 DF A3 'webm'` 无限重复：每 8 字节命中一次魔数 + DocType 校验，
 * 32MiB 输入即可切出约 4×10^6 段，随后逐段 new Blob + arrayBuffer + Buffer.from。实测
 * 16MiB 载荷 → 2.1×10^6 段、16.5s、RSS 1.47GB（32MiB 线性外推约 2.9GB），单个请求即可把
 * 常规容量的容器 OOM 掉。真实 webm 文档头后必然跟着 Segment/Tracks/Cluster，1KiB 是极宽松的下限。
 */
const MIN_WEBM_SEGMENT_BYTES = 1024;

/**
 * 在 buffer 中搜索所有 WebM EBML 文档头的起始偏移。
 * 与 playback/page.tsx 中的 splitConcatenatedWebmBuffer 逻辑一致，
 * 额外做 DocType="webm" 校验以避免误匹配。
 *
 * audio-recording#150：两道硬闸 —— 相邻边界至少间隔 {@link MIN_WEBM_SEGMENT_BYTES}
 * （密集伪造标记被折叠掉），边界总数超过 {@link MAX_WEBM_DOCUMENT_SEGMENTS} 时立刻放弃扫描并
 * 返回 null（调用方据此原样返回 buffer，绝不进入切段循环）。
 */
function findWebmDocumentOffsets(bytes: Uint8Array): number[] | null {
  const offsets: number[] = [];
  for (let i = 0; i <= bytes.length - WEBM_HEADER_BYTES.length; i += 1) {
    if (
      bytes[i] === WEBM_HEADER_BYTES[0] &&
      bytes[i + 1] === WEBM_HEADER_BYTES[1] &&
      bytes[i + 2] === WEBM_HEADER_BYTES[2] &&
      bytes[i + 3] === WEBM_HEADER_BYTES[3]
    ) {
      // 检查后续 128 字节内是否存在 "webm" DocType 字符串
      const scanEnd = Math.min(bytes.length - 4, i + 128);
      let hasDocType = false;
      for (let j = i; j <= scanEnd; j += 1) {
        if (
          bytes[j] === 0x77 &&
          bytes[j + 1] === 0x65 &&
          bytes[j + 2] === 0x62 &&
          bytes[j + 3] === 0x6d
        ) {
          hasDocType = true;
          break;
        }
      }
      if (hasDocType) {
        const previous = offsets[offsets.length - 1];
        // 距上一个已采纳边界不足最小段长 → 视为同一文档内的噪声/伪造标记，跳过。
        if (previous !== undefined && i - previous < MIN_WEBM_SEGMENT_BYTES) {
          continue;
        }
        offsets.push(i);
        if (offsets.length > MAX_WEBM_DOCUMENT_SEGMENTS) {
          return null;
        }
      }
    }
  }
  return offsets;
}

export async function normalizeRecordedAudioDuration(options: {
  buffer: Buffer;
  mimeType?: string | null;
  durationMs: number;
}): Promise<Buffer> {
  const normalizedMimeType = (options.mimeType || '').toLowerCase();
  if (!normalizedMimeType.includes('webm') || options.durationMs <= 0) {
    return options.buffer;
  }

  // audio-recording#150：总字节闸。放在函数入口而不是各调用点，直传口与草稿定稿口共用。
  // 超阈值直接放弃修正：webm 时长头缺失只影响进度条/拖动精度（浏览器照样能播），
  // 进程被打死则全站受害。
  if (options.buffer.length > MAX_DURATION_FIX_BYTES) {
    console.warn(
      `[recordingDuration] 输入 ${options.buffer.length} 字节超过 ${MAX_DURATION_FIX_BYTES}，跳过 webm 时长修正`
    );
    return options.buffer;
  }

  const bytes = new Uint8Array(options.buffer);
  const offsets = findWebmDocumentOffsets(bytes);

  // audio-recording#150：边界数超上限 —— 密集伪造的 EBML 标记（每 8 字节一个魔数即可让
  // 32MiB 输入切出约 4×10^6 段）。原样返回，绝不进入「切段 + 逐段 fixWebmDuration」循环。
  if (offsets === null) {
    console.warn(
      `[recordingDuration] webm 文档边界数超过 ${MAX_WEBM_DOCUMENT_SEGMENTS}，判定为异常载荷，跳过时长修正`
    );
    return options.buffer;
  }

  // 单段 WebM（或找不到边界）：走原有逻辑
  if (offsets.length <= 1) {
    const fixedBlob = await fixWebmDuration(
      new Blob([bytes], { type: options.mimeType || 'audio/webm' }),
      options.durationMs,
      { logger: false }
    );
    return Buffer.from(await fixedBlob.arrayBuffer());
  }

  // 多段 WebM：按字节比例分配时长后分别修正，再拼接
  const boundaries =
    offsets[0] === 0 ? offsets : [0, ...offsets.filter((o) => o > 0)];
  const totalBytes = bytes.length;
  const segments: Uint8Array[] = [];

  for (let idx = 0; idx < boundaries.length; idx += 1) {
    const start = boundaries[idx];
    const end = boundaries[idx + 1] ?? totalBytes;
    segments.push(bytes.slice(start, end));
  }

  const fixedParts: Buffer[] = [];
  for (const segment of segments) {
    const proportionalDurationMs = Math.max(
      1,
      Math.round((segment.length / totalBytes) * options.durationMs)
    );
    try {
      const fixed = await fixWebmDuration(
        new Blob([new Uint8Array(segment)], { type: options.mimeType || 'audio/webm' }),
        proportionalDurationMs,
        { logger: false }
      );
      fixedParts.push(Buffer.from(await fixed.arrayBuffer()));
    } catch {
      // 修正失败则保留原始数据
      fixedParts.push(Buffer.from(segment));
    }
  }

  return Buffer.concat(fixedParts);
}
