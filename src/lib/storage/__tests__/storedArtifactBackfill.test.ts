import { describe, expect, it } from 'vitest';
import {
  classifyDraftBackfillSlots,
  parseMeasuredRemoteBytes,
} from '@/lib/storage/storedArtifactBackfill';

describe('stored artifact backfill remote measurement', () => {
  it('uses Content-Range total instead of the one-byte range body', () => {
    expect(
      parseMeasuredRemoteBytes(
        new Headers({
          'content-range': 'bytes 0-0/987654321',
          'content-length': '1',
        })
      )
    ).toBe(BigInt(987654321));
  });

  it('accepts a full-response Content-Length and rejects unknown sizes', () => {
    expect(
      parseMeasuredRemoteBytes(new Headers({ 'content-length': '42' }))
    ).toBe(BigInt(42));
    expect(parseMeasuredRemoteBytes(new Headers())).toBeNull();
    expect(
      parseMeasuredRemoteBytes(new Headers({ 'content-length': '-1' }))
    ).toBeNull();
    expect(
      parseMeasuredRemoteBytes(new Headers({ 'content-length': '1' }), 206)
    ).toBeNull();
  });
});

describe('stored artifact draft generation backfill', () => {
  it('maps only the newest immutable transcript pair to runtime canonical slots', () => {
    const slots = classifyDraftBackfillSlots('transcript', 'session-1', [
      { name: 'transcript-aaaa.json', mtimeMs: 10 },
      { name: 'manifest-aaaa.json', mtimeMs: 11 },
      { name: 'transcript-bbbb.json', mtimeMs: 20 },
      { name: 'manifest-bbbb.json', mtimeMs: 21 },
      { name: 'transcript.conflict-1.json', mtimeMs: 30 },
    ]);

    expect(slots.get('transcript-bbbb.json')).toBe('session-1:transcript');
    expect(slots.get('manifest-bbbb.json')).toBe('session-1:manifest');
    expect(slots.get('transcript-aaaa.json')).toBe(
      'session-1:file:transcript-aaaa.json'
    );
    expect(slots.get('transcript.conflict-1.json')).toBe(
      'session-1:file:transcript.conflict-1.json'
    );
  });

  it('maps the newest recording manifest generation to the manifest slot', () => {
    const slots = classifyDraftBackfillSlots('recording', 'session-1', [
      { name: 'manifest.json', mtimeMs: 10 },
      { name: 'manifest-aaaa.json', mtimeMs: 20 },
    ]);

    expect(slots.get('manifest-aaaa.json')).toBe('session-1:manifest');
    expect(slots.get('manifest.json')).toBe('session-1:file:manifest.json');
  });
});
