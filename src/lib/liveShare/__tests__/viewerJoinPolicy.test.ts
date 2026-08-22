import { describe, expect, it } from 'vitest';
import {
  consumeViewerJoinAttempt,
  createViewerInitialStateBudget,
  createViewerJoinRateState,
  parseViewerJoinToken,
  reserveViewerInitialStateBytes,
  VIEWER_JOIN_BUCKET_CAPACITY,
} from '@/lib/liveShare/viewerJoinPolicy';

describe('viewer join policy', () => {
  it('只允许真实 token 字符集，外围空白归一但中间标点别名被拒绝', () => {
    expect(parseViewerJoinToken({ shareToken: '  share-token_1  ' })).toEqual({
      ok: true,
      token: 'share-token_1',
    });
    expect(parseViewerJoinToken({ shareToken: 'share!token_1' })).toMatchObject({
      ok: false,
      code: 'INVALID_SHARE_TOKEN',
    });
    expect(parseViewerJoinToken({ shareToken: 'x'.repeat(300) })).toMatchObject({
      ok: false,
      code: 'INVALID_SHARE_TOKEN',
    });
    expect(parseViewerJoinToken(null)).toMatchObject({ ok: false });
  });

  it('DB 前成本桶限制突发，并按低速率恢复', () => {
    const state = createViewerJoinRateState(0);
    for (let i = 0; i < VIEWER_JOIN_BUCKET_CAPACITY; i += 1) {
      expect(consumeViewerJoinAttempt(state, 0)).toBe(true);
    }
    expect(consumeViewerJoinAttempt(state, 0)).toBe(false);
    expect(consumeViewerJoinAttempt(state, 4_999)).toBe(false);
    expect(consumeViewerJoinAttempt(state, 5_000)).toBe(true);
    expect(consumeViewerJoinAttempt(state, 5_000)).toBe(false);
  });

  it('按累计 UTF-8 envelope 字节原子预留 initial_state 响应预算', () => {
    const budget = createViewerInitialStateBudget();
    expect(reserveViewerInitialStateBytes(budget, 60, 100)).toBe(true);
    expect(budget.sentBytes).toBe(60);
    expect(reserveViewerInitialStateBytes(budget, 41, 100)).toBe(false);
    expect(budget.sentBytes).toBe(60);
    expect(reserveViewerInitialStateBytes(budget, 40, 100)).toBe(true);
    expect(budget.sentBytes).toBe(100);
  });
});
