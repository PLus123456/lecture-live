import type { PersistedTranscriptBundle } from '@/lib/sessionPersistence';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mergeEntries(previous: unknown[], incoming: unknown[]): unknown[] {
  const entries = new Map<string, unknown>();
  for (const item of [...previous, ...incoming]) {
    const next = record(item);
    const key = typeof next?.id === 'string' ? `id:${next.id}` : `value:${JSON.stringify(item)}`;
    const old = record(entries.get(key));
    if (old && next) {
      // 已定稿句子不应被旧快照缩短；译文等补充字段仍可合并。
      const merged = { ...old, ...next };
      for (const field of ['text', 'translatedText', 'summary']) {
        if (typeof old[field] === 'string' &&
            (typeof next[field] !== 'string' || (next[field] as string).length < (old[field] as string).length)) {
          merged[field] = old[field];
        }
      }
      entries.set(key, merged);
    } else {
      entries.set(key, item);
    }
  }
  return [...entries.values()];
}

/** 恢复与收尾都按稳定 ID 合并；段数相同或更多不代表包含了另一份快照的全部内容。 */
export function mergeTranscriptBundles(
  previous: PersistedTranscriptBundle | null | undefined,
  incoming: PersistedTranscriptBundle | null | undefined
): PersistedTranscriptBundle {
  const segments = mergeEntries(previous?.segments ?? [], incoming?.segments ?? []);
  segments.sort((a, b) => {
    const left = record(a);
    const right = record(b);
    const leftStart = left?.globalStartMs ?? left?.startMs;
    const rightStart = right?.globalStartMs ?? right?.startMs;
    return typeof leftStart === 'number' && typeof rightStart === 'number' ? leftStart - rightStart : 0;
  });
  const translations = { ...previous?.translations };
  for (const [id, text] of Object.entries(incoming?.translations ?? {})) {
    if (text || !translations[id]) translations[id] = text;
  }
  return {
    segments,
    summaries: mergeEntries(previous?.summaries ?? [], incoming?.summaries ?? []),
    translations,
  };
}
