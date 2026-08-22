import { describe, expect, it } from 'vitest';
import {
  canonicalizeLiveEvent,
  canonicalizeLiveSnapshot,
  createEmptyLiveSnapshot,
  LiveSnapshotStore,
  socketIoEventByteLength,
  utf8JsonByteLength,
} from '@/lib/liveShare/snapshotPolicy';

function segment(id: string, text = 'Hello') {
  return {
    id,
    sessionIndex: 0,
    speaker: 'speaker-1',
    language: 'en',
    text,
    globalStartMs: 0,
    globalEndMs: 1000,
    startMs: 0,
    endMs: 1000,
    isFinal: true,
    confidence: 0.99,
    timestamp: '00:00:00',
  };
}

function summary(id: string, text = 'Summary') {
  return {
    id,
    blockIndex: 0,
    timeRange: { startMs: 0, endMs: 1000 },
    keyPoints: ['point'],
    definitions: { term: 'definition' },
    summary: text,
    suggestedQuestions: ['question'],
    frozen: false,
  };
}

function snapshotInput(overrides: Record<string, unknown> = {}) {
  return {
    segments: [segment('seg-1')],
    translations: { 'seg-1': '你好' },
    summaryBlocks: [summary('sum-1')],
    status: 'RECORDING',
    previewText: { finalText: 'Hel', nonFinalText: 'lo' },
    previewTranslation: {
      finalText: '你',
      nonFinalText: '好',
      state: 'streaming',
      sourceLanguage: 'en',
    },
    sourceLang: 'en',
    targetLang: 'zh',
    translationMode: 'soniox',
    ...overrides,
  };
}

describe('live snapshot canonical schema', () => {
  it('只复制允许字段，并丢弃顶层及深层未知对象', () => {
    const parsed = canonicalizeLiveSnapshot(
      snapshotInput({
        attackerControlled: { nested: 'x'.repeat(1000) },
        segments: [
          {
            ...segment('seg-1'),
            unknown: { nested: ['must', 'not', 'survive'] },
          },
        ],
        summaryBlocks: [
          {
            ...summary('sum-1'),
            hiddenPayload: { deeply: { nested: true } },
          },
        ],
      }),
      1234
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty('attackerControlled');
    expect(parsed.value.segments[0]).not.toHaveProperty('unknown');
    expect(parsed.value.summaryBlocks[0]).not.toHaveProperty('hiddenPayload');
    expect(parsed.value.updatedAt).toBe(1234);
  });

  it('缺少必填字段、危险 record key、任意事件名都显式拒绝', () => {
    const missing = canonicalizeLiveSnapshot(
      snapshotInput({ segments: [{ id: 'seg-only', text: 'partial' }] })
    );
    expect(missing).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' });

    const dangerous = canonicalizeLiveSnapshot(
      snapshotInput({ translations: JSON.parse('{"__proto__":"pollute"}') })
    );
    expect(dangerous).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' });

    const arbitraryEvent = canonicalizeLiveEvent({
      type: 'initial_state',
      payload: { injected: true },
      timestamp: 1,
    });
    expect(arbitraryEvent).toMatchObject({ ok: false, code: 'INVALID_EVENT' });
  });

  it('按 JSON UTF-8 精确计量多字节文本和 Socket.IO envelope', () => {
    const parsed = canonicalizeLiveSnapshot(
      snapshotInput({ segments: [segment('seg-emoji', '😀中文')] }),
      1700000000000
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.bytes).toBe(
      Buffer.byteLength(JSON.stringify(parsed.value), 'utf8')
    );
    expect(socketIoEventByteLength('initial_state', parsed.bytes)).toBe(
      Buffer.byteLength(`42["initial_state",${JSON.stringify(parsed.value)}]`, 'utf8')
    );
  });

  it('canonical event 只留下已知字段', () => {
    const parsed = canonicalizeLiveEvent({
      type: 'translation_delta',
      payload: {
        segmentId: 'seg-1',
        translation: '你好',
        sourceLang: 'en',
        injected: { nested: true },
      },
      timestamp: 10,
      topLevelUnknown: 'drop',
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        type: 'translation_delta',
        payload: {
          segmentId: 'seg-1',
          translation: '你好',
          sourceLang: 'en',
        },
      },
    });
    if (parsed.ok) {
      expect(parsed.value).not.toHaveProperty('topLevelUnknown');
      expect(parsed.value.payload).not.toHaveProperty('injected');
    }
  });
});

describe('LiveSnapshotStore aggregate byte budgets', () => {
  it('逐条合法增量达到 session 上限后原子拒绝，旧快照和账本不变', () => {
    const empty = createEmptyLiveSnapshot(1000);
    const emptyBytes = utf8JsonByteLength(empty);
    const store = new LiveSnapshotStore({
      perSessionBytes: emptyBytes + 900,
      perUserBytes: 100_000,
      globalBytes: 100_000,
    });
    expect(store.set('session-1', 'user-1', empty).ok).toBe(true);

    const first = store.applyEvent('session-1', 'user-1', {
      type: 'transcript_delta',
      payload: segment('seg-1', 'small'),
      timestamp: 1,
    }, 1001);
    expect(first.ok).toBe(true);
    const bytesAfterFirst = store.getBytes('session-1');
    const snapshotAfterFirst = JSON.stringify(store.get('session-1'));

    const rejected = store.applyEvent('session-1', 'user-1', {
      type: 'transcript_delta',
      payload: segment('seg-2', 'x'.repeat(2000)),
      timestamp: 2,
    }, 1002);
    expect(rejected).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_SESSION_LIMIT',
    });
    expect(store.getBytes('session-1')).toBe(bytesAfterFirst);
    expect(JSON.stringify(store.get('session-1'))).toBe(snapshotAfterFirst);
    expect(store.getGlobalBytes()).toBe(bytesAfterFirst);
  });

  it('同 id 替换按差量释放字节，账本始终等于真实 JSON 字节', () => {
    const store = new LiveSnapshotStore({
      perSessionBytes: 100_000,
      perUserBytes: 100_000,
      globalBytes: 100_000,
    });
    store.set('session-1', 'user-1', createEmptyLiveSnapshot(1000));

    expect(
      store.applyEvent('session-1', 'user-1', {
        type: 'transcript_delta',
        payload: segment('seg-1', '大'.repeat(1000)),
        timestamp: 1,
      }, 1001).ok
    ).toBe(true);
    const largeBytes = store.getBytes('session-1')!;

    expect(
      store.applyEvent('session-1', 'user-1', {
        type: 'transcript_delta',
        payload: segment('seg-1', '小'),
        timestamp: 2,
      }, 1002).ok
    ).toBe(true);
    const smallBytes = store.getBytes('session-1')!;
    expect(smallBytes).toBeLessThan(largeBytes);
    expect(smallBytes).toBe(utf8JsonByteLength(store.get('session-1')));
    expect(store.getUserBytes('user-1')).toBe(smallBytes);
    expect(store.getGlobalBytes()).toBe(smallBytes);
  });

  it('所有增量类型及元数据替换后，账本都等于实际 canonical JSON 字节', () => {
    const store = new LiveSnapshotStore({
      perSessionBytes: 100_000,
      perUserBytes: 100_000,
      globalBytes: 100_000,
    });
    store.set('session-1', 'user-1', createEmptyLiveSnapshot(1000));

    const events = [
      {
        type: 'translation_delta',
        payload: {
          segmentId: 'seg-1',
          translation: '多字节😀',
          sourceLang: 'en',
          targetLang: 'zh',
          translationMode: 'both',
        },
        timestamp: 1,
      },
      {
        type: 'summary_update',
        payload: summary('sum-1', '完整摘要'),
        timestamp: 2,
      },
      {
        type: 'status_update',
        payload: { status: 'PAUSED' },
        timestamp: 3,
      },
      {
        type: 'preview_update',
        payload: {
          previewText: { finalText: '已确认', nonFinalText: '继续' },
          previewTranslation: {
            finalText: 'done',
            nonFinalText: 'streaming',
            state: 'streaming',
            sourceLanguage: 'zh',
          },
        },
        timestamp: 4,
      },
      {
        type: 'translation_delta',
        payload: { segmentId: 'seg-1', translation: '短' },
        timestamp: 5,
      },
    ];

    events.forEach((event, index) => {
      const applied = store.applyEvent(
        'session-1',
        'user-1',
        event,
        2_000 + index
      );
      expect(applied.ok).toBe(true);
      const exactBytes = utf8JsonByteLength(store.get('session-1'));
      expect(store.getBytes('session-1')).toBe(exactBytes);
      expect(store.getUserBytes('user-1')).toBe(exactBytes);
      expect(store.getGlobalBytes()).toBe(exactBytes);
    });
  });

  it('分别执行 user/global 预算，并在 delete/clear 时完整归还', () => {
    const one = createEmptyLiveSnapshot(1700000000000);
    const bytes = utf8JsonByteLength(one);

    const perUserStore = new LiveSnapshotStore({
      perSessionBytes: bytes + 10,
      perUserBytes: bytes * 2 - 1,
      globalBytes: bytes * 10,
    });
    expect(perUserStore.set('s1', 'u1', one).ok).toBe(true);
    expect(
      perUserStore.set('s2', 'u1', createEmptyLiveSnapshot(1700000000000))
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_USER_LIMIT' });

    const globalStore = new LiveSnapshotStore({
      perSessionBytes: bytes + 10,
      perUserBytes: bytes * 10,
      globalBytes: bytes * 2 - 1,
    });
    expect(globalStore.set('s1', 'u1', createEmptyLiveSnapshot(1700000000000)).ok).toBe(true);
    expect(
      globalStore.set('s2', 'u2', createEmptyLiveSnapshot(1700000000000))
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_GLOBAL_LIMIT' });

    expect(globalStore.delete('s1')).toBe(true);
    expect(globalStore.getGlobalBytes()).toBe(0);
    expect(globalStore.getUserBytes('u1')).toBe(0);
    expect(globalStore.set('s2', 'u2', createEmptyLiveSnapshot(1700000000000)).ok).toBe(true);
    globalStore.clear();
    expect(globalStore.getGlobalBytes()).toBe(0);
    expect(globalStore.getUserBytes('u2')).toBe(0);
  });

  it('full snapshot 替换也同时校验 owner 与全局账本', () => {
    const parsed = canonicalizeLiveSnapshot(snapshotInput(), 1000);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const store = new LiveSnapshotStore({
      perSessionBytes: parsed.bytes + 100,
      perUserBytes: parsed.bytes + 100,
      globalBytes: parsed.bytes + 100,
    });
    expect(store.set('s1', 'u1', parsed.value).ok).toBe(true);
    const wrongOwner = store.applyEvent('s1', 'u2', {
      type: 'status_update',
      payload: { status: 'PAUSED' },
      timestamp: 1,
    });
    expect(wrongOwner).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_OWNER_MISMATCH',
    });
    expect(store.setIfAbsent('s1', 'u2', parsed.value)).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_OWNER_MISMATCH',
    });
    expect(store.set('s1', 'u2', parsed.value)).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_OWNER_MISMATCH',
    });
  });

  it('full snapshot 写入同样受实例级数量预算约束', () => {
    const parsed = canonicalizeLiveSnapshot(snapshotInput(), 1000);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const store = new LiveSnapshotStore({
      perSessionBytes: 100_000,
      perUserBytes: 100_000,
      globalBytes: 100_000,
      maxSegments: 0,
    });
    expect(store.set('s1', 'u1', parsed.value)).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_COUNT_LIMIT',
    });
    expect(store.getGlobalBytes()).toBe(0);
  });

  it('小型空快照也受每用户/全局活跃会话数约束，并在删除后释放', () => {
    const snapshot = createEmptyLiveSnapshot(1000);
    const perUserStore = new LiveSnapshotStore({
      perSessionBytes: 100_000,
      perUserBytes: 100_000,
      globalBytes: 100_000,
      maxActiveSessionsPerUser: 1,
      maxActiveSessionsGlobal: 10,
    });
    expect(perUserStore.set('s1', 'u1', snapshot).ok).toBe(true);
    expect(perUserStore.set('s2', 'u1', snapshot)).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_COUNT_LIMIT',
    });
    expect(perUserStore.getUserSessionCount('u1')).toBe(1);
    expect(perUserStore.delete('s1')).toBe(true);
    expect(perUserStore.getUserSessionCount('u1')).toBe(0);
    expect(perUserStore.set('s2', 'u1', snapshot).ok).toBe(true);

    const globalStore = new LiveSnapshotStore({
      perSessionBytes: 100_000,
      perUserBytes: 100_000,
      globalBytes: 100_000,
      maxActiveSessionsPerUser: 10,
      maxActiveSessionsGlobal: 1,
    });
    expect(globalStore.set('s1', 'u1', snapshot).ok).toBe(true);
    expect(globalStore.set('s2', 'u2', snapshot)).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_COUNT_LIMIT',
    });
  });
});
