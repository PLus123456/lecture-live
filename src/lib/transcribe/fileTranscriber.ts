'use client';

/**
 * 上传文件的浏览器侧元数据探测。
 *
 * 历史：本模块曾包含 `startFileTranscribe`（用 <audio> 加速回放 + AudioContext 桥接成
 * MediaStream，把上传文件当实时流喂给 Soniox）。该路线已被**服务端 async pipeline**
 * 取代（`src/lib/transcribe/asyncUploadClient.ts` → `/api/sessions/[id]/async-upload/*`：
 * 分片上传 → ffmpeg 转码 → Soniox 异步文件 API → 服务端计费与收尾），浏览器不再承担转录。
 *
 * 2026-08-22 审计 M3/M4 指出这段休眠代码有三处真缺陷：
 *   ① 调 `startSonioxRecording` 不带 `attribution` —— 现行 temporary-key 契约要求
 *      `{ kind, sessionId | anchorId }`（`/api/soniox/temporary-key` 缺 kind 一律 400），
 *      也就是说它一旦被复用，第一步 mint key 就必然失败；
 *   ② 无 `scheduleRotation`/重连 —— 临时 key 的 `max_session_duration_seconds` 到点被
 *      Soniox 硬断，而 <audio> 会继续播完、promise 正常 resolve，产出**无任何截断标记**的
 *      部分转录（超长文件必然踩到）；
 *   ③ `cancel()` 直接 cleanup（pause + remove <audio> + 清 src），而主 promise 正阻塞在
 *      `'ended' | 'error'` 上：要么以误导性的 `Error('音频播放出错')` reject，要么**永远
 *      pending**；两种情况下进度 `setInterval` 都不会被清理，每 250ms 空转到页面卸载。
 *
 * 处置：**删除**而不是修复。全仓零调用方（`grep startFileTranscribe` 只命中定义本身），
 * 没有任何复用计划，而复活它需要重新对齐 attribution/预扣/轮换整套 mint 契约 —— 那时按新
 * 契约重写比继承这三个缺陷更省事。留下三处休眠缺陷等着下一个人踩，不如现在删干净。
 * 同批删除的还有只服务于该路线的 `estimateTranscribeDurationMs`（按 playbackRate 折算
 * 加速转录耗时，同样零调用方）。
 *
 * 仍在使用的只有 `probeAudioDurationMs`（`UploadTranscribeModal` 用它拿浏览器侧时长，
 * 作为 async-upload init 的配额门禁入参；服务端 ffprobe 才是最终真相）。
 */

/**
 * 解析音频/视频文件时长（用 <audio> 的 metadata 加载）。
 */
export async function probeAudioDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    audio.muted = true;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.remove();
    };
    audio.addEventListener('loadedmetadata', () => {
      const ms = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
      cleanup();
      resolve(ms);
    });
    audio.addEventListener('error', () => {
      cleanup();
      reject(new Error('无法读取音频文件元数据'));
    });
  });
}
