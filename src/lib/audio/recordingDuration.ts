import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '@prisma/client';
import fixWebmDuration from 'fix-webm-duration';
import { probeDurationSec } from '@/lib/audio/ffmpegTranscode';
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
 * 在 buffer 中搜索所有 WebM EBML 文档头的起始偏移。
 * 与 playback/page.tsx 中的 splitConcatenatedWebmBuffer 逻辑一致，
 * 额外做 DocType="webm" 校验以避免误匹配。
 */
function findWebmDocumentOffsets(bytes: Uint8Array): number[] {
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
        offsets.push(i);
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

  const bytes = new Uint8Array(options.buffer);
  const offsets = findWebmDocumentOffsets(bytes);

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
