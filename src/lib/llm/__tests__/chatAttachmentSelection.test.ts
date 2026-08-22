import { describe, expect, it } from 'vitest';
import {
  CHAT_ATTACHMENT_SELECTION_MAX_COUNT,
  CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES,
} from '@/lib/llm/chatAttachmentPolicy';
import { selectChatAttachmentsForLlm } from '@/lib/llm/chatAttachmentSelection';

describe('selectChatAttachmentsForLlm', () => {
  it('keeps stable order and caps a long conversation at 32 explicit IDs', () => {
    const candidates = Array.from(
      { length: CHAT_ATTACHMENT_SELECTION_MAX_COUNT + 3 },
      (_, index) => ({
        id: `a-${index}`,
        kind: 'document' as const,
        bytes: 100,
        llmUsable: true,
      })
    );

    const selected = selectChatAttachmentsForLlm(candidates);

    expect(selected.attachmentIds).toEqual(
      candidates
        .slice(0, CHAT_ATTACHMENT_SELECTION_MAX_COUNT)
        .map(({ id }) => id)
    );
    expect(selected.omittedByLimits).toBe(3);
  });

  it('enforces the same aggregate budget without rejecting the whole send', () => {
    const imageBytes = 5 * 1024 * 1024;
    const selected = selectChatAttachmentsForLlm(
      Array.from({ length: 5 }, (_, index) => ({
        id: `image-${index}`,
        kind: 'image' as const,
        bytes: imageBytes,
        llmUsable: true,
      }))
    );

    expect(selected.attachmentIds).toEqual([
      'image-0',
      'image-1',
      'image-2',
      'image-3',
    ]);
    expect(selected.reservedBytes).toBe(
      CHAT_ATTACHMENT_SELECTION_TOTAL_MAX_BYTES
    );
    expect(selected.omittedByLimits).toBe(1);
  });

  it('deduplicates IDs and omits unavailable or invalid metadata', () => {
    const selected = selectChatAttachmentsForLlm([
      { id: 'doc', kind: 'document', bytes: 50_000_000, llmUsable: true },
      { id: 'doc', kind: 'document', bytes: 50_000_000, llmUsable: true },
      { id: 'bad', kind: 'image', bytes: 0, llmUsable: true },
      { id: 'off', kind: 'text', bytes: 10, llmUsable: false },
    ]);

    expect(selected.attachmentIds).toEqual(['doc']);
    expect(selected.omittedUnavailable).toBe(2);
  });
});
