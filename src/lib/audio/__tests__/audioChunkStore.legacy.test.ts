import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C51/P6-8：legacy `chunks` store 的跨会话 / 跨账号泄漏。
 *
 * v1 的 `chunks` store 存的是**裸 Blob，没有 sessionId**。旧实现在「本会话查不到分片」时
 * 会回落到对它做 `getAll()`——于是任意会话（换账号后新建的也算）在 finalize 时都会把这堆
 * 陈年音频当作自己的分片上传（useSoniox 的 syncRemoteDraft）。
 *
 * 这里用一个最小可用的 IndexedDB 替身：能预置一个「v2 + 残留 legacy store」的库，
 * 从而真实地跑一遍 v3 升级路径。
 */

// ────────────────── 最小 IndexedDB 替身 ──────────────────

interface FakeStore {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  counter: number;
  records: Map<string, unknown>;
  indexes: Map<string, string>;
}

interface FakeDatabase {
  version: number;
  stores: Map<string, FakeStore>;
}

const databases = new Map<string, FakeDatabase>();

function serializeKey(key: unknown): string {
  return JSON.stringify(key);
}

function extractKey(store: FakeStore, value: Record<string, unknown>): unknown {
  if (Array.isArray(store.keyPath)) {
    return store.keyPath.map((part) => value[part]);
  }
  if (typeof store.keyPath === 'string') {
    return value[store.keyPath];
  }
  store.counter += 1;
  return store.counter;
}

class FakeKeyRange {
  constructor(public value: unknown) {}
}

function makeRequest<T>(run: () => T) {
  const request: {
    result?: T;
    error: unknown;
    onsuccess: ((event: { target: unknown }) => void) | null;
    onerror: (() => void) | null;
  } = { error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.({ target: request });
    } catch (err) {
      request.error = err;
      request.onerror?.();
    }
  });
  return request;
}

function makeIndex(store: FakeStore, indexKeyPath: string) {
  const matching = (range: FakeKeyRange | undefined) =>
    Array.from(store.records.values()).filter((record) => {
      if (!range) return true;
      return (record as Record<string, unknown>)[indexKeyPath] === range.value;
    });

  return {
    getAll: (range?: FakeKeyRange) => makeRequest(() => matching(range)),
    count: (range?: FakeKeyRange) => makeRequest(() => matching(range).length),
    openKeyCursor: (range?: FakeKeyRange) => {
      const keys = Array.from(store.records.entries())
        .filter(([, record]) =>
          range
            ? (record as Record<string, unknown>)[indexKeyPath] === range.value
            : true
        )
        .map(([key]) => key);
      const request: {
        onsuccess: ((event: { target: { result: unknown } }) => void) | null;
      } = { onsuccess: null };
      queueMicrotask(() => {
        let i = 0;
        const step = () => {
          if (i >= keys.length) {
            request.onsuccess?.({ target: { result: null } });
            return;
          }
          const serialized = keys[i];
          i += 1;
          request.onsuccess?.({
            target: {
              result: {
                primaryKey: JSON.parse(serialized),
                continue: () => step(),
              },
            },
          });
        };
        step();
      });
      return request;
    },
  };
}

function makeObjectStore(store: FakeStore) {
  return {
    put: (value: Record<string, unknown>) =>
      makeRequest(() => {
        store.records.set(serializeKey(extractKey(store, value)), value);
      }),
    delete: (key: unknown) => makeRequest(() => store.records.delete(serializeKey(key))),
    clear: () => makeRequest(() => store.records.clear()),
    get: (key: unknown) => makeRequest(() => store.records.get(serializeKey(key))),
    getAll: () => makeRequest(() => Array.from(store.records.values())),
    index: (name: string) => makeIndex(store, store.indexes.get(name) as string),
    createIndex: (name: string, keyPath: string) => {
      store.indexes.set(name, keyPath);
    },
  };
}

function makeTransaction(db: FakeDatabase, names: string | string[]) {
  const list = Array.isArray(names) ? names : [names];
  const tx: {
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    error: unknown;
    objectStore: (name: string) => ReturnType<typeof makeObjectStore>;
  } = {
    oncomplete: null,
    onerror: null,
    error: null,
    objectStore: (name: string) => {
      if (!list.includes(name)) throw new Error(`store ${name} not in transaction`);
      const store = db.stores.get(name);
      if (!store) throw new Error(`store ${name} missing`);
      return makeObjectStore(store);
    },
  };
  // 让本轮所有 request 的微任务先跑完，再触发 oncomplete
  queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.())));
  return tx;
}

function makeDbHandle(db: FakeDatabase) {
  return {
    version: db.version,
    objectStoreNames: {
      contains: (name: string) => db.stores.has(name),
    },
    createObjectStore: (
      name: string,
      options?: { keyPath?: string | string[]; autoIncrement?: boolean }
    ) => {
      const store: FakeStore = {
        keyPath: options?.keyPath ?? null,
        autoIncrement: options?.autoIncrement ?? false,
        counter: 0,
        records: new Map(),
        indexes: new Map(),
      };
      db.stores.set(name, store);
      return makeObjectStore(store);
    },
    deleteObjectStore: (name: string) => {
      db.stores.delete(name);
    },
    transaction: (names: string | string[]) => makeTransaction(db, names),
  };
}

function installFakeIndexedDB() {
  const fake = {
    open(name: string, version: number) {
      const request: {
        result?: ReturnType<typeof makeDbHandle>;
        error: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = {
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = { version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const needsUpgrade = version > db.version;
        db.version = Math.max(db.version, version);
        request.result = makeDbHandle(db);
        if (needsUpgrade) {
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  vi.stubGlobal('indexedDB', fake);
  vi.stubGlobal('IDBKeyRange', {
    only: (value: unknown) => new FakeKeyRange(value),
  });
  vi.stubGlobal('sessionStorage', {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
}

// ────────────────── 用例 ──────────────────

async function importStore() {
  vi.resetModules();
  return import('@/lib/audio/audioChunkStore');
}

/** 预置一个「v2 + 残留 legacy chunks store」的库，模拟 v1 时代升上来的浏览器。 */
function seedLegacyDatabase() {
  const legacy: FakeStore = {
    keyPath: null,
    autoIncrement: true,
    counter: 0,
    records: new Map([
      ['1', { size: 1 } as unknown],
      ['2', { size: 2 } as unknown],
    ]),
    indexes: new Map(),
  };
  const chunkStore: FakeStore = {
    keyPath: ['sessionId', 'seq'],
    autoIncrement: false,
    counter: 0,
    records: new Map(),
    indexes: new Map([['bySessionId', 'sessionId']]),
  };
  const sessionStore: FakeStore = {
    keyPath: 'sessionId',
    autoIncrement: false,
    counter: 0,
    records: new Map(),
    indexes: new Map(),
  };
  databases.set('lecture-live-audio', {
    version: 2,
    stores: new Map([
      ['chunks', legacy],
      ['session_chunks', chunkStore],
      ['sessions', sessionStore],
    ]),
  });
}

describe('audioChunkStore —— legacy store 跨会话泄漏 (C51 / P6-8)', () => {
  beforeEach(() => {
    databases.clear();
    installFakeIndexedDB();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('打开时把 v1 遗留的 chunks store 删掉', async () => {
    seedLegacyDatabase();
    const store = await importStore();

    await store.getAudioChunkEntries('session-a');

    expect(databases.get('lecture-live-audio')?.stores.has('chunks')).toBe(false);
  });

  it('本会话没有分片时返回空，绝不回落到别人的音频', async () => {
    seedLegacyDatabase();
    const store = await importStore();

    const entries = await store.getAudioChunkEntries('brand-new-session');

    expect(entries).toEqual([]);
  });

  it('hasAudioChunks 同样不因 legacy 残留而误报 true', async () => {
    seedLegacyDatabase();
    const store = await importStore();

    expect(await store.hasAudioChunks('brand-new-session')).toBe(false);
  });

  it('本会话真有分片时照常按 seq 顺序返回', async () => {
    const store = await importStore();

    await store.appendAudioChunk('session-a', 1, { size: 11 } as unknown as Blob);
    await store.appendAudioChunk('session-a', 0, { size: 10 } as unknown as Blob);
    await store.appendAudioChunk('session-b', 0, { size: 99 } as unknown as Blob);

    const entries = await store.getAudioChunkEntries('session-a');
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(await store.hasAudioChunks('session-a')).toBe(true);
  });
});

describe('clearAllAudioArchives —— 登出清扫 (C51 / P6-8)', () => {
  beforeEach(() => {
    databases.clear();
    installFakeIndexedDB();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('清空所有 session 的分片与会话记录，而不只是某一个', async () => {
    const store = await importStore();

    await store.upsertAudioSession({
      sessionId: 'session-a',
      sourceType: 'mic',
      deviceId: null,
      mimeType: 'audio/webm',
      startedAt: 1,
      updatedAt: 1,
      chunkCount: 1,
      status: 'stopped',
    });
    await store.appendAudioChunk('session-a', 0, { size: 1 } as unknown as Blob);
    await store.appendAudioChunk('session-b', 0, { size: 2 } as unknown as Blob);

    await store.clearAllAudioArchives();

    expect(await store.getAudioChunkEntries('session-a')).toEqual([]);
    expect(await store.getAudioChunkEntries('session-b')).toEqual([]);
    expect(await store.getAudioSession('session-a')).toBeNull();
  });
});
