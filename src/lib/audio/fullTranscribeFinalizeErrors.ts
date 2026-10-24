/**
 * 完整版补全转录收尾（finalizeFullTranscription）失败的「瞬时 / 永久」判定。
 *
 * 审计 #8：full-transcribe-status 路由与 cron 回收此前把**所有**收尾失败一律回退 transcribing、
 * 交下一轮重试。确定性失败（transcript 被准入拒绝 / 超字节上限 / Soniox 确定性 4xx）重试永远
 * 不会好：每次前端 poll 都重新下载一遍 transcript、失败、回退；cron 只记一句 "left for retry"；
 * 而 claim 每次都刷新 fullTranscribeStartedAt，停滞回收永远认不出它。任务就此永久卡在
 * transcribing —— 占着该用户的补全名额（FREE 默认 perUser=1 → 之后任何会话都 user_busy）与
 * 额度预留，用户也永远看不到失败提示。
 *
 * 口径与 async-transcribe-status 的 isTransientFinalizeError 一致（那份写在路由文件里，而路由
 * 模块不能导出非路由字段，故独立成本模块供路由与 cron 共用），另补两处：Cloudreve 落盘失败的
 * HTTP 状态（transcript 落 Cloudreve 时 5xx 属瞬时）与 408。
 *   - 瞬时：超时 / 中断、Prisma 死锁(P2034) / 事务超时(P2024)、拉 transcript 或 Cloudreve 的
 *     408 / 429 / 5xx、底层网络故障；
 *   - 其余（解析 / 准入 / 确定性 4xx / 本地写盘等）一律视为永久：重试不会自愈。
 */
export function isTransientFullTranscribeFinalizeError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;

  const prismaCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  if (prismaCode === 'P2034' || prismaCode === 'P2024') return true;

  const message = err instanceof Error ? err.message : String(err);
  // getSonioxTranscript 的 HTTP 错误文案：`Soniox get transcript failed: HTTP <status>`
  const sonioxHttp = /Soniox get transcript failed: HTTP (\d{3})/.exec(message);
  if (sonioxHttp) return isTransientHttpStatus(Number(sonioxHttp[1]));
  // CloudreveStorage.upload 的 HTTP 错误文案：`Cloudreve 文件直传失败 (502): …` /
  // `Cloudreve 上传会话创建失败 (503): …` / `Cloudreve 分片上传失败 (chunk 2/9, 500): …`
  const cloudreveHttp = /Cloudreve [^(]*\((?:chunk \d+\/\d+, )?(\d{3})\)/.exec(message);
  if (cloudreveHttp) return isTransientHttpStatus(Number(cloudreveHttp[1]));

  // 底层 fetch 网络故障（Node undici）
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(
    message
  );
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
