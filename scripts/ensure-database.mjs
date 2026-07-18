// 数据库就绪编排器 —— 应用启动 / 升级时把库结构与历史数据一次性对齐。
//
// 调用方：package.json 的 prestart / prestart:ws / db:ensure、docker-entrypoint.sh、deploy/upgrade.sh。
//
// 三步顺序（每步都幂等、可重复执行）：
//   ① 数据感知迁移（scripts/db-migrate-data.mjs）：处理 `db push` 无法自动完成、否则会要求
//      reset 整库的变更（如给有数据的表加必填自增列 seq），先把结构铺到「db push 看了无需破坏」。
//   ② prisma db push：把 schema 最终态对齐到库（加可空列 / 索引 / 改默认值等安全变更）。
//   ③ 历史归属回填（scripts/backfill-conversation-user-id.mjs）：给 db push 新加的可空列
//      （Conversation.userId）回填历史值，避免老对话变「无主」→ 404。
//   ④ 存量用户邮箱验证豁免（scripts/backfill-email-verified-at.mjs）：同理给 User.emailVerifiedAt
//      回填 createdAt，避免管理员开启 email_verification 时把全部老用户锁死在登录门外。
//      一次性（SiteSetting 标记），跑过不再执行。
//
// 受 AUTO_DB_PUSH 控制：设为 0/false/off 时整体跳过（用户选择手动管理 schema）。
//
// 为什么不用 `prisma migrate deploy`：本项目 prisma/migrations/ 目录缺核心表的建表 baseline、
// 缺 migration_lock.toml，无法直接 deploy；自托管单服务器场景下「db push + 幂等数据脚本」更稳。
// 详见 db-migrate-data.mjs 头部说明。

import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadEnvFileIfNeeded } from './load-env.mjs';

// 各运维脚本与本文件同在 scripts/ 下；用本文件所在目录定位，不受 cwd 影响。
const SCRIPT_DIR = import.meta.dirname;
// prisma / 数据脚本都需要从项目根运行（找 prisma/schema.prisma）；所有调用方 cwd 均为项目根。
const ROOT = process.cwd();

function isAutoDbPushDisabled() {
  const value = process.env.AUTO_DB_PUSH?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

// 把 .env.local / .env 载入 process.env（见 scripts/load-env.mjs），使后续子进程
// （数据脚本用 PrismaClient、prisma db push 读 DATABASE_URL）都能拿到连接串。
// 若 DATABASE_URL 已由环境注入（Docker / systemd / --env-file）则不覆盖。

function resolvePrismaBin() {
  const binName = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  return path.join(ROOT, 'node_modules', '.bin', binName);
}

// 跑一步：失败（spawn 错误或非零退出）即整体中止，绝不继续后续步骤。
function runStep(label, command, args) {
  console.log(`[db:init] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[db:init] ${label} —— 启动失败:`, result.error.message);
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    console.error(`[db:init] ${label} —— 退出码 ${result.status}，已中止。`);
    process.exit(result.status);
  }
}

if (isAutoDbPushDisabled()) {
  console.log('[db:init] AUTO_DB_PUSH disabled, skipping schema sync.');
  process.exit(0);
}

loadEnvFileIfNeeded(ROOT);

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());
const hasEnvFile =
  existsSync(path.join(ROOT, '.env')) || existsSync(path.join(ROOT, '.env.local'));

if (!hasDatabaseUrl && !hasEnvFile) {
  console.log('[db:init] No DATABASE_URL or env file found, skipping schema sync.');
  process.exit(0);
}

const prismaBin = resolvePrismaBin();
if (!existsSync(prismaBin)) {
  console.error('[db:init] Prisma CLI not found. Run npm ci before starting the app.');
  process.exit(1);
}

// ① 数据感知迁移（db push 前置，避免 reset）
runStep(
  '① 数据感知迁移（处理 db push 无法自动完成的变更）...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'db-migrate-data.mjs')]
);

// ② 对齐 schema 最终态
runStep('② 同步 Prisma schema 到数据库（db push）...', prismaBin, [
  'db',
  'push',
  '--skip-generate',
]);

// ③ 历史归属回填（幂等，给 db push 新加的可空列补历史值）
runStep(
  '③ 回填历史对话归属（Conversation.userId）...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'backfill-conversation-user-id.mjs')]
);

// ④ 存量用户邮箱验证豁免（一次性，靠 SiteSetting 标记幂等）
runStep(
  '④ 回填存量用户邮箱验证状态（User.emailVerifiedAt）...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'backfill-email-verified-at.mjs')]
);

console.log('[db:init] Database schema is ready.');
