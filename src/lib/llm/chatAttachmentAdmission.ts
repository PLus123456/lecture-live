import 'server-only';

/** 同一用户最多同时占用两个不同 conversation 的附件读取。 */
export const CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS = 2;
/** 单 Next.js 进程最多四个附件读取请求；准入立即拒绝，不建立等待队列。 */
export const CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_REQUESTS = 4;
export const CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_DOWNLOADS = 4;
export const CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_DOWNLOADS = 8;
/** 两个满载请求不能同时击穿同一账号的堆预算。 */
export const CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_BYTES = 192 * 1024 * 1024;
/** 全进程附件堆 charge（已含 Buffer/base64 放大）上限。 */
export const CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_BYTES = 384 * 1024 * 1024;

interface AdmissionCounter {
  requests: number;
  downloads: number;
  bytes: number;
}

interface AdmissionState extends AdmissionCounter {
  users: Map<string, AdmissionCounter>;
}

const STATE_KEY = '__lectureLiveChatAttachmentAdmissionV2';
type AdmissionGlobal = typeof globalThis & {
  [STATE_KEY]?: AdmissionState;
};

function getState(): AdmissionState {
  const globalState = globalThis as AdmissionGlobal;
  globalState[STATE_KEY] ??= {
    requests: 0,
    downloads: 0,
    bytes: 0,
    users: new Map<string, AdmissionCounter>(),
  };
  return globalState[STATE_KEY];
}

/**
 * 同步 check-and-increment；JavaScript 同一 isolate 内不会在两步之间让出事件循环。
 * 返回 null 表示容量不足，调用方必须立即拒绝，不能排队持有 HTTP 请求。
 */
export function tryReserveChatAttachmentDownload(
  userId: string,
  reservedBytes: number,
  reservedDownloads = 1
): (() => void) | null {
  if (
    !userId ||
    !Number.isSafeInteger(reservedBytes) ||
    !Number.isSafeInteger(reservedDownloads) ||
    reservedBytes <= 0 ||
    reservedDownloads <= 0 ||
    reservedBytes > CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_BYTES ||
    reservedBytes > CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_BYTES
  ) {
    return null;
  }

  const state = getState();
  const user = state.users.get(userId) ?? {
    requests: 0,
    downloads: 0,
    bytes: 0,
  };
  if (
    user.requests + 1 > CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_REQUESTS ||
    user.downloads + reservedDownloads >
      CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_DOWNLOADS ||
    user.bytes + reservedBytes > CHAT_ATTACHMENT_USER_MAX_IN_FLIGHT_BYTES ||
    state.requests + 1 > CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_REQUESTS ||
    state.downloads + reservedDownloads >
      CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_DOWNLOADS ||
    state.bytes + reservedBytes > CHAT_ATTACHMENT_GLOBAL_MAX_IN_FLIGHT_BYTES
  ) {
    return null;
  }

  user.requests += 1;
  user.downloads += reservedDownloads;
  user.bytes += reservedBytes;
  state.users.set(userId, user);
  state.requests += 1;
  state.downloads += reservedDownloads;
  state.bytes += reservedBytes;

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const currentState = getState();
    const currentUser = currentState.users.get(userId);
    if (currentUser) {
      currentUser.requests = Math.max(0, currentUser.requests - 1);
      currentUser.downloads = Math.max(
        0,
        currentUser.downloads - reservedDownloads
      );
      currentUser.bytes = Math.max(0, currentUser.bytes - reservedBytes);
      if (
        currentUser.requests === 0 &&
        currentUser.downloads === 0 &&
        currentUser.bytes === 0
      ) {
        currentState.users.delete(userId);
      } else {
        currentState.users.set(userId, currentUser);
      }
    }
    currentState.requests = Math.max(0, currentState.requests - 1);
    currentState.downloads = Math.max(
      0,
      currentState.downloads - reservedDownloads
    );
    currentState.bytes = Math.max(0, currentState.bytes - reservedBytes);
  };
}

export function __resetChatAttachmentAdmissionForTests(): void {
  const globalState = globalThis as AdmissionGlobal;
  delete globalState[STATE_KEY];
}

export function __getChatAttachmentAdmissionForTests(): {
  requests: number;
  downloads: number;
  bytes: number;
  users: Array<[string, AdmissionCounter]>;
} {
  const state = getState();
  return {
    requests: state.requests,
    downloads: state.downloads,
    bytes: state.bytes,
    users: [...state.users.entries()].map(([userId, counter]) => [
      userId,
      { ...counter },
    ]),
  };
}
