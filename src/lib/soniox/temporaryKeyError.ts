// src/lib/soniox/temporaryKeyError.ts
// /api/soniox/temporary-key 拒绝签发时的错误类型。单独成模块：client.ts 抛出它，useSoniox 判别它，
// 判别方不必依赖 client.ts 本身。

/** /api/soniox/temporary-key 拒绝签发（非 2xx）：带状态码与服务端的机读 code。 */
export class TemporaryKeyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** code=session_duration_limit 时：命中的单场上限（毫秒）。 */
    readonly limitMs?: number
  ) {
    super(message);
    this.name = 'TemporaryKeyError';
  }
}

/**
 * 本场累计串流已达单场上限，服务端不再签发 key（403 code=session_duration_limit）。
 * 这不是断线：重连只会被同样拒绝，上层应提示并收尾。
 */
export function isSessionDurationLimitError(
  error: unknown
): error is TemporaryKeyError {
  return error instanceof TemporaryKeyError && error.code === 'session_duration_limit';
}
