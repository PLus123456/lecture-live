import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * C39/P6-11：worker 的启动门禁必须拒掉发行的占位 token。
 *
 * `worker/lecturelive-enhance-worker.service` 里的模板值
 * `change-me-to-a-64-char-random-hex-string` 实测 **40 字符**，稳稳越过
 * `audio-enhance-worker.mjs` 原有的 `length < 32` 门禁；而 `worker/install.sh:112`
 * 另有一份 `change-me-*` 黑名单 —— 两处口径不一致，手抄单元文件（不跑 install.sh）
 * 的机器会带着人尽皆知的 token 起服务。
 *
 * worker 在 import 时就会执行 main()，所以这里以子进程方式验证启动行为。
 */

const WORKER_PATH = path.join(process.cwd(), 'worker', 'audio-enhance-worker.mjs');
const PLACEHOLDER_TOKEN = 'change-me-to-a-64-char-random-hex-string';

function runWorker(token: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      env: {
        ...process.env,
        AUDIO_WORKER_TOKEN: token,
        // 指一个必然不存在的 ffmpeg，保证进程无论如何都会尽快退出，不会真的起服务
        FFMPEG_BIN: '/nonexistent/ffmpeg-for-token-gate-test',
        FFPROBE_BIN: '/nonexistent/ffprobe-for-token-gate-test',
        AUDIO_WORKER_DATA_DIR: path.join(process.cwd(), 'test-results', 'worker-gate'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, output });
    });
  });
}

describe('audio-enhance-worker 启动门禁 (C39 / P6-11)', () => {
  it('占位 token 长度 40 —— 老的 length < 32 门禁根本拦不住', () => {
    expect(PLACEHOLDER_TOKEN.length).toBeGreaterThanOrEqual(32);
  });

  it('占位 token 拒绝启动', async () => {
    const { code, output } = await runWorker(PLACEHOLDER_TOKEN);
    expect(code).toBe(1);
    expect(output).toContain('占位值');
  }, 20_000);

  it('大小写/下划线变体同样拒绝（install.sh 的黑名单口径）', async () => {
    const { code, output } = await runWorker(
      'Change_Me_0123456789abcdef0123456789abcdef'
    );
    expect(code).toBe(1);
    expect(output).toContain('占位值');
  }, 20_000);

  it('真随机的 64 位十六进制 token 不被这条门禁拦下（后续因缺 ffmpeg 退出）', async () => {
    const { output } = await runWorker('a3f9'.repeat(16));
    expect(output).not.toContain('占位值');
    expect(output).toContain('ffmpeg');
  }, 20_000);
});
