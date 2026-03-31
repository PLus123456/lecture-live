import type { Session } from '@prisma/client';
import fixWebmDuration from 'fix-webm-duration';
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
