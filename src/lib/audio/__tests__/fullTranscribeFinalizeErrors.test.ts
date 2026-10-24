import { describe, expect, it } from 'vitest';

import { isTransientFullTranscribeFinalizeError } from '@/lib/audio/fullTranscribeFinalizeErrors';

/**
 * 审计 #8：完整版补全收尾失败的瞬时 / 永久分流。瞬时 → 回退 transcribing 交下一轮重试；
 * 永久 → 标 failed 并释放预留与补全名额（旧实现一律当瞬时，确定性失败永久卡死）。
 */
describe('isTransientFullTranscribeFinalizeError', () => {
  it.each([
    ['超时（AbortSignal.timeout）', Object.assign(new Error('t'), { name: 'TimeoutError' })],
    ['中断', Object.assign(new Error('a'), { name: 'AbortError' })],
    ['Prisma 死锁', Object.assign(new Error('Deadlock found'), { code: 'P2034' })],
    ['Prisma 事务超时', Object.assign(new Error('Timed out'), { code: 'P2024' })],
    ['拉 transcript 5xx', new Error('Soniox get transcript failed: HTTP 503')],
    ['拉 transcript 429', new Error('Soniox get transcript failed: HTTP 429')],
    ['Cloudreve 直传 502', new Error('Cloudreve 文件直传失败 (502): Bad Gateway')],
    ['Cloudreve 分片 500', new Error('Cloudreve 分片上传失败 (chunk 2/9, 500): oops')],
    ['底层网络故障', new TypeError('fetch failed')],
    ['连接重置', new Error('read ECONNRESET')],
  ])('%s → 瞬时（重试）', (_label, error) => {
    expect(isTransientFullTranscribeFinalizeError(error)).toBe(true);
  });

  it.each([
    ['Soniox 响应被准入拒绝', Object.assign(new Error('Soniox transcript.tokens must be an array'), { name: 'SonioxTranscriptPayloadError' })],
    ['transcript 超字节上限', Object.assign(new Error('transcript payload exceeds 8388608 serialized UTF-8 bytes'), { name: 'SessionTranscriptPayloadError' })],
    ['拉 transcript 404（转录已不存在）', new Error('Soniox get transcript failed: HTTP 404')],
    ['拉 transcript 401', new Error('Soniox get transcript failed: HTTP 401')],
    ['Cloudreve 403', new Error('Cloudreve 文件直传失败 (403): Forbidden')],
    ['本地写盘失败', new Error("ENOSPC: no space left on device, open '/data/x.json'")],
    ['非 Error 抛出物', 'boom'],
  ])('%s → 永久（标 failed + 释放）', (_label, error) => {
    expect(isTransientFullTranscribeFinalizeError(error)).toBe(false);
  });
});
