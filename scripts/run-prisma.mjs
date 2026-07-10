// Prisma CLI 包装器 —— 确保每次调用 prisma 前，DATABASE_URL 已从 .env.local / .env 载入。
//
// 解决两个长期困扰的问题：
//  ① env("DATABASE_URL") 不认：Prisma CLI 从不读 .env.local（真实连接串所在），裸调 `prisma …`
//     在缺 `.env` 软链的 worktree / 全新克隆 / CI / 部署源码目录里解析不到，被迫把连接串硬编码进 schema。
//     → 本包装器先 loadEnvFileIfNeeded() 把 .env.local / .env 灌进 process.env，再 spawn prisma。
//  ② 缺 DATABASE_URL 时不报错：Prisma 5.x 的 `prisma generate` 在无 DATABASE_URL 时静默 exit 0，
//     掩盖配置缺失，直到运行期 / db push 才炸。→ 对需要连库的子命令（db / migrate / studio）大声报错；
//     对 generate（构建/CI 常在无数据库下生成 client，不连库）则给醒目告警而非静默通过。
//
// 用法：node scripts/run-prisma.mjs <prisma 子命令与参数...>
//   例：node scripts/run-prisma.mjs generate
//       node scripts/run-prisma.mjs db push --skip-generate

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnvFileIfNeeded } from './load-env.mjs';

const ROOT = process.cwd();
const args = process.argv.slice(2);

loadEnvFileIfNeeded(ROOT);

// 需要真正连接数据库的子命令：缺 DATABASE_URL 必须硬失败，绝不静默放行。
// generate 不连库，故排除（否则会打断 Docker deps/builder 阶段等合法的“无库生成 client”）。
const NEEDS_DB = ['db', 'migrate', 'studio'].includes(args[0]);

if (!process.env.DATABASE_URL?.trim()) {
  const hint =
    'DATABASE_URL 未设置：Prisma 无法解析 schema.prisma 里的 env("DATABASE_URL")。\n' +
    '  请在项目根的 .env.local（或 .env）中配置 DATABASE_URL，或通过环境变量注入。';
  if (NEEDS_DB) {
    console.error(`[prisma] ✗ ${hint}`);
    process.exit(1);
  }
  // generate 等不连库的命令：不阻断，但醒目告警，避免像旧版那样“静默成功”掩盖问题。
  console.warn(`[prisma] ⚠ ${hint}\n  当前命令 \`prisma ${args.join(' ')}\` 不连库，继续执行。`);
}

const prismaBin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
);
if (!existsSync(prismaBin)) {
  console.error('[prisma] 未找到 Prisma CLI（node_modules/.bin/prisma）。请先运行 npm ci。');
  process.exit(1);
}

const result = spawnSync(prismaBin, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
if (result.error) {
  console.error('[prisma] 启动失败:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
