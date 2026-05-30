/**
 * 调系统 ffmpeg 二进制把音视频文件转成 MP3。
 *
 * 用途：用户上传的视频文件抽出音频，或者大体积音频降码率，统一压成 mono 44.1kHz
 * 128kbps MP3。理由：
 * - MP3 在所有浏览器 <audio> 100% 兼容（回放）
 * - 后端 uploadValidation 已经支持 audio/mpeg
 * - mono 128kbps speech 远超 ASR 所需精度，1 小时约 57MB
 * - 44.1kHz 保留人耳可分辨频段（vs 16kHz ASR 用，回放音质明显差）
 *
 * 进度：解析 stderr 的 `out_time_us=` 行（用 -progress pipe:2）/ duration。
 *
 * 部署：Alpine 镜像需 `apk add ffmpeg`；本地 dev 用 brew。
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { logger } from '@/lib/logger';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

export interface TranscodeOptions {
  inputPath: string;
  outputPath: string;
  /** 0~1，每次进度更新调用一次 */
  onProgress?: (fraction: number) => void;
  /** 用 ffprobe 拿到的原始时长（秒）。没有也能跑，但进度会跳到 100% 才更新 */
  durationSec?: number;
  /** 默认 128。speech 用 96 足够，128 安全冗余 */
  bitrateKbps?: number;
  /**
   * 空转超时（ms），默认 5 分钟。ffmpeg `-progress pipe:2` 正常每秒输出一行，
   * 超过该时长无任何 stderr 输出即视为卡死 → SIGKILL。坏文件常表现为长期无输出。
   */
  idleTimeoutMs?: number;
  /**
   * 绝对硬上限（ms），默认 2 小时。兜底"持续输出但永不收尾"的异常（空转超时抓不到）。
   * 正常 128k mono 转码远快于实时，300 分钟上限的文件也应在数十分钟内完成。
   */
  maxTimeoutMs?: number;
}

export interface TranscodeResult {
  outputPath: string;
  durationSec: number;
  outputSize: number;
}

/**
 * 用 ffprobe 读取媒体文件时长（秒）。返回 0 表示读不到。
 */
export async function probeDurationSec(filePath: string): Promise<number> {
  const probeBin = process.env.FFPROBE_PATH || 'ffprobe';
  return new Promise((resolve) => {
    const proc = spawn(probeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', () => {
      const val = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(val) && val > 0 ? val : 0);
    });
    proc.on('error', () => resolve(0));
  });
}

/**
 * 把任意音视频文件转成 mono 44.1kHz 128kbps MP3。
 *
 * 参数解释：
 *   -i input         输入文件，ffmpeg 自己嗅探格式
 *   -vn              丢弃视频流
 *   -c:a libmp3lame  MP3 编码
 *   -b:a {bitrate}k  比特率（CBR）
 *   -ac 1            单声道
 *   -ar 44100        采样率 44.1kHz
 *   -map_metadata -1 丢元数据（避免泄露隐私字段）
 *   -y               覆盖输出
 *   -progress pipe:2 把进度行打到 stderr
 *   -nostats         不打默认 stats（只要 progress 行）
 */
export async function transcodeToMp3(opts: TranscodeOptions): Promise<TranscodeResult> {
  const bitrate = opts.bitrateKbps ?? 128;
  const args = [
    '-i', opts.inputPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrate}k`,
    '-ac', '1',
    '-ar', '44100',
    '-map_metadata', '-1',
    '-y',
    '-progress', 'pipe:2',
    '-nostats',
    opts.outputPath,
  ];

  // 估算 duration：优先用调用方传的，否则现 probe 一下
  const durationSec = opts.durationSec ?? (await probeDurationSec(opts.inputPath));

  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 2 * 60 * 60_000;

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);

    let stderrBuf = '';
    let lastReportedFraction = 0;

    // ── 超时看门狗：空转（无输出）+ 绝对硬上限，命中即 SIGKILL ──
    let killedReason: 'idle' | 'max' | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killedReason = 'idle';
        proc.kill('SIGKILL');
      }, idleTimeoutMs);
    };
    const hardTimer = setTimeout(() => {
      killedReason = 'max';
      proc.kill('SIGKILL');
    }, maxTimeoutMs);
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    };
    resetIdleTimer();

    proc.stderr.on('data', (chunk: Buffer) => {
      // 任何 stderr 输出都算"有进展"，重置空转计时器（无 duration 时也能续命）
      resetIdleTimer();
      const text = chunk.toString();
      stderrBuf += text;
      // 只保留尾部，避免无限增长（错误信息一般在末尾）
      if (stderrBuf.length > 16384) {
        stderrBuf = stderrBuf.slice(-16384);
      }

      if (!opts.onProgress || !durationSec) return;
      // ffmpeg -progress 每秒一行 key=value，关心 out_time_us（微秒）
      const matches = text.matchAll(/out_time_us=(\d+)/g);
      for (const m of matches) {
        const us = Number.parseInt(m[1], 10);
        if (!Number.isFinite(us)) continue;
        const fraction = Math.min(1, us / 1_000_000 / durationSec);
        // 只在变化超过 1% 时上报，避免抖动
        if (fraction - lastReportedFraction >= 0.01 || fraction >= 1) {
          lastReportedFraction = fraction;
          opts.onProgress(fraction);
        }
      }
    });

    proc.on('error', (err) => {
      clearTimers();
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    proc.on('close', async (code) => {
      clearTimers();

      // 被超时看门狗 SIGKILL：给出明确的超时原因，便于上层标失败而非误判"退出码异常"
      if (killedReason) {
        const detail =
          killedReason === 'idle'
            ? `no output for ${Math.round(idleTimeoutMs / 1000)}s`
            : `exceeded ${Math.round(maxTimeoutMs / 60_000)}min hard limit`;
        logger.error({ sessionTimeout: killedReason }, `ffmpeg killed by timeout: ${detail}`);
        reject(new Error(`ffmpeg timed out (${detail})`));
        return;
      }

      if (code !== 0) {
        // 摘出最后一段错误（ffmpeg 错误信息通常在 stderr 尾部）
        const errTail = stderrBuf.split('\n').slice(-10).join('\n').trim();
        logger.error({ code, errTail: errTail.slice(0, 1024) }, 'ffmpeg transcode failed');
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }

      try {
        const stat = await fs.stat(opts.outputPath);
        opts.onProgress?.(1);
        resolve({
          outputPath: opts.outputPath,
          durationSec,
          outputSize: stat.size,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * 检测 ffmpeg 是否可用。启动时调用一次以提前报错。
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
