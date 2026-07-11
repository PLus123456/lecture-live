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

// ── 统一 ffmpeg 并发信号量（P1-20）─────────────────────────────────────────────
// ffmpeg 转码是 CPU/内存密集操作：N 个并发任务派生 N 个 ffmpeg 进程线性放大资源占用，可拖垮
// 整机。此前信号量只在 asyncUploadProcessor 内、只护住上传转录一条路径；完整版补全转录
// （fullTranscribeProcessor）直接调 transcodeToMp3 绕过了它，两条路径叠加仍会超并发。
// 把闸下沉到 transcodeToMp3 本身 → **所有** ffmpeg 转码（异步上传 + 完整版补全 + 将来任何调用方）
// 共享同一把全局信号量，真正统一封顶、超出排队。单 Next 进程部署足够（与内存 progress map 同口径）；
// 多进程部署需换 Redis 分布式信号量。
const MAX_CONCURRENT_FFMPEG = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_TRANSCODES) || 2
);
let activeFfmpeg = 0;
const ffmpegWaiters: Array<() => void> = [];

function acquireFfmpegSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (activeFfmpeg < MAX_CONCURRENT_FFMPEG) {
      activeFfmpeg += 1;
      resolve();
    } else {
      ffmpegWaiters.push(resolve);
    }
  });
}

function releaseFfmpegSlot(): void {
  const next = ffmpegWaiters.shift();
  if (next) {
    // 名额直接转交下一个等待者，activeFfmpeg 计数不变。
    next();
  } else {
    activeFfmpeg = Math.max(0, activeFfmpeg - 1);
  }
}

/** 当前占用的 ffmpeg 并发名额（测试/监控用）。 */
export function getActiveFfmpegCount(): number {
  return activeFfmpeg;
}

/** 统一信号量上限（测试/监控用）。 */
export function getMaxConcurrentFfmpeg(): number {
  return MAX_CONCURRENT_FFMPEG;
}

// ── 安全加固（P1-11）────────────────────────────────────────────────────────
// 用户上传的任意声明媒体会进入 ffprobe/ffmpeg。默认 ffmpeg 支持 http(s)/gopher/ftp/
// tcp/udp/unix/concat 等协议，playlist（HLS/m3u8）与 concat/xml 脚本能让子进程去读外部
// URL 或本机其它文件，构成 SSRF / 任意文件读取面。以下三道闸：
//   1) 只放行 file,pipe 协议（`-protocol_whitelist file,pipe`），并 `-nostdin` 防吊在 stdin；
//   2) 容器魔数白名单：playlist / 外部引用（m3u8/pls/ffconcat/xml）都是纯文本，无二进制容器
//      魔数，先按已知容器魔数挡掉；
//   3) demuxer 白名单：ffprobe 解析容器名，拒 playlist / 外部引用型 demuxer。
// 另外所有子进程都带独立超时看门狗（空转 + 绝对上限）并 drain stdout/stderr，坏输入不挂死。

/** 只放行本地文件与管道，堵死 ffmpeg/ffprobe 的一切网络与外部引用协议。 */
const PROTOCOL_WHITELIST = 'file,pipe';

/**
 * 允许的容器 demuxer（ffprobe format_name，逗号分隔）。只收常见音视频容器；
 * 未在白名单内的一律拒绝（allowlist 模型），playlist / 外部引用型 demuxer 天然被挡。
 */
const ALLOWED_CONTAINER_FORMATS = new Set([
  'matroska', 'webm',
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2',
  'ogg', 'wav', 'aiff', 'aif', 'flac',
  'mp3', 'mp2', 'mp1', 'aac', 'adts',
  'asf', 'asf_o', 'wma', 'avi', 'm4v',
  'mpeg', 'mpegvideo', 'mpegts', 'ac3', 'eac3', 'amr', 'caf', 'w64',
]);

/**
 * 显式拒绝的 demuxer（playlist / 外部引用 / 网络流）。即便未来误进白名单，这里也二次兜底。
 */
const DENIED_CONTAINER_FORMATS = new Set([
  'hls', 'applehttp', 'm3u8',
  'concat', 'ffconcat',
  'dash',
  'rtsp', 'rtp', 'sdp', 'rtp_mpegts',
  'image2', 'image2pipe',
  'xml_dash', 'webvtt',
]);

/** 容器校验失败：可被上层识别为「输入非法」而非「转码器故障」。 */
export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

/**
 * 按前 16 字节魔数判断是否为已知的二进制音视频容器。
 * 返回 false 通常意味着纯文本（playlist/脚本）或不支持的格式 —— 一律拒绝。
 * 纯函数，便于单测。
 */
export function sniffContainerMagic(head: Buffer): boolean {
  if (head.length < 4) return false;
  const b0 = head[0], b1 = head[1], b2 = head[2], b3 = head[3];
  // ISO BMFF（mp4/mov/m4a/3gp）：offset 4..8 == 'ftyp'（也容忍 'styp'/'moov'/'free'/'mdat'）
  if (head.length >= 8) {
    const box = head.toString('latin1', 4, 8);
    if (box === 'ftyp' || box === 'styp' || box === 'moov' || box === 'free' || box === 'mdat' || box === 'skip') {
      return true;
    }
  }
  const ascii4 = head.toString('latin1', 0, 4);
  // RIFF（WAV/AVI）、OggS、fLaC、FORM（AIFF）
  if (ascii4 === 'RIFF' || ascii4 === 'OggS' || ascii4 === 'fLaC' || ascii4 === 'FORM') return true;
  // EBML（webm/mkv）：1A 45 DF A3
  if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) return true;
  // ID3（mp3 带标签）：'ID3'
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return true;
  // MPEG audio 帧同步（mp3/aac-adts）：0xFF 后跟 0xE0..0xFF
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true;
  // ASF/WMA GUID：30 26 B2 75
  if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) return true;
  // MPEG-PS：00 00 01 BA
  if (b0 === 0x00 && b1 === 0x00 && b2 === 0x01 && b3 === 0xba) return true;
  return false;
}

/**
 * 判定 ffprobe 报出的 format_name（可能是逗号分隔的候选集）是否为允许的容器。
 * 规则：命中任一 denylist → 拒；否则要求至少一个候选在 allowlist 内。纯函数，便于单测。
 */
export function classifyContainerFormat(formatName: string): { allowed: boolean; reason?: string } {
  const tokens = formatName
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return { allowed: false, reason: 'empty format_name' };
  }
  for (const t of tokens) {
    if (DENIED_CONTAINER_FORMATS.has(t)) {
      return { allowed: false, reason: `denied demuxer: ${t}` };
    }
  }
  if (!tokens.some((t) => ALLOWED_CONTAINER_FORMATS.has(t))) {
    return { allowed: false, reason: `demuxer not in allowlist: ${formatName}` };
  }
  return { allowed: true };
}

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
 * ffprobe 空转超时（ms）：正常 probe 应在数秒内返回，坏/不响应输入不能永久挂起。
 */
const PROBE_IDLE_TIMEOUT_MS = 30_000;
/** ffprobe 绝对硬上限（ms）：兜底「持续吐字节但永不收尾」。 */
const PROBE_MAX_TIMEOUT_MS = 60_000;

interface ProbeRunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/**
 * 统一的 ffprobe 执行器：强制 `-protocol_whitelist file,pipe`、`-nostdin`，忽略 stdin，
 * drain stdout/stderr，并带空转 + 绝对超时看门狗，命中即 SIGKILL。所有 probe 走这里，
 * 杜绝旧代码 ffprobe 无超时、不消费 stderr 导致的永久挂起（P1-11）。
 */
function runProbe(args: string[]): Promise<ProbeRunResult> {
  const probeBin = process.env.FFPROBE_PATH || 'ffprobe';
  const fullArgs = [
    '-nostdin',
    '-protocol_whitelist', PROTOCOL_WHITELIST,
    ...args,
  ];
  return new Promise((resolve) => {
    const proc = spawn(probeBin, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    let timedOut = false;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, PROBE_IDLE_TIMEOUT_MS);
    };
    const hardTimer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, PROBE_MAX_TIMEOUT_MS);
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    };
    resetIdle();

    // 必须消费 stdout/stderr，否则管道缓冲写满会让子进程阻塞（等于挂死）。
    proc.stdout.on('data', (d) => {
      resetIdle();
      if (stdout.length < 65536) stdout += d.toString();
    });
    proc.stderr.on('data', () => {
      resetIdle();
    });
    const finish = (res: ProbeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(res);
    };
    proc.on('error', () => finish({ code: null, stdout: '', timedOut }));
    proc.on('close', (code) => finish({ code, stdout, timedOut }));
  });
}

/**
 * 用 ffprobe 读取媒体文件时长（秒）。返回 0 表示读不到。
 */
export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await runProbe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const val = Number.parseFloat(stdout.trim());
  return Number.isFinite(val) && val > 0 ? val : 0;
}

/**
 * 用 ffprobe 读取容器 format_name（可能是逗号分隔候选集）。读不到返回 ''。
 */
export async function probeFormatName(filePath: string): Promise<string> {
  const { stdout } = await runProbe([
    '-v', 'error',
    '-show_entries', 'format=format_name',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return stdout.trim();
}

/**
 * 读取文件头 n 字节（不整文件读入内存，几个 GB 的上传也安全）。
 */
async function readMagicHead(filePath: string, n: number): Promise<Buffer> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * 在把上传文件交给 ffmpeg 转码前做容器安全校验（P1-11）：
 *   1) 魔数白名单 —— 挡住纯文本 playlist / concat 脚本（无二进制容器魔数）；
 *   2) demuxer 白名单 —— ffprobe 解析容器名，拒 hls/concat/dash/rtsp 等外部引用型 demuxer。
 * 任一不过抛 MediaValidationError，调用方标失败而非误当转码器故障。
 */
export async function validateMediaContainer(filePath: string): Promise<void> {
  const head = await readMagicHead(filePath, 16);
  if (!sniffContainerMagic(head)) {
    throw new MediaValidationError(
      'Rejected: unrecognized container (magic bytes not in allowlist; possible playlist/text input)'
    );
  }
  const formatName = await probeFormatName(filePath);
  if (!formatName) {
    throw new MediaValidationError('Rejected: ffprobe could not determine container format');
  }
  const verdict = classifyContainerFormat(formatName);
  if (!verdict.allowed) {
    throw new MediaValidationError(`Rejected media container (${verdict.reason})`);
  }
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
  // P1-20：统一并发闸。占名额前会排队，杜绝多路径叠加超并发派生过多 ffmpeg 进程。
  await acquireFfmpegSlot();
  try {
    return await runTranscodeToMp3(opts);
  } finally {
    releaseFfmpegSlot();
  }
}

async function runTranscodeToMp3(opts: TranscodeOptions): Promise<TranscodeResult> {
  const bitrate = opts.bitrateKbps ?? 128;
  const args = [
    // 安全（P1-11）：只放行 file,pipe 协议（须在 -i 之前生效），并 -nostdin 防吊在 stdin 交互。
    // 堵死 http/gopher/ftp/tcp/udp/concat 等协议 —— playlist/外部引用无法触发 SSRF / 任意文件读。
    '-nostdin',
    '-protocol_whitelist', PROTOCOL_WHITELIST,
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
    // 忽略 stdin（配合 -nostdin），drain stdout/stderr；windowsHide 防弹窗。
    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // stdout 也要消费掉，避免管道缓冲写满阻塞子进程。
    proc.stdout.on('data', () => {});

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
    const proc = spawn(FFMPEG_BIN, ['-nostdin', '-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
