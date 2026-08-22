import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  tryAcquireConversationTurn,
  __resetConversationTurnLocks,
} from '@/lib/llm/conversationTurnLock';

describe('conversationTurnLock（H3 每对话单飞行中回复锁）', () => {
  beforeEach(() => {
    __resetConversationTurnLocks();
  });

  it('第一次获取成功，未释放前同对话再次获取返回 null', () => {
    const release = tryAcquireConversationTurn('c1');
    expect(release).toBeTypeOf('function');
    expect(tryAcquireConversationTurn('c1')).toBeNull();
  });

  it('释放后可再次获取', () => {
    const release = tryAcquireConversationTurn('c1');
    release!();
    const again = tryAcquireConversationTurn('c1');
    expect(again).not.toBeNull();
  });

  it('不同对话互不影响', () => {
    const a = tryAcquireConversationTurn('a');
    const b = tryAcquireConversationTurn('b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('释放是幂等的（重复调用不抛错、不误放后来者的锁）', () => {
    const release = tryAcquireConversationTurn('c1');
    release!();
    // 后来者拿到新锁
    const second = tryAcquireConversationTurn('c1');
    expect(second).not.toBeNull();
    // 旧持有者重复释放不应把新锁删掉
    release!();
    expect(tryAcquireConversationTurn('c1')).toBeNull();
  });
});

/**
 * M14：`at` 只在获取时写一次 + STALE_MS=3min，而 gateway 的流式调用**不限制 SSE body
 * 时长**（只给响应头设 60s 超时）。深度思考 + 长上下文生成跑过 3 分钟完全现实，
 * 旧实现下第二个并发请求会把仍在生成的锁当成"泄漏锁"抢占成功 —— 两个 in-flight 流
 * 各自落库 assistant 消息，正是这把锁声称要杜绝的交错。
 *
 * 这组用例锁住：持锁期间自动续期；但续期不是无限的（泄漏锁仍能自愈）。
 */
describe('conversationTurnLock（M14 心跳续期）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    __resetConversationTurnLocks();
  });

  afterEach(() => {
    __resetConversationTurnLocks();
    vi.useRealTimers();
  });

  it('持锁超过 STALE_MS(3min) 期间不会被抢占 —— 长回答生成中锁必须活着', () => {
    const release = tryAcquireConversationTurn('c-long');
    expect(release).toBeTypeOf('function');

    // 4 分钟：旧实现此刻已判定"泄漏锁"并放行第二轮
    vi.advanceTimersByTime(4 * 60_000);
    expect(tryAcquireConversationTurn('c-long')).toBeNull();

    // 累计 10 分钟仍在生成中
    vi.advanceTimersByTime(6 * 60_000);
    expect(tryAcquireConversationTurn('c-long')).toBeNull();

    // 正常结束后立刻放行
    release!();
    expect(tryAcquireConversationTurn('c-long')).not.toBeNull();
  });

  it('续期有上限：超过 MAX_HOLD_MS(15min) 停止心跳，再过 STALE_MS 可被抢占（泄漏锁自愈）', () => {
    tryAcquireConversationTurn('c-leak'); // 故意不 release，模拟泄漏

    // 15 分 30 秒：心跳已在 15min 那一拍停掉，但距最后一次心跳还不到 3 分钟
    vi.advanceTimersByTime(15 * 60_000 + 30_000);
    expect(tryAcquireConversationTurn('c-leak')).toBeNull();

    // 再过 3 分钟以上 → STALE 生效，允许重新获取
    vi.advanceTimersByTime(3 * 60_000 + 1_000);
    expect(tryAcquireConversationTurn('c-leak')).not.toBeNull();
  });

  it('释放后心跳停止，不会让"已释放的锁"继续占位', () => {
    const release = tryAcquireConversationTurn('c-done');
    vi.advanceTimersByTime(60_000);
    release!();

    const second = tryAcquireConversationTurn('c-done');
    expect(second).not.toBeNull();
    // 旧持有者的心跳若还活着，会去续期 map 里那把（新）锁 —— 这里推进时间后
    // 新锁应当照常按自己的节奏工作，且旧 release 再调不影响新锁。
    vi.advanceTimersByTime(4 * 60_000);
    expect(tryAcquireConversationTurn('c-done')).toBeNull();
    second!();
    expect(tryAcquireConversationTurn('c-done')).not.toBeNull();
  });
});
