import 'server-only';

/**
 * chat 附件上传的进程级「在途 body 字节」准入。
 *
 * 单次上传的字节上限只钉住**单个**请求：multipart 解析期间一个请求会同时持有 3–5 份 body
 * 拷贝（流式分块 + concat + Uint8Array 副本 + FormData File + arrayBuffer），实测 31MiB
 * 上传约 80–90MiB RSS/请求、100MiB 上传单请求峰值 ~750MiB。限流桶允许同一用户 10 分钟
 * 60 次、nginx 允许单 IP 100 连接 —— 几十个并发大上传就能把 Next 进程顶到 OOM（web unit
 * 是 Restart=no，崩了就一直挂着）。这里在**读 body 之前**按声明长度（缺失时按路由上限）
 * 同步预留，容量不足立即 429，不排队、不持有请求。
 */

/** 同一用户同时在途的上传请求数。 */
export const CHAT_UPLOAD_USER_MAX_IN_FLIGHT_REQUESTS = 2;
/** 同一用户同时在途的上传 body 字节（= 2 个满额 32MiB 上传）。 */
export const CHAT_UPLOAD_USER_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
/** 单进程同时在途的上传 body 字节（按 ~4 倍放大，峰值约 512MiB）。 */
export const CHAT_UPLOAD_GLOBAL_MAX_IN_FLIGHT_BYTES = 128 * 1024 * 1024;

interface UploadCounter {
  requests: number;
  bytes: number;
}

interface UploadAdmissionState extends UploadCounter {
  users: Map<string, UploadCounter>;
}

const STATE_KEY = '__lectureLiveChatUploadAdmissionV1';
type UploadAdmissionGlobal = typeof globalThis & {
  [STATE_KEY]?: UploadAdmissionState;
};

function getState(): UploadAdmissionState {
  const globalState = globalThis as UploadAdmissionGlobal;
  globalState[STATE_KEY] ??= {
    requests: 0,
    bytes: 0,
    users: new Map<string, UploadCounter>(),
  };
  return globalState[STATE_KEY];
}

/**
 * 同步 check-and-increment（同一 isolate 内两步之间不会让出事件循环）。
 * 返回幂等释放函数；null 表示容量不足，调用方必须立即拒绝。
 */
export function tryReserveChatUploadBody(
  userId: string,
  reservedBytes: number
): (() => void) | null {
  if (
    !userId ||
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes <= 0 ||
    reservedBytes > CHAT_UPLOAD_USER_MAX_IN_FLIGHT_BYTES ||
    reservedBytes > CHAT_UPLOAD_GLOBAL_MAX_IN_FLIGHT_BYTES
  ) {
    return null;
  }

  const state = getState();
  const user = state.users.get(userId) ?? { requests: 0, bytes: 0 };
  if (
    user.requests + 1 > CHAT_UPLOAD_USER_MAX_IN_FLIGHT_REQUESTS ||
    user.bytes + reservedBytes > CHAT_UPLOAD_USER_MAX_IN_FLIGHT_BYTES ||
    state.bytes + reservedBytes > CHAT_UPLOAD_GLOBAL_MAX_IN_FLIGHT_BYTES
  ) {
    return null;
  }

  user.requests += 1;
  user.bytes += reservedBytes;
  state.users.set(userId, user);
  state.requests += 1;
  state.bytes += reservedBytes;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = getState();
    const currentUser = current.users.get(userId);
    if (currentUser) {
      currentUser.requests = Math.max(0, currentUser.requests - 1);
      currentUser.bytes = Math.max(0, currentUser.bytes - reservedBytes);
      if (currentUser.requests === 0 && currentUser.bytes === 0) {
        current.users.delete(userId);
      }
    }
    current.requests = Math.max(0, current.requests - 1);
    current.bytes = Math.max(0, current.bytes - reservedBytes);
  };
}

export function __resetChatUploadAdmissionForTests(): void {
  const globalState = globalThis as UploadAdmissionGlobal;
  delete globalState[STATE_KEY];
}

export function __getChatUploadAdmissionForTests(): UploadCounter & {
  users: number;
} {
  const state = getState();
  return { requests: state.requests, bytes: state.bytes, users: state.users.size };
}
