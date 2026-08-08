/**
 * Session-scoped IndexedDB audio archive storage.
 *
 * Audio chunks are keyed by sessionId + sequence number so we can safely
 * recover recordings after reconnects, refreshes, and retry finalization.
 */

import type { AudioSourceType } from '@/types/transcript';

const DB_NAME = 'lecture-live-audio';
// v3：删掉 v1 遗留的 `chunks` store。它存的是裸 Blob、没有 sessionId，
// 兜底读取只能 getAll() 全取（C51/P6-8）——于是任意会话的 finalize 都会把这堆
// 陈年音频当成自己的分片传上去，换账号后同样成立。见 getAudioChunkEntries 的注释。
const DB_VERSION = 3;
const SESSION_STORE = 'sessions';
const CHUNK_STORE = 'session_chunks';
const LEGACY_CHUNK_STORE = 'chunks';
const LEGACY_ARCHIVE_MIME_KEY = 'lecture-live-archive-mime';
const ARCHIVE_SNAPSHOT_KEY_PREFIX = 'lecture-live-archive-state:';

export type AudioArchiveStatus =
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'stopped';

export interface AudioArchiveSessionRecord {
  sessionId: string;
  sourceType: AudioSourceType;
  deviceId: string | null;
  mimeType: string;
  startedAt: number;
  updatedAt: number;
  chunkCount: number;
  status: AudioArchiveStatus;
}

export interface AudioArchiveSnapshot {
  sessionId: string;
  sourceType: AudioSourceType;
  deviceId: string | null;
  mimeType: string;
  startedAt: number;
  updatedAt: number;
  chunkCount: number;
  status: AudioArchiveStatus;
}

interface AudioChunkRecord {
  sessionId: string;
  seq: number;
  blob: Blob;
  createdAt: number;
}

export interface AudioChunkEntry {
  seq: number;
  blob: Blob;
}

let _db: IDBDatabase | null = null;

function getArchiveSnapshotStorageKey(sessionId: string) {
  return `${ARCHIVE_SNAPSHOT_KEY_PREFIX}${sessionId}`;
}

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' });
      }

      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunkStore = db.createObjectStore(CHUNK_STORE, {
          keyPath: ['sessionId', 'seq'],
        });
        chunkStore.createIndex('bySessionId', 'sessionId', { unique: false });
      }

      // C51/P6-8：legacy store 的记录无法归属到任何 sessionId，留着就只能被
      // 无差别 getAll() 读走。v2 早已不再写它，直接删除是唯一能确定性堵住泄漏的做法。
      if (db.objectStoreNames.contains(LEGACY_CHUNK_STORE)) {
        db.deleteObjectStore(LEGACY_CHUNK_STORE);
      }
    };

    request.onsuccess = () => {
      _db = request.result;
      resolve(_db);
    };

    request.onerror = () => reject(request.error);
  });
}

export async function upsertAudioSession(
  record: AudioArchiveSessionRecord
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    tx.objectStore(SESSION_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function patchAudioSession(
  sessionId: string,
  patch: Partial<Omit<AudioArchiveSessionRecord, 'sessionId'>>
): Promise<AudioArchiveSessionRecord | null> {
  const current = await getAudioSession(sessionId);
  if (!current) {
    return null;
  }

  const updated: AudioArchiveSessionRecord = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
  };
  await upsertAudioSession(updated);
  return updated;
}

export async function getAudioSession(
  sessionId: string
): Promise<AudioArchiveSessionRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readonly');
    const request = tx.objectStore(SESSION_STORE).get(sessionId);
    request.onsuccess = () =>
      resolve((request.result as AudioArchiveSessionRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function appendAudioChunk(
  sessionId: string,
  seq: number,
  chunk: Blob
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).put({
      sessionId,
      seq,
      blob: chunk,
      createdAt: Date.now(),
    } satisfies AudioChunkRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 读取某个 session 的全部分片。
 *
 * C51/P6-8：这里曾有一条「本会话查不到就回落 legacy `chunks` store 的 getAll()」的兜底。
 * legacy 记录是裸 Blob、不带 sessionId，于是任意会话（包括换账号后的新会话）在
 * finalize 时都会把这堆陈年音频当成自己的分片上传（useSoniox 的 syncRemoteDraft）。
 * legacy store 现在在 openDB 升级到 v3 时被删除，兜底一并去掉。
 */
export async function getAudioChunkEntries(
  sessionId: string
): Promise<AudioChunkEntry[]> {
  const db = await openDB();
  return new Promise<AudioChunkEntry[]>((resolve, reject) => {
    if (!db.objectStoreNames.contains(CHUNK_STORE)) {
      resolve([]);
      return;
    }

    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index('bySessionId');
    const request = index.getAll(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const records = (request.result as AudioChunkRecord[]).sort(
        (a, b) => a.seq - b.seq
      );
      resolve(records.map((record) => ({ seq: record.seq, blob: record.blob })));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getAllAudioChunks(sessionId: string): Promise<Blob[]> {
  const entries = await getAudioChunkEntries(sessionId);
  return entries.map((entry) => entry.blob);
}

export async function clearAudioChunks(sessionId: string): Promise<void> {
  const db = await openDB();

  await new Promise<void>((resolve, reject) => {
    const storeNames = [SESSION_STORE, CHUNK_STORE].filter((storeName) =>
      db.objectStoreNames.contains(storeName)
    );
    if (storeNames.length === 0) {
      resolve();
      return;
    }
    const tx = db.transaction(storeNames, 'readwrite');

    if (storeNames.includes(CHUNK_STORE)) {
      const chunkStore = tx.objectStore(CHUNK_STORE);
      const index = chunkStore.index('bySessionId');
      const range = IDBKeyRange.only(sessionId);

      index.openKeyCursor(range).onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursor | null>).result;
        if (!cursor) return;
        chunkStore.delete(cursor.primaryKey as IDBValidKey);
        cursor.continue();
      };
    }

    if (storeNames.includes(SESSION_STORE)) {
      tx.objectStore(SESSION_STORE).delete(sessionId);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  clearAudioArchiveSnapshot(sessionId);
}

/**
 * 清空本机全部录音归档（所有 session）。登出时调用。
 *
 * C51/P6-8：登出只清了 store 与 localStorage，IndexedDB 里的音频原封不动地留给下一个
 * 登录本机的账号。这里连 sessionStorage 里的归档快照一起扫掉。
 * 尽力而为：indexedDB 不可用（SSR / 隐私模式）直接返回。
 */
export async function clearAllAudioArchives(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const storeNames = [SESSION_STORE, CHUNK_STORE].filter((storeName) =>
      db.objectStoreNames.contains(storeName)
    );
    if (storeNames.length === 0) {
      resolve();
      return;
    }
    const tx = db.transaction(storeNames, 'readwrite');
    for (const storeName of storeNames) {
      tx.objectStore(storeName).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  try {
    const stale: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(ARCHIVE_SNAPSHOT_KEY_PREFIX)) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      sessionStorage.removeItem(key);
    }
    sessionStorage.removeItem(LEGACY_ARCHIVE_MIME_KEY);
  } catch {
    // Best effort only.
  }
}

/**
 * 获取指定 session 在 IndexedDB 中实际存储的最大 chunk seq 值。
 * 返回 -1 表示没有任何 chunk。
 */
export async function getMaxAudioChunkSeq(sessionId: string): Promise<number> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(CHUNK_STORE)) {
    return -1;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index('bySessionId');
    const request = index.getAll(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const records = request.result as AudioChunkRecord[];
      if (records.length === 0) {
        resolve(-1);
        return;
      }
      const maxSeq = records.reduce((max, r) => Math.max(max, r.seq), -1);
      resolve(maxSeq);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function hasAudioChunks(sessionId: string): Promise<boolean> {
  const db = await openDB();
  // 同上：不再回落 legacy store —— 「别的会话有音频」不代表本会话有。
  return new Promise<boolean>((resolve, reject) => {
    if (!db.objectStoreNames.contains(CHUNK_STORE)) {
      resolve(false);
      return;
    }

    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const request = tx
      .objectStore(CHUNK_STORE)
      .index('bySessionId')
      .count(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}

export async function getArchiveMimeType(
  sessionId: string
): Promise<string> {
  const session = await getAudioSession(sessionId);
  if (session?.mimeType) {
    return session.mimeType;
  }

  const snapshot = getAudioArchiveSnapshot(sessionId);
  if (snapshot?.mimeType) {
    return snapshot.mimeType;
  }

  try {
    return sessionStorage.getItem(LEGACY_ARCHIVE_MIME_KEY) || 'audio/webm';
  } catch {
    return 'audio/webm';
  }
}

export function getAudioArchiveSnapshot(
  sessionId: string
): AudioArchiveSnapshot | null {
  try {
    const raw = sessionStorage.getItem(getArchiveSnapshotStorageKey(sessionId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<AudioArchiveSnapshot>;
    if (
      typeof parsed.chunkCount !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.updatedAt !== 'number' ||
      typeof parsed.mimeType !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      sourceType: (parsed.sourceType as AudioSourceType) ?? 'mic',
      deviceId:
        typeof parsed.deviceId === 'string' || parsed.deviceId === null
          ? parsed.deviceId
          : null,
      mimeType: parsed.mimeType,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      chunkCount: parsed.chunkCount,
      status: parsed.status as AudioArchiveStatus,
    };
  } catch {
    return null;
  }
}

export function persistAudioArchiveSnapshot(
  snapshot: AudioArchiveSnapshot
): void {
  try {
    sessionStorage.setItem(
      getArchiveSnapshotStorageKey(snapshot.sessionId),
      JSON.stringify(snapshot)
    );
    sessionStorage.setItem(LEGACY_ARCHIVE_MIME_KEY, snapshot.mimeType);
  } catch {
    // Best effort only.
  }
}

export function clearAudioArchiveSnapshot(sessionId: string): void {
  try {
    sessionStorage.removeItem(getArchiveSnapshotStorageKey(sessionId));
  } catch {
    // Best effort only.
  }
}
