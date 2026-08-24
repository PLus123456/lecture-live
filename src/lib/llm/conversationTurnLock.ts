/**
 * 进程内「每对话单飞行中回复」锁。
 *
 * 目的：防止同一 conversation 的并发请求交错落库成 U1 → U2 → A2 → A1（问答错配）——
 * 服务端先读历史快照、再分别写 user / assistant，两条并发轮次没有任何 turn 序列化时会交错。
 * 第二个并发请求 fail-fast 返回 null，路由据此回 409，让客户端稍后重试；被放行的那一轮持锁
 * 直到 assistant 落库/收尾（或流被取消）后释放。这样同一对话的轮次强制串行为
 * U1 → A1 → U2 → A2，问答配对不再错乱。
 *
 * 局限：仅进程内有效。多实例部署时跨实例并发不受此约束（真正的跨实例串行需要 DB 行锁或
 * turnId，属更大改动）。此处覆盖最常见的「同一用户多标签页打到同一实例」场景。
 *
 * 心跳续期（M14）：
 * 每把锁带一个「最后心跳时间」，超过 STALE_MS 无心跳才视为持有者崩溃/漏 release 的泄漏锁、
 * 允许被重新获取。**持锁期间由本模块自己每 HEARTBEAT_MS 续期一次**——此前 `at` 只在获取时
 * 写一次，而 gateway 的流式调用只给「响应头到达」设超时、不限制 SSE body 时长
 * （见 gateway.ts 顶部注释），深度思考 + 长上下文生成超过 3 分钟完全现实：旧实现下第二个
 * 并发请求会把仍在生成的锁误判成泄漏锁并抢占成功，两个 in-flight 流各自持久化 assistant
 * 消息，正是本锁声称要杜绝的交错。
 *
 * 心跳不是无限的：超过 MAX_HOLD_MS 就停止续期（并打 warn），让锁在 STALE_MS 后重新可被抢占，
 * 保留「一次异常不把对话永久卡死」的自愈语义。正常生成远达不到这个上限，一旦触到即说明
 * 有 release 泄漏或上游卡死，日志里能看见。
 */

import { logger } from '@/lib/logger';

const lockLogger = logger.child({ component: 'conversation-turn-lock' });

const STALE_MS = 3 * 60_000;
/** 持锁期间的续期间隔；必须显著小于 STALE_MS，留足抖动余量。 */
const HEARTBEAT_MS = 30_000;
/** 单把锁最长可续期时长；超过即停止心跳，交回 STALE_MS 自愈路径。 */
const MAX_HOLD_MS = 15 * 60_000;

interface Held {
  /** 最后一次心跳时间（不是获取时间）——STALE 判定基于它 */
  at: number;
  /** 获取时间，用于 MAX_HOLD_MS 上限判定 */
  acquiredAt: number;
  id: number;
  timer: ReturnType<typeof setInterval> | null;
}

const inflight = new Map<string, Held>();
let seq = 0;

function stopHeartbeat(held: Held): void {
  if (held.timer !== null) {
    clearInterval(held.timer);
    held.timer = null;
  }
}

/**
 * 尝试获取某对话的「进行中回复」锁。
 * @returns 释放函数（幂等）；若已有未过期的进行中回复则返回 null。
 */
export function tryAcquireConversationTurn(
  conversationId: string
): (() => void) | null {
  const now = Date.now();
  const existing = inflight.get(conversationId);
  if (existing && now - existing.at < STALE_MS) {
    return null;
  }
  // 抢占一把已 STALE 的泄漏锁时，先把它残留的心跳定时器停掉，
  // 否则旧定时器会继续跑（它自己会发现 id 不匹配后退出，但没必要多等一轮）。
  if (existing) stopHeartbeat(existing);

  const id = ++seq;
  const held: Held = { at: now, acquiredAt: now, id, timer: null };
  inflight.set(conversationId, held);

  held.timer = setInterval(() => {
    // 只有「自己仍是当前持有者」才续期；被抢占/已释放则自杀。
    const cur = inflight.get(conversationId);
    if (!cur || cur.id !== id) {
      stopHeartbeat(held);
      return;
    }
    if (Date.now() - cur.acquiredAt >= MAX_HOLD_MS) {
      lockLogger.warn(
        { conversationId, heldMs: Date.now() - cur.acquiredAt },
        '对话轮次锁持有超过上限，停止续期（疑似 release 泄漏或上游卡死），STALE 后可被抢占'
      );
      stopHeartbeat(cur);
      return;
    }
    cur.at = Date.now();
  }, HEARTBEAT_MS);
  // 心跳定时器不应该把 Node 进程钉住不退出。
  (held.timer as unknown as { unref?: () => void }).unref?.();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    stopHeartbeat(held);
    // 只删「自己这把」：若本锁已因 STALE 被后来者抢占，别误删新持有者的锁。
    const cur = inflight.get(conversationId);
    if (cur && cur.id === id) {
      inflight.delete(conversationId);
    }
  };
}

/** 仅供测试：清空所有进行中锁。 */
export function __resetConversationTurnLocks(): void {
  for (const held of inflight.values()) stopHeartbeat(held);
  inflight.clear();
  seq = 0;
}
