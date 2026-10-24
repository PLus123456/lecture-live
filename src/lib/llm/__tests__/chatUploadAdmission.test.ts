import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_UPLOAD_GLOBAL_MAX_IN_FLIGHT_BYTES,
  CHAT_UPLOAD_USER_MAX_IN_FLIGHT_BYTES,
  __getChatUploadAdmissionForTests,
  __resetChatUploadAdmissionForTests,
  tryReserveChatUploadBody,
} from '@/lib/llm/chatUploadAdmission';

const MiB = 1024 * 1024;

describe('chat upload in-flight admission', () => {
  beforeEach(() => {
    __resetChatUploadAdmissionForTests();
  });

  it('跨用户共享进程级字节预算：满额后任何用户都立即被拒', () => {
    const releases = [];
    let users = 0;
    for (;;) {
      const release = tryReserveChatUploadBody(`user-${users}`, 32 * MiB);
      if (!release) break;
      releases.push(release);
      users += 1;
    }
    expect(users * 32 * MiB).toBeLessThanOrEqual(CHAT_UPLOAD_GLOBAL_MAX_IN_FLIGHT_BYTES);
    expect(tryReserveChatUploadBody('another-user', 1)).toBeNull();

    releases.forEach((release) => release());
    expect(__getChatUploadAdmissionForTests()).toEqual({ requests: 0, bytes: 0, users: 0 });
    expect(tryReserveChatUploadBody('another-user', 32 * MiB)).not.toBeNull();
  });

  it('单用户字节上限与非法预留量都 fail-closed', () => {
    expect(tryReserveChatUploadBody('u', CHAT_UPLOAD_USER_MAX_IN_FLIGHT_BYTES + 1)).toBeNull();
    expect(tryReserveChatUploadBody('u', 0)).toBeNull();
    expect(tryReserveChatUploadBody('u', Number.NaN)).toBeNull();
    expect(tryReserveChatUploadBody('', 1)).toBeNull();
  });

  it('释放函数幂等，不会把别人的预留减掉', () => {
    const a = tryReserveChatUploadBody('u', 10 * MiB)!;
    const b = tryReserveChatUploadBody('u', 10 * MiB)!;
    a();
    a();
    expect(__getChatUploadAdmissionForTests()).toMatchObject({ requests: 1, bytes: 10 * MiB });
    b();
    expect(__getChatUploadAdmissionForTests()).toMatchObject({ requests: 0, bytes: 0 });
  });
});
