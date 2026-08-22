import { describe, expect, it } from 'vitest';
import {
  persistSessionTranscriptArtifacts,
  stageSessionTranscriptArtifacts,
} from '@/lib/sessionPersistence';

const session = { id: 'session-1', userId: 'user-1' };
const maliciousBundle = {
  segments: [
    {
      id: 'segment-1',
      sessionIndex: 0,
      speaker: 'Speaker 1',
      language: 'en',
      text: 'bounded text',
      globalStartMs: 0,
      globalEndMs: 1_000,
      startMs: 0,
      endMs: 1_000,
      isFinal: true,
      confidence: 1,
      timestamp: '00:00:00',
      attacker: { nested: { bytes: 'must never reach storage' } },
    },
  ],
  summaries: [],
  translations: {},
};

describe('session transcript persistence boundary (SEC-009)', () => {
  it.each([
    ['direct persistence', persistSessionTranscriptArtifacts],
    ['staged persistence', stageSessionTranscriptArtifacts],
  ])('rejects unknown nested data before %s allocates an artifact', async (_name, persist) => {
    await expect(persist(session, maliciousBundle)).rejects.toMatchObject({
      name: 'SessionTranscriptPayloadError',
      status: 400,
    });
  });
});
