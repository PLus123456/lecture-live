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
 * 每把锁带获取时间戳：超过 STALE_MS 视为持有者崩溃/漏 release 的泄漏锁，允许被重新获取，
 * 避免一次异常把对话永久卡死。
 */

const STALE_MS = 3 * 60_000;

interface Held {
  at: number;
  id: number;
}

const inflight = new Map<string, Held>();
let seq = 0;

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

  const id = ++seq;
  inflight.set(conversationId, { at: now, id });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 只删「自己这把」：若本锁已因 STALE 被后来者抢占，别误删新持有者的锁。
    const cur = inflight.get(conversationId);
    if (cur && cur.id === id) {
      inflight.delete(conversationId);
    }
  };
}

/** 仅供测试：清空所有进行中锁。 */
export function __resetConversationTurnLocks(): void {
  inflight.clear();
  seq = 0;
}
