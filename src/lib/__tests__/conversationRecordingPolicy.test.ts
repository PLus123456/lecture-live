import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_RECORDING_LIMITS,
  ConversationRecordingBodyError,
  loadConversationRecordingUsage,
  normalizeConversationRecordingIds,
  readConversationRecordingJson,
} from '@/lib/conversationRecordingPolicy';

describe('conversation recording resource admission', () => {
  it('rejects raw arrays over 16 before deduplication', () => {
    expect(() =>
      normalizeConversationRecordingIds(Array.from({ length: 17 }, () => 'same'))
    ).toThrowError(ConversationRecordingBodyError);
  });

  it('deduplicates a legitimate bounded ID set while enforcing UTF-8 bytes', () => {
    expect(normalizeConversationRecordingIds([' a ', 'b', 'a'])).toEqual([
      'a',
      'b',
    ]);
    expect(() => normalizeConversationRecordingIds(['录'.repeat(1000)])).toThrow(
      /byte limit/
    );
  });

  it('stops a chunked JSON body at the actual byte limit', async () => {
    const oversized = new Request('http://local.test', {
      method: 'POST',
      body: JSON.stringify({
        recordingIds: ['x'.repeat(CONVERSATION_RECORDING_LIMITS.maxJsonBodyBytes)],
      }),
    });
    await expect(readConversationRecordingJson(oversized)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('fails closed while the complete-ledger marker is absent', async () => {
    const db = {
      session: { findMany: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    await expect(
      loadConversationRecordingUsage(db as never, 'u1', ['s1'])
    ).rejects.toMatchObject({
      code: 'BACKFILL_PENDING',
      status: 503,
    });
    expect(db.session.findMany).not.toHaveBeenCalled();
  });

  it('accepts a small owned set and sums complete-ledger bytes', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ value: 'complete' }])
      .mockResolvedValueOnce([
        { artifactType: 'recording', chargedBytes: BigInt(100) },
        { artifactType: 'transcript', chargedBytes: BigInt(20) },
      ]);
    const db = {
      session: {
        findMany: vi.fn().mockResolvedValue([{ id: 's1', durationMs: 60_000 }]),
      },
      $queryRaw: queryRaw,
    };
    await expect(
      loadConversationRecordingUsage(db as never, 'u1', ['s1'])
    ).resolves.toEqual({
      recordingIds: ['s1'],
      durationMs: 60_000,
      artifactBytes: BigInt(120),
      injectableTextBytes: BigInt(20),
    });
  });

  it('rejects duration and physical-byte amplification before file loading', async () => {
    const durationDb = {
      session: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 's1',
            durationMs: CONVERSATION_RECORDING_LIMITS.maxDurationMs + 1,
          },
        ]),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ value: 'complete' }])
        .mockResolvedValueOnce([]),
    };
    await expect(
      loadConversationRecordingUsage(durationDb as never, 'u1', ['s1'])
    ).rejects.toMatchObject({ code: 'DURATION', status: 413 });

    const bytesDb = {
      session: {
        findMany: vi.fn().mockResolvedValue([{ id: 's1', durationMs: 1 }]),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ value: 'complete' }])
        .mockResolvedValueOnce([
          {
            artifactType: 'recording',
            chargedBytes:
              CONVERSATION_RECORDING_LIMITS.maxArtifactBytes + BigInt(1),
          },
        ]),
    };
    await expect(
      loadConversationRecordingUsage(bytesDb as never, 'u1', ['s1'])
    ).rejects.toMatchObject({ code: 'ARTIFACT_BYTES', status: 413 });
  });
});
