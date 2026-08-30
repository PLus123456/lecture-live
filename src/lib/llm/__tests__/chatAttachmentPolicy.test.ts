import { describe, expect, it } from 'vitest';
import {
  assessChatAttachmentForLlm,
  CHAT_ATTACHMENT_IMAGE_MAX_BYTES,
  CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER,
  CHAT_ATTACHMENT_TEXT_MAX_BYTES,
  CHAT_ATTACHMENT_TEXT_MAX_CHARS,
  prepareExtractedTextForLlm,
} from '@/lib/llm/chatAttachmentPolicy';

describe('chat attachment LLM policy', () => {
  it('allows a large original document when a bounded extracted-text target exists', () => {
    expect(
      assessChatAttachmentForLlm({
        kind: 'document',
        bytes: BigInt(50 * 1024 * 1024),
        hasExtractedText: true,
      })
    ).toEqual({
      llmUsable: true,
      llmUnavailableReason: null,
      reservedDownloadBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES,
      reservedMemoryBytes:
        CHAT_ATTACHMENT_TEXT_MAX_BYTES *
        CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER,
      maxDownloadBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES,
      target: 'extracted',
    });
  });

  it('marks oversized images unavailable before chat download', () => {
    expect(
      assessChatAttachmentForLlm({
        kind: 'image',
        bytes: BigInt(CHAT_ATTACHMENT_IMAGE_MAX_BYTES + 1),
        hasExtractedText: false,
      })
    ).toMatchObject({
      llmUsable: false,
      llmUnavailableReason: 'image_too_large',
    });
  });

  it('marks binary documents without extracted text unavailable', () => {
    expect(
      assessChatAttachmentForLlm({
        kind: 'document',
        bytes: BigInt(100),
        hasExtractedText: false,
      })
    ).toMatchObject({
      llmUsable: false,
      llmUnavailableReason: 'extracted_text_unavailable',
    });
  });

  it('uses DB bytes to admit only bounded raw text', () => {
    const admitted = assessChatAttachmentForLlm({
      kind: 'text',
      bytes: BigInt(CHAT_ATTACHMENT_TEXT_MAX_BYTES),
      hasExtractedText: false,
    });
    expect(admitted).toMatchObject({
      llmUsable: true,
      reservedDownloadBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES,
      maxDownloadBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES,
    });
    expect(
      assessChatAttachmentForLlm({
        kind: 'text',
        bytes: BigInt(CHAT_ATTACHMENT_TEXT_MAX_BYTES + 1),
        hasExtractedText: false,
      })
    ).toMatchObject({
      llmUsable: false,
      llmUnavailableReason: 'text_too_large',
    });
  });

  it('binds original-object stream limits and memory charge to validated DB bytes', () => {
    expect(
      assessChatAttachmentForLlm({
        kind: 'image',
        bytes: BigInt(1),
        hasExtractedText: false,
      })
    ).toMatchObject({
      llmUsable: true,
      reservedDownloadBytes: 1,
      reservedMemoryBytes: CHAT_ATTACHMENT_MEMORY_RESERVATION_MULTIPLIER,
      maxDownloadBytes: 1,
      target: 'original',
    });
  });

  it('rejects an unknown kind even when an extracted-text path exists', () => {
    expect(
      assessChatAttachmentForLlm({
        kind: 'future-binary',
        bytes: BigInt(100),
        hasExtractedText: true,
      })
    ).toMatchObject({
      llmUsable: false,
      llmUnavailableReason: 'unsupported_kind',
    });
  });

  it('bounds the persisted extracted-text artifact before any later chat read', () => {
    const bounded = prepareExtractedTextForLlm(
      '文'.repeat(CHAT_ATTACHMENT_TEXT_MAX_CHARS + 100)
    );
    expect(bounded.length).toBe(CHAT_ATTACHMENT_TEXT_MAX_CHARS);
    expect(bounded).toContain('truncated due to size limit');
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(
      CHAT_ATTACHMENT_TEXT_MAX_BYTES
    );
  });
});
