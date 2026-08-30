#!/usr/bin/env node
/**
 * LectureLive 音频增强 Worker
 *
 * 部署在独立机器（如甲骨文 ARM 2C12G）上的音频后处理服务。
 * 零 npm 依赖，仅需 Node ≥ 20 + ffmpeg/ffprobe（+ 可选 deep-filter）。
 *
 * 处理管线（对齐 echo360 方案）：
 *   1. ffprobe 探测输入（时长/采样率）
 *   2. 转码为 48kHz 单声道 WAV
 *   3. loudnorm 双遍响度标准化（默认 -14 LUFS / -1.0 dBTP）
 *   4. 降噪：deep-filter（DeepFilterNet，默认 --atten-lim-db 30）
 *      → 失败或未安装时兜底 ffmpeg afftdn=nr=15
 *      → 全部失败则仅保留响度标准化结果（绝不因降噪失败而报废任务）
 *   5. 编码输出 m4a（AAC + faststart，Safari/Range 友好）或 opus/webm
 *
 * HTTP 协议（全部需要 Authorization: Bearer <AUDIO_WORKER_TOKEN>）：
 *   GET    /healthz              → 探活 + 队列/引擎状态（无鉴权时仅返回 {ok:true}）
 *   PUT    /jobs/:id/input       → 流式上传原始音频
 *   POST   /jobs/:id/start       → 入队开始处理（JSON 参数）
 *   GET    /jobs/:id             → 查询状态/进度
 *   GET    /jobs/:id/output      → 下载处理结果（支持流式）
 *   DELETE /jobs/:id             → 清理任务目录（幂等）
 *
 * 环境变量见文件底部 CONFIG 与 worker/README.md。
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { createWriteStream, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// ============================ 配置 ============================

const CONFIG = {
  port: intEnv('AUDIO_WORKER_PORT', 8790),
  host: process.env.AUDIO_WORKER_HOST || '127.0.0.1',
  token: process.env.AUDIO_WORKER_TOKEN || '',
  workDir: process.env.AUDIO_WORKER_DATA_DIR || path.join(process.cwd(), 'data'),
  // 同时处理的任务数。2C 机器保持 1，处理中的 ffmpeg/deep-filter 自己会吃满多核
  concurrency: intEnv('AUDIO_WORKER_CONCURRENCY', 1),
  // 排队上限（不含运行中）。超过则 start 返回 429，由主服务器稍后重试
  queueLimit: intEnv('AUDIO_WORKER_QUEUE_LIMIT', 8),
  // 输入文件大小上限（字节）
  maxInputBytes: intEnv('AUDIO_WORKER_MAX_INPUT_BYTES', 2 * 1024 * 1024 * 1024),
  // 任务目录保留时长（小时），到期自动清理（成功/失败都清；主服务器取完会主动 DELETE）
  retentionHours: intEnv('AUDIO_WORKER_RETENTION_HOURS', 24),
  // 单任务处理超时（分钟），超时杀进程标记失败
  jobTimeoutMinutes: intEnv('AUDIO_WORKER_JOB_TIMEOUT_MINUTES', 150),
  // 不可信输入的 ffprobe 必须远短于整个处理任务；坏容器不能占住 worker 数小时
  probeTimeoutMs: intEnv('AUDIO_WORKER_PROBE_TIMEOUT_MS', 60_000),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  // deep-filter 可执行文件；不配置则在 PATH 里找 deep-filter / deepFilter
  deepFilterBin: process.env.DEEP_FILTER_BIN || '',
}

const VERSION = '1.0.0'

// ============================ 媒体输入安全边界 ============================

/** ffmpeg/ffprobe 只允许读取当前任务的本地文件和已显式建立的 pipe。 */
export const MEDIA_PROTOCOL_WHITELIST = 'file,pipe'

/**
 * 只接收自包含的常见音视频容器。playlist/脚本型 demuxer 即使伪造 Content-Type 也不在此列。
 * format_name 可能返回逗号分隔的候选（如 mov,mp4,m4a,3gp,3g2,mj2）。
 */
export const ALLOWED_MEDIA_CONTAINER_FORMATS = new Set([
  'matroska', 'webm',
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2',
  'ogg', 'wav', 'aiff', 'aif', 'flac',
  'mp3', 'mp2', 'mp1', 'aac', 'adts',
  'asf', 'asf_o', 'wma', 'avi', 'm4v',
  'mpeg', 'mpegvideo', 'mpegts', 'ac3', 'eac3', 'amr', 'caf', 'w64',
])

const DENIED_MEDIA_CONTAINER_FORMATS = new Set([
  'hls', 'applehttp', 'm3u8',
  'concat', 'ffconcat', 'dash',
  'rtsp', 'rtp', 'sdp', 'rtp_mpegts',
  'image2', 'image2pipe', 'xml_dash', 'webvtt',
])

const ALLOWED_MEDIA_FORMATS_ARG = [...ALLOWED_MEDIA_CONTAINER_FORMATS].join(',')
const SAFE_INPUT_ARGS = ['-protocol_whitelist', MEDIA_PROTOCOL_WHITELIST]
const SAFE_UNTRUSTED_INPUT_ARGS = [
  ...SAFE_INPUT_ARGS,
  '-format_whitelist', ALLOWED_MEDIA_FORMATS_ARG,
]

/** 纯文本 playlist/concat 文件没有这些受支持容器的魔数。 */
export function sniffMediaContainerMagic(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return false
  const [b0, b1, b2, b3] = head
  if (head.length >= 8) {
    const box = head.toString('latin1', 4, 8)
    if (['ftyp', 'styp', 'moov', 'free', 'mdat', 'skip'].includes(box)) return true
  }
  const ascii4 = head.toString('latin1', 0, 4)
  if (['RIFF', 'OggS', 'fLaC', 'FORM', 'caff'].includes(ascii4)) return true
  // Sony Wave64 以 RIFF GUID 开头，不是普通 WAV 的大写 `RIFF` chunk。
  if (
    head.length >= 16 &&
    head.subarray(0, 16).equals(
      Buffer.from([0x72, 0x69, 0x66, 0x66, 0x2e, 0x91, 0xcf, 0x11,
        0xa5, 0xd6, 0x28, 0xdb, 0x04, 0xc1, 0x00, 0x00])
    )
  ) return true
  if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) return true
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return true
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true
  // AC-3 / E-AC-3 共用 0x0b77 syncword；后续还必须通过 ffprobe demuxer 白名单。
  if (b0 === 0x0b && b1 === 0x77) return true
  if (head.subarray(0, 6).toString('ascii') === '#!AMR\n') return true
  if (head.subarray(0, 9).toString('ascii') === '#!AMR-WB\n') return true
  if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) return true
  // MPEG program/video elementary stream 的 pack/sequence/VOP 开始码。
  if (
    b0 === 0x00 && b1 === 0x00 && b2 === 0x01 &&
    [0x00, 0xb0, 0xb2, 0xb3, 0xb5, 0xb6, 0xb8, 0xba].includes(b3)
  ) return true
  // MPEG-TS 没有固定文件头；要求两个连续 packet 位置的 sync byte，
  // 同时覆盖 188/192(M2TS)/204-byte packet，避免只看首字节 0x47 的误报。
  for (const offset of [0, 4]) {
    for (const packetSize of [188, 192, 204]) {
      if (
        head.length > offset + packetSize &&
        head[offset] === 0x47 &&
        head[offset + packetSize] === 0x47
      ) return true
    }
  }
  return false
}

export function classifyMediaContainerFormat(formatName) {
  const tokens = String(formatName || '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.length === 0) return { allowed: false, reason: 'empty format_name' }
  const denied = tokens.find((token) => DENIED_MEDIA_CONTAINER_FORMATS.has(token))
  if (denied) return { allowed: false, reason: `denied demuxer: ${denied}` }
  if (!tokens.some((token) => ALLOWED_MEDIA_CONTAINER_FORMATS.has(token))) {
    return { allowed: false, reason: `demuxer not in allowlist: ${formatName}` }
  }
  return { allowed: true }
}

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

// ============================ 日志 ============================

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`
  // eslint-disable-next-line no-console
  console.log(extra ? `${line} ${JSON.stringify(extra)}` : line)
}

// ============================ 任务模型 ============================

/**
 * 任务目录布局：{workDir}/{jobId}/
 *   input.bin   原始上传音频
 *   state.json  任务状态（重启后据此恢复/标记中断）
 *   log.txt     处理日志（追加）
 *   output.m4a / output.webm  最终产物
 * 中间文件（work.wav / norm.wav / denoised.wav）处理完即删。
 */

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 内存中的任务表：jobId → state（state.json 的镜像） */
const jobs = new Map()
/** 排队中的 jobId（FIFO） */
const queue = []
/** 运行中的任务数 */
let runningCount = 0
/** 运行中任务的子进程句柄，用于超时/关闭时终止 */
const runningProcs = new Map()
/** 覆盖完整 runPipeline catch/finally 的 promise；取消须等它收尾才释放 jobId。 */
const runningPipelines = new Map()
/** DELETE 单飞退役；存在期间禁止同 jobId 重用，防止 ABA 删新目录。 */
const retiringJobs = new Map()
/** 流式上传/启动请求也是 job 世代的一部分，DELETE 须取消并等待它们。 */
const activeUploads = new Map()
const activeStarts = new Map()
let shuttingDown = false

function trackJobOperation(registry, jobId, fields) {
  let resolveDone
  const operation = {
    ...fields,
    done: new Promise((resolve) => { resolveDone = resolve }),
    finish() {
      if (!resolveDone) return
      const resolve = resolveDone
      resolveDone = null
      if (registry.get(jobId) === operation) registry.delete(jobId)
      resolve()
    },
  }
  registry.set(jobId, operation)
  return operation
}

function jobDir(jobId) {
  return path.join(CONFIG.workDir, jobId)
}

function newState(jobId) {
  return {
    jobId,
    status: 'created', // created → queued → running → succeeded | failed
    stage: null, // probe/transcode/measure/normalize/denoise/encode
    progress: 0, // 0-100 粗略进度
    error: null,
    params: null,
    input: null, // { bytes, contentType }
    output: null, // { file, bytes, format, durationMs }
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  }
}

async function saveState(state) {
  const file = path.join(jobDir(state.jobId), 'state.json')
  const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, file)
}

async function appendJobLog(jobId, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  await fs.appendFile(path.join(jobDir(jobId), 'log.txt'), line).catch(() => {})
  log('info', `job=${jobId} ${message}`)
}

// ============================ 外部命令 ============================

/**
 * 运行子进程并收集输出。onStderrLine 用于解析 ffmpeg 进度。
 * 返回 { code, stdout, stderr }；spawn 失败（如命令不存在）时 reject。
 */
function terminateChild(child) {
  if (!child || child.killed) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      // run() 用 detached process group；杀整组，避免解析器派生进程在超时后残留。
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // 子进程可能已退出或平台不支持负 pid，回落到直接 kill。
    }
  }
  child.kill('SIGKILL')
}

/** 旧世代 child 延迟 close 时不得删除同 jobId 的新世代句柄。 */
export function unregisterRunningProcess(registry, jobId, child) {
  if (registry.get(jobId) === child) registry.delete(jobId)
}

function run(bin, args, { jobId, onStderrLine, timeoutMs } = {}) {
  // DELETE/关机可能恰好发生在两个子进程之间。不只杀“当下那个”，
  // 还必须禁止旧 pipeline 在收尾期间再 spawn 下一阶段。
  if (jobId && (retiringJobs.has(jobId) || shuttingDown)) {
    return Promise.reject(new Error('job cancelled before spawning child process'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    if (jobId) runningProcs.set(jobId, child)

    let stdout = ''
    let stderr = ''
    let stderrTail = ''
    let timer = null
    if (timeoutMs) {
      timer = setTimeout(() => {
        terminateChild(child)
      }, timeoutMs)
    }

    child.stdout.on('data', (d) => {
      stdout += d
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      // 只保留尾部，防止长任务撑爆内存
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024)
      if (onStderrLine) {
        stderrTail += d
        let idx
        while ((idx = stderrTail.search(/[\r\n]/)) >= 0) {
          const line = stderrTail.slice(0, idx)
          stderrTail = stderrTail.slice(idx + 1)
          if (line.trim()) onStderrLine(line)
        }
      }
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (jobId) unregisterRunningProcess(runningProcs, jobId, child)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (jobId) unregisterRunningProcess(runningProcs, jobId, child)
      resolve({ code, stdout, stderr })
    })
  })
}

/** 在 PATH 中定位可执行文件（which） */
async function which(cmd) {
  try {
    const { code, stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [cmd])
    if (code === 0 && stdout.trim()) return stdout.trim().split('\n')[0]
  } catch {
    /* which 本身不存在时忽略 */
  }
  return null
}

// 只缓存「找到了」的结果；没找到不缓存——每次调用重探（healthz/每任务一次 which，
// 开销可忽略）。这样运行中补装 deep-filter 后立即生效，无需重启服务。
let deepFilterPathCache = null // null=尚未找到 string=路径
async function resolveDeepFilter() {
  if (deepFilterPathCache) return deepFilterPathCache
  if (CONFIG.deepFilterBin) {
    try {
      await fs.access(CONFIG.deepFilterBin)
      deepFilterPathCache = CONFIG.deepFilterBin
      return deepFilterPathCache
    } catch {
      log('warn', `DEEP_FILTER_BIN 配置的路径不可访问: ${CONFIG.deepFilterBin}`)
    }
  }
  deepFilterPathCache = (await which('deep-filter')) || (await which('deepFilter')) || null
  return deepFilterPathCache
}

async function hasFfmpeg() {
  try {
    const { code } = await run(CONFIG.ffmpegBin, ['-version'])
    return code === 0
  } catch {
    return false
  }
}

// ============================ 音频管线 ============================

async function readMagicHead(file, length = 412) {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(length)
    const { bytesRead } = await handle.read(head, 0, length, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function probeFormatName(file, jobId) {
  const { code, stdout, stderr } = await run(CONFIG.ffprobeBin, [
    ...SAFE_UNTRUSTED_INPUT_ARGS,
    '-v', 'error',
    '-probesize', '10485760',
    '-analyzeduration', '15000000',
    '-show_entries', 'format=format_name',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { jobId, timeoutMs: CONFIG.probeTimeoutMs })
  if (code !== 0) {
    throw new Error(`ffprobe 容器识别失败(exit ${code}): ${stderr.slice(-300)}`)
  }
  return stdout.trim()
}

/**
 * 在任何解析器看到上传内容前做两层 allowlist：二进制魔数 + ffprobe demuxer。
 * 固定 input.bin 路径只能防参数注入，不能阻止 m3u8/concat 内容诱导 ffmpeg 访问网络或其它文件。
 */
export async function validateUploadedMediaContainer(file, jobId) {
  const head = await readMagicHead(file)
  if (!sniffMediaContainerMagic(head)) {
    throw new Error('拒绝未知媒体容器（可能是 playlist/concat/文本脚本）')
  }
  const formatName = await probeFormatName(file, jobId)
  const verdict = classifyMediaContainerFormat(formatName)
  if (!verdict.allowed) {
    throw new Error(`拒绝媒体容器：${verdict.reason}`)
  }
  return formatName
}

/** ffprobe 拿时长（毫秒）。合法 streaming WebM 可能没有 format.duration，此时返回 null。 */
async function probeDurationMs(file, jobId) {
  try {
    const { code, stdout } = await run(CONFIG.ffprobeBin, [
      ...SAFE_INPUT_ARGS,
      '-v', 'error',
      '-probesize', '10485760',
      '-analyzeduration', '15000000',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ], { jobId, timeoutMs: CONFIG.probeTimeoutMs })
    if (code !== 0) return null
    const dur = Number.parseFloat(JSON.parse(stdout)?.format?.duration)
    return Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null
  } catch {
    return null
  }
}

/** 解析 ffmpeg -progress 输出的 out_time_ms/out_time，换算总体进度 */
function makeProgressParser(totalMs, stagePctFrom, stagePctTo, state) {
  return (line) => {
    // -progress 输出形如 out_time_ms=123456789（微秒）或 out_time=00:12:34.56
    const m = line.match(/^out_time_ms=(\d+)/)
    if (!m || !totalMs) return
    const doneMs = Number.parseInt(m[1], 10) / 1000
    const frac = Math.max(0, Math.min(1, doneMs / totalMs))
    state.progress = Math.round(stagePctFrom + (stagePctTo - stagePctFrom) * frac)
  }
}

/** 从 loudnorm pass1 的 stderr 里抠出 JSON 统计块 */
function parseLoudnormJson(stderr) {
  // loudnorm 的 JSON 是 stderr 末尾一段独立的 { ... }
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1))
    return parsed && typeof parsed.input_i !== 'undefined' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 执行完整增强管线。state 会被就地更新（stage/progress），
 * 各阶段变更后由调用方负责 saveState。
 */
async function runPipeline(state) {
  const dir = jobDir(state.jobId)
  const jobId = state.jobId
  const p = state.params
  const inputFile = path.join(dir, 'input.bin')
  const workWav = path.join(dir, 'work.wav')
  const normWav = path.join(dir, 'norm.wav')
  const denoisedWav = path.join(dir, 'denoised.wav')
  const cleanup = [workWav, normWav, denoisedWav]
  const stepTimeout = CONFIG.jobTimeoutMinutes * 60 * 1000

  const setStage = async (stage, progress) => {
    state.stage = stage
    state.progress = progress
    await saveState(state)
    await appendJobLog(jobId, `stage=${stage}`)
  }

  try {
    // ---------- 1. 探测 ----------
    await setStage('probe', 2)
    const containerFormat = await validateUploadedMediaContainer(inputFile, jobId)
    await appendJobLog(jobId, `输入容器 ${containerFormat}`)
    let durationMs = await probeDurationMs(inputFile, jobId)
    if (durationMs) await appendJobLog(jobId, `输入时长 ${Math.round(durationMs / 1000)}s`)

    // ---------- 2. 转码 48k 单声道 WAV ----------
    await setStage('transcode', 5)
    {
      const { code, stderr } = await run(
        CONFIG.ffmpegBin,
        ['-hide_banner', '-nostdin', '-y', ...SAFE_UNTRUSTED_INPUT_ARGS, '-i', inputFile,
          '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le',
          '-progress', 'pipe:2', workWav],
        { jobId, timeoutMs: stepTimeout, onStderrLine: makeProgressParser(durationMs, 5, 20, state) },
      )
      if (code !== 0) throw new Error(`输入转码失败(ffmpeg exit ${code}): ${stderr.slice(-400)}`)
    }
    // MediaRecorder 产生的 streaming WebM 可能没有容器 duration；安全解码为自生成 WAV 后再测。
    if (!durationMs) durationMs = await probeDurationMs(workWav, jobId)
    if (!durationMs) throw new Error('无法从已解码媒体取得有效时长，拒绝继续处理')

    // ---------- 3. loudnorm 双遍 ----------
    const targetI = p.targetLufs
    const targetTp = p.truePeakDb
    let normalized = false
    await setStage('measure', 22)
    const pass1 = await run(
      CONFIG.ffmpegBin,
      ['-hide_banner', '-nostdin', ...SAFE_INPUT_ARGS, '-i', workWav,
        '-af', `loudnorm=I=${targetI}:TP=${targetTp}:LRA=11:print_format=json`,
        '-f', 'null', '-'],
      { jobId, timeoutMs: stepTimeout },
    )
    const measured = pass1.code === 0 ? parseLoudnormJson(pass1.stderr) : null
    if (measured) {
      await appendJobLog(jobId, `测得响度 I=${measured.input_i} LUFS, TP=${measured.input_tp} dBTP`)
      await setStage('normalize', 30)
      const filters = [
        `loudnorm=I=${targetI}:TP=${targetTp}:LRA=11`,
        `measured_I=${measured.input_i}`,
        `measured_TP=${measured.input_tp}`,
        `measured_LRA=${measured.input_lra}`,
        `measured_thresh=${measured.input_thresh}`,
        `offset=${measured.target_offset}`,
        'linear=true',
      ].join(':')
      const pass2 = await run(
        CONFIG.ffmpegBin,
        ['-hide_banner', '-nostdin', '-y', ...SAFE_INPUT_ARGS, '-i', workWav,
          '-af', filters, '-ar', '48000', '-c:a', 'pcm_s16le',
          '-progress', 'pipe:2', normWav],
        { jobId, timeoutMs: stepTimeout, onStderrLine: makeProgressParser(durationMs, 30, 45, state) },
      )
      if (pass2.code === 0) {
        normalized = true
      } else {
        await appendJobLog(jobId, `loudnorm 第二遍失败(exit ${pass2.code})，跳过响度标准化`)
      }
    } else {
      await appendJobLog(jobId, 'loudnorm 测量失败，跳过响度标准化')
    }
    if (!normalized) {
      // 与 echo360 相同的兜底策略：标准化失败不终止任务，继续用原始素材
      await fs.copyFile(workWav, normWav)
    }

    // ---------- 4. 降噪 ----------
    let denoised = false
    let denoiseEngine = 'none'
    if (p.denoise !== 'off') {
      await setStage('denoise', 50)
      if (p.denoise === 'auto' || p.denoise === 'deep') {
        const df = await resolveDeepFilter()
        if (df) {
          try {
            // deep-filter 输出到 -o 目录且文件名与输入相同（norm.wav）
            // norm.wav 本身就在该目录，所以让它输出到子目录避免自我覆盖
            const dfOutDir = path.join(dir, 'df-out')
            await fs.mkdir(dfOutDir, { recursive: true })
            const { code, stderr } = await run(
              df,
              [normWav, '-o', dfOutDir, '--atten-lim-db', String(p.attenLimDb)],
              { jobId, timeoutMs: stepTimeout },
            )
            const produced = path.join(dfOutDir, path.basename(normWav))
            if (code === 0 && (await fs.stat(produced).catch(() => null))) {
              await fs.rename(produced, denoisedWav)
              await fs.rm(dfOutDir, { recursive: true, force: true })
              denoised = true
              denoiseEngine = 'deepfilternet'
            } else {
              await appendJobLog(jobId, `deep-filter 失败(exit ${code}): ${stderr.slice(-300)}`)
              await fs.rm(dfOutDir, { recursive: true, force: true })
            }
          } catch (err) {
            await appendJobLog(jobId, `deep-filter 异常: ${err?.message || err}`)
          }
        } else if (p.denoise === 'deep') {
          await appendJobLog(jobId, 'deep-filter 未安装，denoise=deep 无法满足，回落 afftdn')
        }
      }
      if (!denoised && p.denoise !== 'deep-only') {
        // afftdn 兜底（与 echo360 的 AUDIO_FALLBACK_DENOISE 等价）
        const { code, stderr } = await run(
          CONFIG.ffmpegBin,
          ['-hide_banner', '-nostdin', '-y', ...SAFE_INPUT_ARGS, '-i', normWav,
            '-af', 'afftdn=nr=15', '-c:a', 'pcm_s16le',
            '-progress', 'pipe:2', denoisedWav],
          { jobId, timeoutMs: stepTimeout, onStderrLine: makeProgressParser(durationMs, 55, 75, state) },
        )
        if (code === 0) {
          denoised = true
          denoiseEngine = 'afftdn'
        } else {
          await appendJobLog(jobId, `afftdn 兜底也失败(exit ${code}): ${stderr.slice(-300)}`)
        }
      }
    }
    if (!denoised) {
      // 所有降噪都失败/关闭：只交付响度标准化结果，任务仍算成功
      await fs.copyFile(normWav, denoisedWav)
    }
    await appendJobLog(jobId, `降噪引擎: ${denoiseEngine}`)

    // ---------- 4.5 降噪后响度补偿 ----------
    // 降噪会消掉一部分能量（人声场景轻微、噪声占比高时明显），导致成品响度低于目标。
    // 这里做纯线性增益校正（volume filter，零动态处理伪影）：重测 → 差距 >1dB 才补，
    // 增益上限受真峰值约束（不让 TP 超过目标）。失败不阻塞任务。
    if (denoised) {
      try {
        const remeasure = await run(
          CONFIG.ffmpegBin,
          ['-hide_banner', '-nostdin', ...SAFE_INPUT_ARGS, '-i', denoisedWav,
            '-af', `loudnorm=I=${targetI}:TP=${targetTp}:LRA=11:print_format=json`,
            '-f', 'null', '-'],
          { jobId, timeoutMs: stepTimeout },
        )
        const post = remeasure.code === 0 ? parseLoudnormJson(remeasure.stderr) : null
        const postI = Number.parseFloat(post?.input_i)
        const postTp = Number.parseFloat(post?.input_tp)
        if (Number.isFinite(postI) && Number.isFinite(postTp) && postI > -70) {
          const wantGain = targetI - postI
          const tpHeadroom = targetTp - postTp
          const gain = Math.min(wantGain, tpHeadroom)
          if (gain > 1) {
            const touched = path.join(dir, 'touched.wav')
            cleanup.push(touched)
            const { code } = await run(
              CONFIG.ffmpegBin,
              ['-hide_banner', '-nostdin', '-y', ...SAFE_INPUT_ARGS, '-i', denoisedWav,
                '-af', `volume=${gain.toFixed(2)}dB`, '-c:a', 'pcm_s16le', touched],
              { jobId, timeoutMs: stepTimeout },
            )
            if (code === 0) {
              await fs.rename(touched, denoisedWav)
              await appendJobLog(jobId, `降噪后响度补偿 +${gain.toFixed(2)}dB (测得 ${postI} LUFS)`)
            }
          }
        }
      } catch (err) {
        await appendJobLog(jobId, `响度补偿跳过: ${err?.message || err}`)
      }
    }

    // ---------- 5. 编码输出 ----------
    await setStage('encode', 80)
    const format = p.outputFormat === 'opus' ? 'opus' : 'm4a'
    const outFile = path.join(dir, format === 'opus' ? 'output.webm' : 'output.m4a')
    const encodeArgs = format === 'opus'
      ? ['-c:a', 'libopus', '-b:a', '48k', '-f', 'webm']
      : ['-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4']
    {
      const { code, stderr } = await run(
        CONFIG.ffmpegBin,
        ['-hide_banner', '-nostdin', '-y', ...SAFE_INPUT_ARGS, '-i', denoisedWav,
          ...encodeArgs, '-progress', 'pipe:2', outFile],
        { jobId, timeoutMs: stepTimeout, onStderrLine: makeProgressParser(durationMs, 80, 97, state) },
      )
      if (code !== 0) throw new Error(`输出编码失败(ffmpeg exit ${code}): ${stderr.slice(-400)}`)
    }

    const stat = await fs.stat(outFile)
    state.output = {
      file: path.basename(outFile),
      bytes: stat.size,
      format,
      durationMs,
      normalized,
      denoiseEngine,
    }
    state.status = 'succeeded'
    state.stage = 'done'
    state.progress = 100
    state.finishedAt = new Date().toISOString()
    await saveState(state)
    await appendJobLog(jobId, `完成: ${state.output.file} ${stat.size} bytes`)
  } catch (err) {
    state.status = 'failed'
    state.error = String(err?.message || err).slice(0, 1000)
    state.finishedAt = new Date().toISOString()
    await saveState(state)
    await appendJobLog(jobId, `失败: ${state.error}`)
  } finally {
    for (const f of cleanup) await fs.rm(f, { force: true }).catch(() => {})
  }
}

// ============================ 队列执行器 ============================

function enqueue(jobId) {
  queue.push(jobId)
  pump()
}

function pump() {
  while (!shuttingDown && runningCount < CONFIG.concurrency && queue.length > 0) {
    const jobId = queue.shift()
    const state = jobs.get(jobId)
    if (!state || state.status !== 'queued' || retiringJobs.has(jobId)) continue
    runningCount += 1
    state.status = 'running'
    state.startedAt = new Date().toISOString()
    // 运行状态落盘后再跑管线；管线自身 try/catch，绝不抛出
    let pipelinePromise
    pipelinePromise = saveState(state)
      .then(() => runPipeline(state))
      .catch(async (err) => {
        state.status = 'failed'
        state.error = String(err?.message || err).slice(0, 1000)
        state.finishedAt = new Date().toISOString()
        await saveState(state).catch(() => {})
      })
      .finally(() => {
        if (runningPipelines.get(jobId) === pipelinePromise) {
          runningPipelines.delete(jobId)
        }
        runningCount -= 1
        pump()
      })
    runningPipelines.set(jobId, pipelinePromise)
  }
}

/**
 * 完整退役一个 jobId。必须等子进程 close、runPipeline catch 和 finally
 * 全部结束，再删目录/释放 ID；否则旧任务会覆写或删除立即复用 ID 的新任务。
 */
function retireJob(jobId) {
  const inFlight = retiringJobs.get(jobId)
  if (inFlight) return inFlight

  let retirement
  retirement = (async () => {
    const state = jobs.get(jobId)
    const qi = queue.indexOf(jobId)
    if (qi >= 0) queue.splice(qi, 1)

    if (state) {
      state.status = 'failed'
      state.error = 'cancelled'
      state.finishedAt = new Date().toISOString()
    }

    // 操作可能正在“上传/读 start body/两个 ffmpeg 阶段之间”。循环
    // 重新抓取当前世代的所有操作，直到完整静默，不留 spawn/write 缝隙。
    for (;;) {
      const upload = activeUploads.get(jobId)
      const start = activeStarts.get(jobId)
      const pipelinePromise = runningPipelines.get(jobId)
      const proc = runningProcs.get(jobId)
      upload?.cancel?.()
      start?.cancel?.()
      if (proc) terminateChild(proc)

      const waits = [...new Set([
        upload?.done,
        start?.done,
        pipelinePromise,
      ].filter(Boolean))]
      if (waits.length === 0) break
      await Promise.allSettled(waits)
    }

    if (jobs.get(jobId) === state) jobs.delete(jobId)
    await fs.rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {})
  })().finally(() => {
    if (retiringJobs.get(jobId) === retirement) retiringJobs.delete(jobId)
  })

  retiringJobs.set(jobId, retirement)
  return retirement
}

// ============================ 启动恢复与清理 ============================

async function restoreJobs() {
  await fs.mkdir(CONFIG.workDir, { recursive: true })
  const entries = await fs.readdir(CONFIG.workDir, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isDirectory() || !JOB_ID_RE.test(ent.name)) continue
    try {
      const raw = await fs.readFile(path.join(CONFIG.workDir, ent.name, 'state.json'), 'utf8')
      const state = JSON.parse(raw)
      // 重启即中断：queued/running 一律标记失败，由主服务器重新派发（含重传输入）
      if (state.status === 'queued' || state.status === 'running') {
        state.status = 'failed'
        state.error = 'worker 重启导致任务中断'
        state.finishedAt = new Date().toISOString()
        await saveState(state)
      }
      jobs.set(state.jobId, state)
    } catch {
      // 没有合法 state.json 的目录视为垃圾，交给周期清理
    }
  }
  log('info', `恢复 ${jobs.size} 个历史任务记录`)
}

async function sweepStale() {
  const now = Date.now()
  const ttlMs = CONFIG.retentionHours * 3600 * 1000
  for (const [jobId, state] of jobs) {
    const ref = state.finishedAt || state.createdAt
    const age = now - new Date(ref).getTime()
    const isFinished = state.status === 'succeeded' || state.status === 'failed'
    // 完成后超保留期，或 created（只传了 input 一直没 start）超 6 小时 → 清
    if ((isFinished && age > ttlMs) || (state.status === 'created' && age > 6 * 3600 * 1000)) {
      // 从读取 age 到此处没有 await；再验世代后立即进入 retire 单飞，
      // 使清理和 PUT/START/DELETE 共用同一 ABA 边界。
      if (jobs.get(jobId) === state) {
        await retireJob(jobId)
        log('info', `清理过期任务 ${jobId}`)
      }
    }
  }
  // 落盘目录里没有内存记录的孤儿目录（state.json 损坏等）也清掉
  const entries = await fs.readdir(CONFIG.workDir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory() || jobs.has(ent.name)) continue
    const st = await fs.stat(path.join(CONFIG.workDir, ent.name)).catch(() => null)
    if (st && now - st.mtimeMs > ttlMs) {
      // stat 是 await 点：期间可能有新 PUT 认领同 ID。删除前重验，并由
      // retireJob 先占位再 rm，不让新世代在 rm await 期间插入。
      if (
        jobs.has(ent.name) || activeUploads.has(ent.name) ||
        activeStarts.has(ent.name) || runningPipelines.has(ent.name) ||
        retiringJobs.has(ent.name)
      ) continue
      await retireJob(ent.name)
    }
  }
}

// ============================ HTTP 处理 ============================

function checkAuth(req) {
  if (!CONFIG.token) return false
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(CONFIG.token)
  return got.length === want.length && timingSafeEqual(got, want)
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 规范化 start 参数，全部带安全边界 */
function normalizeParams(body) {
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
  }
  const denoise = ['auto', 'deep', 'afftdn', 'off'].includes(body?.denoise) ? body.denoise : 'auto'
  const outputFormat = ['m4a', 'opus'].includes(body?.outputFormat) ? body.outputFormat : 'm4a'
  return {
    targetLufs: clamp(body?.targetLufs, -30, -8, -14),
    truePeakDb: clamp(body?.truePeakDb, -9, 0, -1),
    attenLimDb: Math.round(clamp(body?.attenLimDb, 6, 100, 30)),
    denoise,
    outputFormat,
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)

  // 根路径：无鉴权的部署自检页（浏览器直接访问能看到 OK；不泄露版本/队列等细节）
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = [
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>LectureLive Audio Enhance Worker</title>',
      '<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;',
      'align-items:center;justify-content:center;background:#faf7f2;color:#3d3a34}',
      'main{text-align:center}h1{font-size:3rem;margin:0 0 .5rem}p{color:#8a857c}</style>',
      '</head><body><main><h1>✅ OK</h1>',
      '<p>LectureLive audio enhance worker is running.</p>',
      '<p>在 LectureLive 管理后台「设置 → 音频增强」中配置本地址与 token 即可使用。</p>',
      '</main></body></html>',
    ].join('')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(html)
    return
  }

  // /healthz：未鉴权只回 ok，鉴权后附带引擎与队列详情（供 admin"测试连接"）
  if (req.method === 'GET' && url.pathname === '/healthz') {
    if (!checkAuth(req)) return sendJson(res, 200, { ok: true })
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      queue: { running: runningCount, queued: queue.length, capacity: CONFIG.concurrency, queueLimit: CONFIG.queueLimit },
      engines: { ffmpeg: await hasFfmpeg(), deepFilter: Boolean(await resolveDeepFilter()) },
    })
  }

  if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' })

  // 以下路由均为 /jobs/:id[/sub]
  if (segments[0] !== 'jobs' || !segments[1]) return sendJson(res, 404, { error: 'not found' })
  const jobId = segments[1]
  // 严格校验 jobId，杜绝路径穿越
  if (!JOB_ID_RE.test(jobId)) return sendJson(res, 400, { error: 'invalid job id' })
  const sub = segments[2] || null

  // PUT /jobs/:id/input — 流式接收音频
  if (req.method === 'PUT' && sub === 'input') {
    if (shuttingDown) return sendJson(res, 503, { error: 'shutting down' })
    if (
      retiringJobs.has(jobId) || runningPipelines.has(jobId) ||
      activeUploads.has(jobId) || activeStarts.has(jobId)
    ) {
      return sendJson(res, 409, { error: 'job has an active operation' })
    }
    const existing = jobs.get(jobId)
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return sendJson(res, 409, { error: `job is ${existing.status}` })
    }
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10)
    if (Number.isFinite(declared) && declared > CONFIG.maxInputBytes) {
      return sendJson(res, 413, { error: 'input too large' })
    }

    const state = newState(jobId)
    jobs.set(jobId, state)
    const abortController = new AbortController()
    const operation = trackJobOperation(activeUploads, jobId, {
      state,
      cancel: () => abortController.abort(),
    })
    const isCurrent = () =>
      activeUploads.get(jobId) === operation &&
      jobs.get(jobId) === state &&
      !retiringJobs.has(jobId)

    const target = path.join(jobDir(jobId), 'input.bin')
    let received = 0
    try {
      // 重新上传视为重建任务（覆盖旧目录，支持主服务器失败重派）。
      // activeUploads 已在任何 await 之前登记，同 ID 的并发 PUT/DELETE 无法跨世代。
      await fs.rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {})
      if (!isCurrent()) throw new Error('job cancelled')
      await fs.mkdir(jobDir(jobId), { recursive: true })
      if (!isCurrent()) throw new Error('job cancelled')

      const counter = async function* (source) {
        for await (const chunk of source) {
          if (!isCurrent()) throw new Error('job cancelled')
          received += chunk.length
          if (received > CONFIG.maxInputBytes) throw new Error('input too large')
          yield chunk
        }
      }
      await pipeline(
        req,
        counter,
        createWriteStream(target),
        { signal: abortController.signal }
      )
      if (!isCurrent()) throw new Error('job cancelled')

      if (received === 0) throw new Error('empty body')
      state.input = {
        bytes: received,
        contentType: req.headers['content-type'] || 'application/octet-stream',
      }
      await saveState(state)
      if (!isCurrent()) throw new Error('job cancelled')
      await appendJobLog(jobId, `收到输入 ${received} bytes`)
      if (!isCurrent()) throw new Error('job cancelled')
      return sendJson(res, 200, { received })
    } catch (err) {
      const message = String(err?.message || '')
      const cancelled =
        abortController.signal.aborted || retiringJobs.has(jobId) ||
        jobs.get(jobId) !== state || message.includes('cancelled')
      if (jobs.get(jobId) === state && !retiringJobs.has(jobId)) {
        jobs.delete(jobId)
        await fs.rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {})
      }
      const tooLarge = message.includes('too large')
      const empty = message.includes('empty body')
      return sendJson(
        res,
        cancelled ? 409 : tooLarge ? 413 : 400,
        { error: cancelled ? 'job cancelled' : tooLarge ? 'input too large' : empty ? 'empty body' : 'upload failed' }
      )
    } finally {
      operation.finish()
    }
  }

  // POST /jobs/:id/start — 入队
  if (req.method === 'POST' && sub === 'start') {
    if (shuttingDown) return sendJson(res, 503, { error: 'shutting down' })
    if (
      retiringJobs.has(jobId) || activeUploads.has(jobId) ||
      activeStarts.has(jobId) || runningPipelines.has(jobId)
    ) {
      return sendJson(res, 409, { error: 'job has an active operation' })
    }
    const state = jobs.get(jobId)
    if (!state || !state.input) return sendJson(res, 409, { error: 'input not uploaded' })
    if (state.status === 'queued' || state.status === 'running') {
      // 幂等：重复 start 直接回当前状态
      return sendJson(res, 202, { status: state.status })
    }
    if (state.status === 'succeeded') return sendJson(res, 202, { status: 'succeeded' })
    if (queue.length >= CONFIG.queueLimit) return sendJson(res, 429, { error: 'queue full' })

    const operation = trackJobOperation(activeStarts, jobId, {
      state,
      cancel: () => {
        if (typeof req.destroy === 'function' && !req.destroyed) {
          req.destroy(new Error('job cancelled'))
        }
      },
    })
    const isCurrent = () =>
      activeStarts.get(jobId) === operation &&
      jobs.get(jobId) === state &&
      !retiringJobs.has(jobId)

    try {
      const body = await readJsonBody(req)
      if (!isCurrent()) throw new Error('job cancelled')
      if (queue.length >= CONFIG.queueLimit) {
        return sendJson(res, 429, { error: 'queue full' })
      }

      state.params = normalizeParams(body)
      state.status = 'queued'
      state.error = null
      state.progress = 0
      await saveState(state)
      if (!isCurrent()) throw new Error('job cancelled')
      await appendJobLog(jobId, `入队 params=${JSON.stringify(state.params)}`)
      if (!isCurrent()) throw new Error('job cancelled')
      enqueue(jobId)
      return sendJson(res, 202, { status: 'queued', position: queue.length })
    } catch (err) {
      const cancelled =
        retiringJobs.has(jobId) || jobs.get(jobId) !== state ||
        String(err?.message || '').includes('cancelled')
      return sendJson(
        res,
        cancelled ? 409 : 400,
        { error: cancelled ? 'job cancelled' : 'invalid json' }
      )
    } finally {
      operation.finish()
    }
  }

  // GET /jobs/:id — 状态
  if (req.method === 'GET' && !sub) {
    const state = jobs.get(jobId)
    if (!state) return sendJson(res, 404, { error: 'job not found' })
    return sendJson(res, 200, {
      jobId: state.jobId,
      status: state.status,
      stage: state.stage,
      progress: state.progress,
      error: state.error,
      output: state.output ? { bytes: state.output.bytes, format: state.output.format, durationMs: state.output.durationMs, normalized: state.output.normalized, denoiseEngine: state.output.denoiseEngine } : null,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    })
  }

  // GET /jobs/:id/output — 下载结果
  if (req.method === 'GET' && sub === 'output') {
    const state = jobs.get(jobId)
    if (!state || state.status !== 'succeeded' || !state.output) {
      return sendJson(res, state ? 409 : 404, { error: state ? `job is ${state.status}` : 'job not found' })
    }
    const file = path.join(jobDir(jobId), state.output.file)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat) return sendJson(res, 410, { error: 'output expired' })
    res.writeHead(200, {
      'Content-Type': state.output.format === 'opus' ? 'audio/webm' : 'audio/mp4',
      'Content-Length': stat.size,
    })
    try {
      await pipeline(createReadStream(file), res)
    } catch {
      res.destroy()
    }
    return undefined
  }

  // DELETE /jobs/:id — 清理（幂等）
  if (req.method === 'DELETE' && !sub) {
    await retireJob(jobId)
    res.writeHead(204)
    res.end()
    return undefined
  }

  return sendJson(res, 404, { error: 'not found' })
}

// ============================ 启动 ============================

/**
 * token 是否是发行的占位值。
 *
 * C39/P6-11：单元模板里的 `change-me-to-a-64-char-random-hex-string` 实测 40 字符，
 * 稳稳通过 `length < 32` 这道门 —— 于是 install.sh 的 `change-me-*` 黑名单和这里的
 * 长度门禁互相矛盾：手抄单元文件（不跑 install.sh）的机器会带着人尽皆知的 token 起服务。
 * 两处口径必须一致。
 */
function isPlaceholderToken(token) {
  return /^change[-_]me/i.test(token)
}

async function main() {
  if (!CONFIG.token || CONFIG.token.length < 32) {
    log('error', 'AUDIO_WORKER_TOKEN 未设置或长度不足 32 字符，拒绝启动')
    process.exit(1)
  }
  if (isPlaceholderToken(CONFIG.token)) {
    log(
      'error',
      'AUDIO_WORKER_TOKEN 仍是模板里的占位值，拒绝启动。请用 `openssl rand -hex 32` 生成后写入单元文件（或直接跑 worker/install.sh）'
    )
    process.exit(1)
  }
  if (!(await hasFfmpeg())) {
    log('error', `找不到 ffmpeg（FFMPEG_BIN=${CONFIG.ffmpegBin}），拒绝启动`)
    process.exit(1)
  }
  const df = await resolveDeepFilter()
  log('info', df ? `deep-filter 可用: ${df}` : 'deep-filter 未安装，将使用 afftdn 兜底降噪')

  await restoreJobs()
  await sweepStale()
  setInterval(() => sweepStale().catch(() => {}), 30 * 60 * 1000).unref()

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log('error', `请求处理异常: ${err?.message || err}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.destroy()
    })
  })
  // 上传大文件耗时较长，放宽超时
  server.requestTimeout = 30 * 60 * 1000
  server.headersTimeout = 60 * 1000

  server.listen(CONFIG.port, CONFIG.host, () => {
    log('info', `音频增强 worker 启动: http://${CONFIG.host}:${CONFIG.port} (并发=${CONFIG.concurrency}, 数据目录=${CONFIG.workDir})`)
  })

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', '收到退出信号，停止接收新任务…')
    for (const operation of activeUploads.values()) operation.cancel?.()
    for (const operation of activeStarts.values()) operation.cancel?.()
    for (const proc of runningProcs.values()) terminateChild(proc)
    server.close(() => process.exit(0))
    // 运行中的任务由重启恢复逻辑标记失败，主服务器会重新派发
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const invokedAsMain = Boolean(
  process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)

if (invokedAsMain) {
  main().catch((err) => {
    log('error', `启动失败: ${err?.message || err}`)
    process.exit(1)
  })
}
