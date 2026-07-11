import { beforeEach, describe, expect, it } from 'vitest';
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
