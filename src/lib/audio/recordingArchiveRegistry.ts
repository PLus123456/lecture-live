'use client';

/**
 * Account-bound recording archives must be invalidated synchronously and fully
 * torn down before IndexedDB/sessionStorage are cleared. Keeping the registry
 * separate from RecordingArchiveManager avoids a clientAccountCleanup ↔ manager
 * module cycle and lets the cleanup boundary own the ordering.
 */
export interface AccountBoundRecordingArchive {
  invalidateForAccountBoundary(): void;
  teardownForAccountBoundary(): Promise<void>;
}

const activeManagers = new Set<AccountBoundRecordingArchive>();
let accountCleanupInProgress = false;

export function registerActiveRecordingArchive(
  manager: AccountBoundRecordingArchive
): void {
  activeManagers.add(manager);
  if (accountCleanupInProgress) {
    // A manager created by an already-running old async start must never become
    // writable in the middle of account cleanup.
    manager.invalidateForAccountBoundary();
  }
}

export function unregisterActiveRecordingArchive(
  manager: AccountBoundRecordingArchive
): void {
  activeManagers.delete(manager);
}

/**
 * Stop every live recorder and wait for persistence already in flight. The
 * loop also catches a manager registered while an earlier teardown awaited a
 * delayed MediaRecorder stop event.
 */
export async function teardownActiveRecordingArchivesForAccountBoundary(): Promise<void> {
  accountCleanupInProgress = true;
  try {
    while (activeManagers.size > 0) {
      const managers = Array.from(activeManagers);
      for (const manager of managers) {
        manager.invalidateForAccountBoundary();
      }
      await Promise.allSettled(
        managers.map((manager) => manager.teardownForAccountBoundary())
      );
      // A broken teardown must not make account cleanup loop forever. The
      // manager was synchronously invalidated above, so late callbacks remain
      // unable to persist even when teardown itself rejected.
      for (const manager of managers) {
        activeManagers.delete(manager);
      }
    }
  } finally {
    accountCleanupInProgress = false;
  }
}
