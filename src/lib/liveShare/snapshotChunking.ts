// src/lib/liveShare/snapshotChunking.ts
// H1：sync_snapshot 的体积闸与分块协议。**主播端（broadcaster.ts）与 WS 服务端
// （server.ts）共用同一份常量与打包/解析逻辑** —— 这正是 H1 的教训：闸门常量分散在
// 两侧就必然漂移，server.ts 的 MAX_SNAPSHOT_SEGMENTS 之所以形同虚设，就是因为它与
// 传输层真正的上限（server/websocket.ts 的 maxHttpBufferSize）从来没有对齐过。
//
// H1 事故链（已实地核实）：
//   server/websocket.ts maxHttpBufferSize = 100KB
//     → engine.io 原样传给 ws 的 maxPayload（engine.io/build/socket.js）
//     → 超限的入站帧被 ws receiver 以 close 1009 直接销毁连接，**消息根本到不了
//       业务 handler**，server.ts 里那套 clamp/截断在传输层之后，永远执行不到
//     → socket.io-client 自动重连
//     → broadcaster 的 'connect' 回调无条件补发同一份超限快照（C16/U11 的补发机制）
//     → 再被杀 → 无限死循环，直播彻底瘫痪。
//
// 所以闸门必须落在**发送之前**。本模块负责三件事：
//   ① 按 **UTF-8 字节**估算载荷体积（不是 String.length —— 中文一字三字节，
//      按 length 算会低估三倍，闸门直接失效）；
//   ② 把一份全量快照切成若干个字节受控的块；
//   ③ 兜底截断：块数超上限时丢弃**最早**的 segment / summary（保留最近的），
//      并置 truncated，让观众端明确知道 backlog 不全。
//
// 分块协议的不变式（客户端与服务端必须同时成立，改任何一侧前先读完）：
//   I1  任何单条 sync_snapshot 消息的 JSON 体 ≤ MAX_LIVE_MESSAGE_BYTES，且该值与
//       传输层上限之间留足 socket.io 帧头余量（`42["sync_snapshot",…]`）。
//   I2  一份快照最多 MAX_SYNC_SNAPSHOT_CHUNKS 块。上限同时约束两件事：重连补发的
//       突发消息数不得击穿服务端每 socket 令牌桶（server/websocket.ts：容量 40、
//       稳态 20 msg/s），以及单场直播占用的服务端内存上界。
//   I3  chunkIndex === 0 是**全量覆盖**语义（沿用 U11 的口径），chunkIndex > 0 是
//       **追加**；服务端集齐 chunkCount 块后才原子提交，中途绝不让观众读到半份快照
//       （半份覆盖 = 抹掉服务端已累积的历史，正是 U11 注释警告过的事故）。
//   I4  块内 segment 保持原始先后顺序，服务端按顺序 push，观众侧时间线不会被打乱。

/** 单条实时消息（sync_snapshot 块 / broadcast 增量）的 JSON 体硬上限。
 *  传输层上限是 100KB（server/websocket.ts MAX_MESSAGE_SIZE_BYTES），这里留 10KB
 *  给 socket.io 的 `42["<event>",…]` 帧头与编码抖动。宁可少发，绝不试探 1009。 */
export const MAX_LIVE_MESSAGE_BYTES = 90 * 1024;

/** 单个快照块的打包目标。低于硬上限，给「单条 segment 本身偏大」留出缓冲。 */
export const SYNC_SNAPSHOT_CHUNK_TARGET_BYTES = 56 * 1024;

/** 一份快照最多切几块（见 I2）。24 × 56KB ≈ 1.3MB ≈ 4000+ 条 segment，
 *  按每 5s 一段算够 5 小时以上的连续课堂；超出才走截断。 */
export const MAX_SYNC_SNAPSHOT_CHUNKS = 24;

/** 服务端从磁盘草稿恢复出的快照的出站字节上限（L3）。磁盘草稿的 PUT 侧无体积校验，
 *  异常巨大的草稿会让每次观众 join 都推一份 MB 级 initial_state 并常驻服务端内存。 */
export const MAX_PERSISTED_SNAPSHOT_BYTES = 1024 * 1024;

/** 每块除三大集合外的信封开销预留（分块元信息 + 容器括号 + 编码抖动）。 */
const CHUNK_ENVELOPE_RESERVE_BYTES = 512;

/** 即便 head 字段异常大，也要保证每块至少能装下点东西。 */
const MIN_CHUNK_CAPACITY_BYTES = 4 * 1024;

/** 快照里除三大集合之外的「头部」字段，只随首块（chunkIndex === 0）发送。 */
export interface SnapshotHeadFields {
  status?: string | null;
  previewText?: unknown;
  previewTranslation?: unknown;
  sourceLang?: string | null;
  targetLang?: string | null;
  translationMode?: string | null;
}

export interface ChunkableSnapshot extends SnapshotHeadFields {
  segments: unknown[];
  translations: Record<string, string>;
  summaryBlocks: unknown[];
}

export interface SnapshotChunk extends SnapshotHeadFields {
  segments: unknown[];
  translations: Record<string, string>;
  summaryBlocks: unknown[];
  /** 同一份快照的所有块共享，用于服务端识别「续块」与「新一轮首块」。 */
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
  /** 仅首块携带：因体积上限丢弃了最早的若干条内容。 */
  truncated?: boolean;
  droppedSegments?: number;
}

export interface BuildSnapshotChunksResult {
  chunks: SnapshotChunk[];
  /** 因总预算不够被丢弃的最早 segment 条数。 */
  droppedSegments: number;
  /** 因总预算不够被丢弃的最早 summary block 条数。 */
  droppedSummaryBlocks: number;
  /** 单条本身就超过硬上限、无法装进任何一块而被丢弃的条数。 */
  droppedOversized: number;
  /** 上面任意一项 > 0。 */
  truncated: boolean;
}

// ── UTF-8 字节估算 ────────────────────────────────────────────────────────────

const sharedTextEncoder =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * 字符串的 UTF-8 字节数。**不要**用 String.length 代替：传输层按字节计，中文一字
 * 三字节，按 length 估算会低估到闸门失效（H1 的核心陷阱之一）。
 * 无 TextEncoder 的环境退回手算码点宽度，只允许高估、不允许低估。
 */
export function utf8ByteLength(value: string): number {
  if (sharedTextEncoder) {
    return sharedTextEncoder.encode(value).length;
  }

  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个码点四字节，跳过低位代理
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 一个值序列化成 JSON 后的 UTF-8 字节数（不可序列化时按 0 计）。 */
export function jsonByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 0;
  }
  return serialized === undefined ? 0 : utf8ByteLength(serialized);
}

// ── 截断 ─────────────────────────────────────────────────────────────────────

export interface TrimmedSnapshot {
  segments: unknown[];
  summaryBlocks: unknown[];
  translations: Record<string, string>;
  droppedSegments: number;
  droppedSummaryBlocks: number;
  truncated: boolean;
}

function segmentIdOf(segment: unknown): string | null {
  if (!segment || typeof segment !== 'object') return null;
  const id = (segment as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * 把快照的三大集合裁到给定字节预算内。**保留最近的、丢弃最早的** —— 直播场景下
 * 最新内容的价值远高于开场白，且观众端已有的历史不会因此消失（只影响晚加入者）。
 * 被丢弃 segment 的译文一并丢弃；不属于任何 segment 的孤儿译文条目原样保留
 * （它们可能来自 translation_delta，删掉反而丢数据）。
 */
export function trimSnapshotToByteBudget(
  snapshot: ChunkableSnapshot,
  budgetBytes: number
): TrimmedSnapshot {
  const segments = Array.isArray(snapshot.segments) ? snapshot.segments : [];
  const summaryBlocks = Array.isArray(snapshot.summaryBlocks)
    ? snapshot.summaryBlocks
    : [];
  const translations =
    snapshot.translations && typeof snapshot.translations === 'object'
      ? snapshot.translations
      : {};

  const translationBytes = new Map<string, number>();
  for (const [key, value] of Object.entries(translations)) {
    translationBytes.set(key, jsonByteLength(key) + jsonByteLength(value) + 2);
  }

  // 摘要块单独给一份小预算：它们按分钟级节奏产生、总量远小于 segment，但一旦异常
  // 膨胀就会把 segment 的位置全占掉，故先各自封顶再让 segment 用剩下的。
  const summaryBudget = Math.max(0, Math.floor(budgetBytes / 4));
  let summaryUsed = 0;
  let summaryKeepFrom = summaryBlocks.length;
  for (let i = summaryBlocks.length - 1; i >= 0; i -= 1) {
    const size = jsonByteLength(summaryBlocks[i]) + 1;
    if (summaryUsed + size > summaryBudget) break;
    summaryUsed += size;
    summaryKeepFrom = i;
  }

  let used = summaryUsed;
  let segmentKeepFrom = segments.length;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const id = segmentIdOf(segments[i]);
    const size =
      jsonByteLength(segments[i]) +
      1 +
      (id ? (translationBytes.get(id) ?? 0) : 0);
    if (used + size > budgetBytes) break;
    used += size;
    segmentKeepFrom = i;
  }

  const keptSegments = segments.slice(segmentKeepFrom);
  const keptSummaryBlocks = summaryBlocks.slice(summaryKeepFrom);

  const droppedSegments = segmentKeepFrom;
  const droppedSummaryBlocks = summaryKeepFrom;

  let keptTranslations = translations;
  if (droppedSegments > 0) {
    const allSegmentIds = new Set<string>();
    for (const segment of segments) {
      const id = segmentIdOf(segment);
      if (id) allSegmentIds.add(id);
    }
    const keptSegmentIds = new Set<string>();
    for (const segment of keptSegments) {
      const id = segmentIdOf(segment);
      if (id) keptSegmentIds.add(id);
    }

    keptTranslations = {};
    for (const [key, value] of Object.entries(translations)) {
      // 保留：仍在窗口内的 segment 的译文 + 不对应任何 segment 的孤儿条目
      if (keptSegmentIds.has(key) || !allSegmentIds.has(key)) {
        keptTranslations[key] = value;
      }
    }
  }

  return {
    segments: keptSegments,
    summaryBlocks: keptSummaryBlocks,
    translations: keptTranslations,
    droppedSegments,
    droppedSummaryBlocks,
    truncated: droppedSegments > 0 || droppedSummaryBlocks > 0,
  };
}

// ── 打包 ─────────────────────────────────────────────────────────────────────

type PackItem =
  | { kind: 'summary'; value: unknown; bytes: number }
  | { kind: 'segment'; value: unknown; bytes: number }
  | { kind: 'translation'; key: string; value: string; bytes: number };

function createChunkId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function packItems(
  items: PackItem[],
  chunkCapacity: number,
  itemCeiling: number
): { buckets: PackItem[][]; droppedOversized: number } {
  const buckets: PackItem[][] = [];
  let current: PackItem[] = [];
  let currentBytes = 0;
  let droppedOversized = 0;

  for (const item of items) {
    if (item.bytes > itemCeiling) {
      // 单条本身就超过硬上限：装进任何一块都会被 1009 杀掉，只能丢并计数。
      droppedOversized += 1;
      continue;
    }
    if (current.length > 0 && currentBytes + item.bytes > chunkCapacity) {
      buckets.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.bytes;
  }
  if (current.length > 0) {
    buckets.push(current);
  }
  if (buckets.length === 0) {
    buckets.push([]);
  }

  return { buckets, droppedOversized };
}

/**
 * 把一份全量快照切成可安全发送的块序列。返回的 chunks 至少有一块（空快照也要发，
 * 它同样是「全量覆盖」的一次表达）。首块携带 head 字段与 truncated 标记。
 */
export function buildSnapshotChunks(
  snapshot: ChunkableSnapshot
): BuildSnapshotChunksResult {
  const head: SnapshotHeadFields = {
    status: snapshot.status,
    previewText: snapshot.previewText,
    previewTranslation: snapshot.previewTranslation,
    sourceLang: snapshot.sourceLang,
    targetLang: snapshot.targetLang,
    translationMode: snapshot.translationMode,
  };

  // 每块都按「最坏情况」预留 head + 信封：只有首块真的带 head，但按它统一预留才能
  // 保证任何一块都不越限。低估一次的代价是一整轮 1009 死循环，宁可多留。
  const envelopeBytes = jsonByteLength(head) + CHUNK_ENVELOPE_RESERVE_BYTES;
  const chunkCapacity = Math.max(
    MIN_CHUNK_CAPACITY_BYTES,
    SYNC_SNAPSHOT_CHUNK_TARGET_BYTES - envelopeBytes
  );
  const itemCeiling = Math.max(
    1,
    MAX_LIVE_MESSAGE_BYTES - envelopeBytes - CHUNK_ENVELOPE_RESERVE_BYTES
  );

  // 预算留一块的余量给装箱碎片（每块末尾装不下一条就换块，最坏每块浪费一条的体积）。
  let budget = chunkCapacity * (MAX_SYNC_SNAPSHOT_CHUNKS - 1);
  let trimmed = trimSnapshotToByteBudget(snapshot, budget);
  let packed = packItems(
    buildPackItems(trimmed),
    chunkCapacity,
    itemCeiling
  );

  // 极端碎片化（单条体积逼近 chunkCapacity）下装箱结果仍可能越过块数上限：
  // 折半预算重来，而不是砍掉尾块——尾块装的是最新内容，砍它等于丢最有价值的数据。
  for (let attempt = 0; attempt < 4 && packed.buckets.length > MAX_SYNC_SNAPSHOT_CHUNKS; attempt += 1) {
    budget = Math.floor(budget / 2);
    trimmed = trimSnapshotToByteBudget(snapshot, budget);
    packed = packItems(buildPackItems(trimmed), chunkCapacity, itemCeiling);
  }

  const buckets = packed.buckets.slice(0, MAX_SYNC_SNAPSHOT_CHUNKS);
  const droppedByCap = packed.buckets.length - buckets.length;

  const chunkId = createChunkId();
  const chunkCount = buckets.length;
  const truncated =
    trimmed.truncated || packed.droppedOversized > 0 || droppedByCap > 0;

  const chunks: SnapshotChunk[] = buckets.map((bucket, index) => {
    const segments: unknown[] = [];
    const summaryBlocks: unknown[] = [];
    const translations: Record<string, string> = {};
    for (const item of bucket) {
      if (item.kind === 'segment') segments.push(item.value);
      else if (item.kind === 'summary') summaryBlocks.push(item.value);
      else translations[item.key] = item.value;
    }

    const chunk: SnapshotChunk = {
      segments,
      summaryBlocks,
      translations,
      chunkId,
      chunkIndex: index,
      chunkCount,
    };

    if (index === 0) {
      Object.assign(chunk, head);
      if (truncated) {
        chunk.truncated = true;
        chunk.droppedSegments = trimmed.droppedSegments;
      }
    }

    return chunk;
  });

  return {
    chunks,
    droppedSegments: trimmed.droppedSegments,
    droppedSummaryBlocks: trimmed.droppedSummaryBlocks,
    droppedOversized: packed.droppedOversized,
    truncated,
  };
}

// 打包顺序刻意是「摘要 → segment（保持原序）→ 译文」：服务端对续块是按序追加，
// segment 保持原序才能让观众侧时间线不乱（I4）。
function buildPackItems(trimmed: TrimmedSnapshot): PackItem[] {
  const items: PackItem[] = [];
  for (const value of trimmed.summaryBlocks) {
    items.push({ kind: 'summary', value, bytes: jsonByteLength(value) + 1 });
  }
  for (const value of trimmed.segments) {
    items.push({ kind: 'segment', value, bytes: jsonByteLength(value) + 1 });
  }
  for (const [key, value] of Object.entries(trimmed.translations)) {
    items.push({
      kind: 'translation',
      key,
      value,
      bytes: jsonByteLength(key) + jsonByteLength(value) + 2,
    });
  }
  return items;
}

// ── 服务端解析 ───────────────────────────────────────────────────────────────

export interface SnapshotChunkMeta {
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
}

export type SnapshotChunkMetaResult =
  /** 完全没有分块字段：旧式单块全量（滚动发布期间的旧客户端），按全量覆盖处理。 */
  | { kind: 'single' }
  | { kind: 'chunk'; meta: SnapshotChunkMeta }
  /** 带了分块字段但不合法：整条丢弃。绝不降级成「全量覆盖」—— 把一个续块当全量，
   *  会用半份内容抹掉服务端已有历史（U11 明令禁止的事故形态）。 */
  | { kind: 'invalid' };

export function readSnapshotChunkMeta(payload: unknown): SnapshotChunkMetaResult {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'single' };
  }

  const record = payload as Record<string, unknown>;
  const hasAnyChunkField =
    'chunkId' in record || 'chunkIndex' in record || 'chunkCount' in record;
  if (!hasAnyChunkField) {
    return { kind: 'single' };
  }

  const { chunkId, chunkIndex, chunkCount } = record;
  if (typeof chunkId !== 'string' || !chunkId || chunkId.length > 64) {
    return { kind: 'invalid' };
  }
  if (
    typeof chunkIndex !== 'number' ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0
  ) {
    return { kind: 'invalid' };
  }
  if (
    typeof chunkCount !== 'number' ||
    !Number.isInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MAX_SYNC_SNAPSHOT_CHUNKS
  ) {
    return { kind: 'invalid' };
  }
  if (chunkIndex >= chunkCount) {
    return { kind: 'invalid' };
  }

  return { kind: 'chunk', meta: { chunkId, chunkIndex, chunkCount } };
}
