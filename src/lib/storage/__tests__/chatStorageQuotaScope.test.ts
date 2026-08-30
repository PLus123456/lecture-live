import { describe, expect, it } from 'vitest';
import {
  CHAT_QUOTA_ARTIFACT_TYPE_LIST,
  STORED_ARTIFACT_TYPE,
  countsTowardChatStorageQuota,
} from '@/lib/storage/storedArtifactLedger';

/**
 * `User.storageBytesUsed` / `storageBytesLimit` is the chat-files quota
 * (`chat_files_quota_*_mb`, FREE 默认 100MB). Recording-class artifacts are governed by
 * `storageHoursLimit` (FREE 10h) instead.
 *
 * Billing recordings against the chat budget makes recording impossible for every
 * non-ADMIN user — 10 hours of audio is far past 100MB, so draft chunks 402 mid-recording
 * and finalize leaves the session stuck in FINALIZING. The ADMIN row in
 * `adjustUserStorageBytes`'s SQL is exempt, which is why the dev admin account never
 * reproduced it. This test pins the classification so the two dimensions cannot silently
 * merge again.
 */
describe('chat-files byte quota scope', () => {
  const RECORDING_CLASS = [
    STORED_ARTIFACT_TYPE.RECORDING,
    STORED_ARTIFACT_TYPE.RECORDING_DRAFT,
    STORED_ARTIFACT_TYPE.ENHANCED_AUDIO,
    STORED_ARTIFACT_TYPE.TRANSCRIPT,
    STORED_ARTIFACT_TYPE.TRANSCRIPT_DRAFT,
    STORED_ARTIFACT_TYPE.FULL_TRANSCRIPT,
    STORED_ARTIFACT_TYPE.SUMMARY,
    STORED_ARTIFACT_TYPE.REPORT,
  ] as const;

  const CHAT_CLASS = [
    STORED_ARTIFACT_TYPE.CHAT_RAW,
    STORED_ARTIFACT_TYPE.CHAT_EXTRACTED,
    STORED_ARTIFACT_TYPE.INLINE_IMAGE,
  ] as const;

  it.each(RECORDING_CLASS)(
    '%s 不计入 chat 文件字节配额（归 storageHoursLimit 管）',
    (artifactType) => {
      expect(countsTowardChatStorageQuota(artifactType)).toBe(false);
    }
  );

  it.each(CHAT_CLASS)('%s 计入 chat 文件字节配额', (artifactType) => {
    expect(countsTowardChatStorageQuota(artifactType)).toBe(true);
  });

  it('内联图片仍受配额约束（SEC-016 的核心：不得绕过存储账本）', () => {
    expect(countsTowardChatStorageQuota(STORED_ARTIFACT_TYPE.INLINE_IMAGE)).toBe(true);
  });

  it('每种 artifact 类型都被显式归类，新增类型必须自觉选边', () => {
    const all = Object.values(STORED_ARTIFACT_TYPE);
    const classified = [...RECORDING_CLASS, ...CHAT_CLASS];
    expect([...all].sort()).toEqual([...classified].sort());
  });

  it('导出的 SQL 列表与判定函数一致（对账/回填复用同一真源）', () => {
    for (const artifactType of Object.values(STORED_ARTIFACT_TYPE)) {
      expect(CHAT_QUOTA_ARTIFACT_TYPE_LIST.includes(artifactType)).toBe(
        countsTowardChatStorageQuota(artifactType)
      );
    }
  });
});
