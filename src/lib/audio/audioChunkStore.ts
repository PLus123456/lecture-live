/**
 * Session-scoped IndexedDB audio archive storage.
 *
 * Audio chunks are keyed by sessionId + sequence number so we can safely
 * recover recordings after reconnects, refreshes, and retry finalization.
 */

import type { AudioSourceType } from '@/types/transcript';

const DB_NAME = 'lecture-live-audio';
const DB_VERSION = 2;
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

async function getLegacyAudioChunks(): Promise<AudioChunkEntry[]> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(LEGACY_CHUNK_STORE)) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LEGACY_CHUNK_STORE, 'readonly');
    const request = tx.objectStore(LEGACY_CHUNK_STORE).getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as Blob[]).map((blob, index) => ({
          seq: index,
          blob,
        }))
      );
    request.onerror = () => reject(request.error);
  });
}

export async function getAudioChunkEntries(
  sessionId: string
): Promise<AudioChunkEntry[]> {
  const db = await openDB();
  const chunks = await new Promise<AudioChunkEntry[]>((resolve, reject) => {
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

  if (chunks.length > 0) {
    return chunks;
  }

  return getLegacyAudioChunks();
}

export async function getAllAudioChunks(sessionId: string): Promise<Blob[]> {
  const entries = await getAudioChunkEntries(sessionId);
  return entries.map((entry) => entry.blob);
}

async function clearLegacyAudioChunks(): Promise<void> {
  const db = await openDB();
  if (!db.objectStoreNames.contains(LEGACY_CHUNK_STORE)) {
    return;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LEGACY_CHUNK_STORE, 'readwrite');
    tx.objectStore(LEGACY_CHUNK_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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

  await clearLegacyAudioChunks().catch(() => undefined);
  clearAudioArchiveSnapshot(sessionId);
}

export async function hasAudioChunks(sessionId: string): Promise<boolean> {
  const db = await openDB();
  const count = await new Promise<number>((resolve, reject) => {
    if (!db.objectStoreNames.contains(CHUNK_STORE)) {
      resolve(0);
      return;
    }

    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const request = tx
      .objectStore(CHUNK_STORE)
      .index('bySessionId')
      .count(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (count > 0) {
    return true;
  }

  const legacyChunks = await getLegacyAudioChunks();
  return legacyChunks.length > 0;
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
