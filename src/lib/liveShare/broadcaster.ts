// src/lib/liveShare/broadcaster.ts
// 录制者端：将实时数据广播给观看者

import { io, Socket } from 'socket.io-client';
import type { TranscriptSegment } from '@/types/transcript';
import type { SummaryBlock } from '@/types/summary';
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';
import {
  MAX_LIVE_MESSAGE_BYTES,
  buildSnapshotChunks,
  jsonByteLength,
} from './snapshotChunking';

/**
 * M2：主播端连接态。此前本类只监听 viewer_count / share_error，WS 进程崩溃或被
 * 服务端踢掉时 UI 会一直显示「直播中」而数据静默丢失。三态含义：
 * - connected    ：已（重新）连上，正在广播；
 * - reconnecting ：底层传输断了但 socket.io 仍在自动重连，服务端还有 15s 主播宽限
 *                  （server.ts HOST_OFFLINE_GRACE_MS），不必立刻宣告失败；
 * - closed       ：不会再自己回来了 —— 服务端主动踢（io server disconnect）、
 *                  握手中间件拒绝（Origin/IP 上限）、或超过 RECONNECT_DEADLINE_MS
 *                  仍未回来。调用方应据此撤下「直播中」UI 并撤销分享链接。
 */
export type BroadcasterConnectionState = 'connected' | 'reconnecting' | 'closed';

interface BroadcasterCallbacks {
  onViewerCount?: (count: number) => void;
  onError?: (error: { message: string }) => void;
  onConnectionChange?: (
    state: BroadcasterConnectionState,
    info?: { reason?: string; message?: string }
  ) => void;
}

interface SnapshotPayload {
  segments: TranscriptSegment[];
  translations: Record<string, string>;
  summaryBlocks: SummaryBlock[];
  status: string;
  previewText: StreamingPreviewText;
  previewTranslation: StreamingPreviewTranslation;
  sourceLang?: string;
  targetLang?: string;
  translationMode?: string;
}

/**
 * M2：断连多久之后判定为不可恢复。必须 > 服务端的 HOST_OFFLINE_GRACE_MS（15s）——
 * 窗口内回来的瞬断由服务端的 SHARE_LIVE 重播兜底，不该惊动 UI；过了宽限期服务端
 * 已经向观众宣告 SHARE_OFFLINE 并回收了内存快照，此时再假装「直播中」就是骗人。
 */
const RECONNECT_DEADLINE_MS = 45_000;

export class LiveBroadcaster {
  private socket: Socket;
  private sessionId: string;
  private callbacks?: BroadcasterCallbacks;
  // C16/U11：缓存最近一次同步的全量快照，并在底层 socket 每次 'connect'（含自动
  // 重连）时补发一次，保证主播无论怎么抖动，服务端内存里始终是完整历史。
  // 服务端已把 sync_snapshot 监听器提到鉴权之前注册（server.ts），这里的补发是第二道
  // 保险，也是**重连后**对齐服务端的唯一手段（重连的 socket 没有首帧快照）。
  // 关键：增量必须折回本字段，否则补发的是开分享瞬间的旧态（见 foldIntoSnapshot）。
  private lastSnapshot: SnapshotPayload | null = null;
  /** M2：调用方主动 disconnect() 之后不再上报任何连接态（否则会把「正常停播」
   *  误报成 closed，进而触发调用方的撤链兜底，把 keepForPlayback 的回放链接撤掉）。 */
  private closedByCaller = false;
  private reconnectDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    socketUrl: string,
    options: {
      sessionId: string;
      token: string;
      shareToken: string;
      callbacks?: BroadcasterCallbacks;
    }
  ) {
    this.sessionId = options.sessionId;
    this.callbacks = options.callbacks;
    this.socket = io(socketUrl, {
      withCredentials: true,
      auth: {
        token: options.token,
        sessionId: options.sessionId,
        shareToken: options.shareToken,
      },
    });

    // C16/U11：连上（含重连）后补发最近一次快照。socket.io-client 在每次成功建立
    // 连接时都会触发 'connect'，此处只在有缓存时重发，不重复叠加历史。
    // H1：补发走分块路径 —— 原来这里是无条件 emit 整份快照，快照一超 100KB 就被
    // 传输层以 1009 杀连接、客户端自动重连、再补发同一份，构成永久死循环。
    this.socket.on('connect', () => {
      this.clearReconnectDeadline();
      this.reportConnection('connected');
      if (this.lastSnapshot) {
        this.sendSnapshot(this.lastSnapshot);
      }
    });

    this.socket.on('viewer_count', (payload: { count: number }) => {
      this.callbacks?.onViewerCount?.(payload.count);
    });
    this.socket.on('share_error', (error: { message: string }) => {
      this.callbacks?.onError?.(error);
    });

    // M2：服务端优雅关停会向所有 socket 广播 SERVER_SHUTDOWN（server/websocket.ts）。
    // 主播端此前根本没监听 status_update，这条广播全仓零消费。收到即视为「本次连接
    // 即将中断」，让 UI 立刻进入重连态而不是继续假装一切正常；WS 进程若很快重启，
    // socket.io 会自动重连并触发 'connect' 复位。
    this.socket.on('status_update', (payload: { status?: string }) => {
      if (payload?.status === 'SERVER_SHUTDOWN') {
        this.reportConnection('reconnecting', { reason: 'server_shutdown' });
        this.armReconnectDeadline();
      }
    });

    // M2：底层断连。socket.active 是 socket.io-client 4.x 判定「还会不会自己回来」的
    // 权威标志（socket.js：destroy() 清掉 subs 之后 active===false）：
    // 服务端 disconnect(true)/踢人 → active=false，客户端不会自动重连 → 终态；
    // 传输层抖动/WS 进程重启 → active=true，进入自动重连 → 只报 reconnecting，
    // 并起一个 deadline 兜底，避免无限「重连中」把 UI 永久钉在直播态。
    this.socket.on('disconnect', (reason: string) => {
      if (this.closedByCaller) return;
      if (this.socket.active) {
        this.reportConnection('reconnecting', { reason });
        this.armReconnectDeadline();
        return;
      }
      this.clearReconnectDeadline();
      this.reportConnection('closed', { reason });
    });

    // M2：连接错误。同样用 active 区分「还在退避重试」与「握手被中间件拒了」
    // （Origin 不允许 / 每 IP 连接数上限 —— server/websocket.ts 的 io.use）。
    this.socket.on('connect_error', (error: Error) => {
      if (this.closedByCaller) return;
      if (this.socket.active) {
        this.reportConnection('reconnecting', { message: error?.message });
        this.armReconnectDeadline();
        return;
      }
      this.clearReconnectDeadline();
      this.reportConnection('closed', { message: error?.message });
    });
  }

  private reportConnection(
    state: BroadcasterConnectionState,
    info?: { reason?: string; message?: string }
  ) {
    if (this.closedByCaller) return;
    this.callbacks?.onConnectionChange?.(state, info);
  }

  private armReconnectDeadline() {
    if (this.reconnectDeadlineTimer) return;
    this.reconnectDeadlineTimer = setTimeout(() => {
      this.reconnectDeadlineTimer = null;
      if (this.closedByCaller || this.socket.connected) return;
      // 超过服务端宽限期仍未回来：停止无谓重连并上报终态，由调用方收尾。
      this.closeInternally();
      this.callbacks?.onConnectionChange?.('closed', { reason: 'reconnect_timeout' });
    }, RECONNECT_DEADLINE_MS);
  }

  private clearReconnectDeadline() {
    if (this.reconnectDeadlineTimer) {
      clearTimeout(this.reconnectDeadlineTimer);
      this.reconnectDeadlineTimer = null;
    }
  }

  /** 内部停机：停掉重连并静音后续回调，但不冒充调用方的 disconnect 语义。 */
  private closeInternally() {
    this.closedByCaller = true;
    this.clearReconnectDeadline();
    this.socket.disconnect();
  }

  /** 底层连接是否可写。未连接时 socket.io-client 会把 emit 塞进 sendBuffer，而
   *  disconnect() 走 destroy() 会把缓冲整个丢掉（L2 实证）——与其发一份注定消失
   *  的包，不如不发：快照有 'connect' 补发兜底，增量有下一次全量快照兜底。 */
  private get canEmit() {
    return this.socket.connected;
  }

  /**
   * H1 兜底闸：任何单条消息都先估算序列化字节数，超过 MAX_LIVE_MESSAGE_BYTES 就
   * **不发**并告警。传输层对超限帧的处置是 close 1009（直接杀连接），发出去等于
   * 自杀；丢一条增量最多让晚加入的观众少一段 backlog，代价小得多。
   */
  private emitWithinLimit(event: string, payload: unknown): boolean {
    if (!this.canEmit) return false;

    const bytes = jsonByteLength(payload);
    if (bytes > MAX_LIVE_MESSAGE_BYTES) {
      console.warn(
        `[liveShare] dropped oversized ${event} payload (${bytes} bytes > ${MAX_LIVE_MESSAGE_BYTES}); ` +
          'sending it would trip the 100KB transport limit and kill the broadcast socket'
      );
      return false;
    }

    this.socket.emit(event, payload);
    return true;
  }

  /**
   * H1：把全量快照按字节切块后逐块发出。分块语义见 snapshotChunking.ts 的 I1–I4：
   * 首块全量覆盖、后续块追加、服务端集齐才原子提交。整个循环同步完成、中途不 await，
   * 因此不会有增量 broadcast 插进块序列中间（服务端按到达顺序处理）。
   */
  private sendSnapshot(snapshot: SnapshotPayload) {
    if (!this.canEmit) return;

    const { chunks, truncated, droppedSegments, droppedSummaryBlocks, droppedOversized } =
      buildSnapshotChunks(snapshot);

    if (truncated) {
      console.warn(
        `[liveShare] live snapshot exceeded the transport budget; truncated to the most recent content ` +
          `(dropped ${droppedSegments} segments, ${droppedSummaryBlocks} summary blocks, ${droppedOversized} oversized items). ` +
          'Late-joining viewers will see a partial backlog.'
      );
    }

    for (const chunk of chunks) {
      this.emitWithinLimit('sync_snapshot', chunk);
    }
  }

  syncSnapshot(snapshot: SnapshotPayload) {
    // 记住最新快照，供 'connect' 补发；服务端 sync_snapshot 为全量覆盖语义，
    // 重发同一份不会叠加，只会把服务端内存对齐到最新全量状态。
    this.lastSnapshot = snapshot;
    // 未连接时不发：包会进 sendBuffer 并在 'connect' 时先于我们的补发被冲出去，
    // 那份是**未分块的整包**，正好又踩回 H1 的 1009 陷阱。交给 'connect' 补发即可。
    this.sendSnapshot(snapshot);
  }

  /**
   * U11：把增量折回缓存快照。调用方只在开分享那一刻 syncSnapshot 一次，之后全靠
   * 增量；若增量不折回，'connect' 补发的就是「开分享瞬间」的旧快照——而服务端
   * sync_snapshot 是**全量覆盖**语义，主播抖动重连后这份旧快照会把服务端累积的
   * 增量整个抹掉，晚加入的观众只看到残缺 backlog（主播离线 >20s 更是空的）。
   * 与服务端 mergeEventIntoSnapshot 同口径：按 id 原地替换，无则追加。
   *
   * lastSnapshot 为空（尚未 syncSnapshot）时不凭空造一份：残缺快照一旦补发，
   * 反而会覆盖掉服务端从草稿恢复出的完整历史。
   */
  private foldIntoSnapshot(mutate: (snapshot: SnapshotPayload) => void) {
    if (!this.lastSnapshot) return;
    mutate(this.lastSnapshot);
  }

  broadcastTranscriptDelta(delta: Partial<TranscriptSegment>) {
    this.foldIntoSnapshot((snapshot) => {
      const id = delta.id;
      const index = id
        ? snapshot.segments.findIndex((segment) => segment.id === id)
        : -1;
      if (index === -1) {
        snapshot.segments = [...snapshot.segments, delta as TranscriptSegment];
      } else {
        snapshot.segments = snapshot.segments.map((segment, i) =>
          i === index ? (delta as TranscriptSegment) : segment
        );
      }
    });

    this.emitWithinLimit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'transcript_delta',
        payload: delta,
        timestamp: Date.now(),
      },
    });
  }

  broadcastTranslationDelta(
    segmentId: string,
    translation: string,
    meta?: { sourceLang?: string; targetLang?: string; translationMode?: string }
  ) {
    const MAX_TRANSLATION_LENGTH = 10_000;
    const safeTrans = translation.length > MAX_TRANSLATION_LENGTH
      ? translation.slice(0, MAX_TRANSLATION_LENGTH)
      : translation;

    this.foldIntoSnapshot((snapshot) => {
      snapshot.translations = {
        ...snapshot.translations,
        [segmentId]: safeTrans,
      };
      if (meta?.sourceLang) snapshot.sourceLang = meta.sourceLang;
      if (meta?.targetLang) snapshot.targetLang = meta.targetLang;
      if (meta?.translationMode) snapshot.translationMode = meta.translationMode;
    });

    this.emitWithinLimit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'translation_delta',
        payload: { segmentId, translation: safeTrans, ...meta },
        timestamp: Date.now(),
      },
    });
  }

  broadcastSummaryUpdate(summaryBlock: SummaryBlock) {
    this.foldIntoSnapshot((snapshot) => {
      // 与服务端 mergeSummaryBlock 一致：优先按 id 匹配，缺 id 时退到 blockIndex
      const index = snapshot.summaryBlocks.findIndex((block) => {
        if (summaryBlock.id && block.id) return block.id === summaryBlock.id;
        if (
          typeof summaryBlock.blockIndex === 'number' &&
          typeof block.blockIndex === 'number'
        ) {
          return block.blockIndex === summaryBlock.blockIndex;
        }
        return false;
      });
      if (index === -1) {
        snapshot.summaryBlocks = [...snapshot.summaryBlocks, summaryBlock];
      } else {
        snapshot.summaryBlocks = snapshot.summaryBlocks.map((block, i) =>
          i === index ? summaryBlock : block
        );
      }
    });

    this.emitWithinLimit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'summary_update',
        payload: summaryBlock,
        timestamp: Date.now(),
      },
    });
  }

  /** 广播实时预览文本（正在说的内容，尚未确认为完整段落） */
  broadcastPreviewUpdate(payload: {
    previewText: StreamingPreviewText;
    previewTranslation: StreamingPreviewTranslation;
  }) {
    this.foldIntoSnapshot((snapshot) => {
      snapshot.previewText = payload.previewText;
      snapshot.previewTranslation = payload.previewTranslation;
    });

    this.emitWithinLimit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'preview_update',
        payload,
        timestamp: Date.now(),
      },
    });
  }

  broadcastStatusUpdate(status: string) {
    this.foldIntoSnapshot((snapshot) => {
      snapshot.status = status;
    });

    return this.emitWithinLimit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'status_update',
        payload: { status },
        timestamp: Date.now(),
      },
    });
  }

  /** 底层 socket 当前是否已连接（调用方据此判断广播是否真的发得出去，见 L2）。 */
  get isConnected() {
    return this.socket.connected;
  }

  disconnect() {
    this.closedByCaller = true;
    this.clearReconnectDeadline();
    this.socket.disconnect();
  }
}
