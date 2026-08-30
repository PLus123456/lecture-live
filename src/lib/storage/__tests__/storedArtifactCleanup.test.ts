import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  rm: vi.fn(),
  rmdir: vi.fn(),
  release: vi.fn(),
  orphan: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { rm: mocks.rm, rmdir: mocks.rmdir },
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw },
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: vi.fn(async () => null),
  deleteCloudreveFile: vi.fn(async () => false),
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: {
    RESERVED: 'RESERVED',
    ORPHANED: 'ORPHANED',
    CLEANING: 'CLEANING',
  },
  releaseStoredArtifact: mocks.release,
  markStoredArtifactOrphan: mocks.orphan,
}));
vi.mock('@/lib/logger', () => {
  const logger = { warn: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger, serializeError: (error: unknown) => error };
});

import { cleanupExpiredStoredArtifacts } from '@/lib/storage/storedArtifactCleanup';

const expiredRow = {
  id: 'artifact-1',
  userId: 'user-1',
  ownerType: 'chat_attachment',
  ownerId: 'attachment-1',
  sessionId: null,
  conversationId: 'conversation-1',
  artifactType: 'inline_image',
  storage: 'local',
  reference: 'local:chatimages/conversation-1/image.png',
  state: 'RESERVED',
  bytes: BigInt(4),
  chargedBytes: BigInt(4),
  identityKey: null,
  logicalKey: 'logical-1',
  reservationKey: 'reservation-1',
  replacesArtifactId: null,
  expiresAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  deletedAt: null,
};

describe('cleanupExpiredStoredArtifacts claim gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([expiredRow]);
    mocks.rm.mockResolvedValue(undefined);
    mocks.rmdir.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(true);
    mocks.orphan.mockResolvedValue(undefined);
  });

  it('does not touch bytes when a concurrent publisher wins the state CAS', async () => {
    mocks.executeRaw.mockResolvedValueOnce(0);

    const result = await cleanupExpiredStoredArtifacts({ now: new Date(1) });

    expect(result).toEqual({ scanned: 1, deleted: 0, failed: 0 });
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('deletes and releases only after claiming the expired row', async () => {
    mocks.executeRaw
      .mockResolvedValueOnce(1) // StoredArtifact RESERVED/ORPHANED → CLEANING
      .mockResolvedValueOnce(1); // hidden ChatAttachment delete

    const result = await cleanupExpiredStoredArtifacts({ now: new Date(1) });

    expect(result).toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith('artifact-1');
  });
});
