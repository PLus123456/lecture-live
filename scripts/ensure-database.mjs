// 数据库就绪编排器 —— 应用启动 / 升级时把库结构与历史数据一次性对齐。
//
// 调用方：package.json 的 prestart / prestart:ws / db:ensure、docker-entrypoint.sh、deploy/upgrade.sh。
//
// 三步顺序（每步都幂等、可重复执行）：
//   ① 数据感知迁移（scripts/db-migrate-data.mjs）：处理 `db push` 无法自动完成、否则会要求
//      reset 整库的变更（如给有数据的表加必填自增列 seq），先把结构铺到「db push 看了无需破坏」。
//   ② prisma db push：把 schema 最终态对齐到库（加可空列 / 索引 / 改默认值等安全变更）。
//   ③ post-push 数据/约束（db-migrate-data --security-only）：在最终表已存在后，幂等安装
//      db push 无法表达的 CHECK，并完成依赖新列的支付 fulfillment 历史回填。
//   ④ 生产支付预检：生产部署读取数据库现值，拒绝 Stripe test/未知 key 后再启动服务。
//   ⑤ 历史归属回填（scripts/backfill-conversation-user-id.mjs）：给 db push 新加的可空列
//      （Conversation.userId）回填历史值，避免老对话变「无主」→ 404。
//   ⑥ 存量用户邮箱验证豁免（scripts/backfill-email-verified-at.mjs）：同理给 User.emailVerifiedAt
//      回填 createdAt，避免管理员开启 email_verification 时把全部老用户锁死在登录门外。
//      一次性（SiteSetting 标记），跑过不再执行。
//   ⑦ 统一 artifact 账本回填：在对话归属可用后逐个测量存量实际字节，完成后才发布
//      marker 并重建计数。
//
// 默认受 AUTO_DB_PUSH 控制：设为 0/false/off 时开发/手工入口可跳过。正式部署传入
// --require-database 后，关闭自动同步或缺少 DATABASE_URL 都会非零退出。
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
// 生产部署入口显式使用该 flag：数据库配置缺失或关闭自动同步时必须非零退出，
// 不能把“开发环境可跳过”的兼容语义带进正式服务启动路径。
const REQUIRE_DATABASE = process.argv.includes('--require-database');

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
  if (REQUIRE_DATABASE) {
    console.error(
      '[db:init] AUTO_DB_PUSH cannot be disabled when --require-database is active.'
    );
    process.exit(1);
  }
  console.log('[db:init] AUTO_DB_PUSH disabled, skipping schema sync.');
  process.exit(0);
}

loadEnvFileIfNeeded(ROOT);

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());
const hasEnvFile =
  existsSync(path.join(ROOT, '.env')) || existsSync(path.join(ROOT, '.env.local'));

if (!hasDatabaseUrl && REQUIRE_DATABASE) {
  console.error('[db:init] DATABASE_URL is required for this deployment path.');
  process.exit(1);
}

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

// ③ db push 后的数据回填与安全 CHECK（全新库须等表/列创建后再跑）
runStep(
  '③ 完成 post-push 数据回填并安装数据库安全约束...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'db-migrate-data.mjs'), '--security-only']
);

// ④ 生产启动预检。只有显式生产部署 flag（或 NODE_ENV=production）触发；npm run build/dev
// 均不执行 ensure-database，因而不会在构建阶段连接数据库。
if (REQUIRE_DATABASE || process.env.NODE_ENV === 'production') {
  const paymentPreflightArgs = [
    path.join(SCRIPT_DIR, 'check-production-payment-config.mjs'),
  ];
  // Docker/explicit maintenance invocations may need the ADMIN review API while the history
  // marker remains pending. Middleware still blocks every other API; normal starts omit this.
  if (process.env.PAYMENT_RECONCILIATION_MAINTENANCE?.trim() === '1') {
    paymentPreflightArgs.push('--allow-reconciliation-maintenance');
  }
  runStep(
    '④ 校验生产支付配置（Stripe live mode）...',
    process.execPath,
    paymentPreflightArgs
  );
}

// ⑤ 历史归属回填（幂等，给 db push 新加的可空列补历史值）
runStep(
  '⑤ 回填历史对话归属（Conversation.userId）...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'backfill-conversation-user-id.mjs')]
);

// ⑥ 存量用户邮箱验证豁免（一次性，靠 SiteSetting 标记幂等）
runStep(
  '⑥ 回填存量用户邮箱验证状态（User.emailVerifiedAt）...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'backfill-email-verified-at.mjs')]
);

// ⑦ 完整 artifact 账本回填。远端对象无法取得权威字节时脚本非零退出；marker
// 不会发布，运行时 reconcile 也继续 fail-closed，绝不能把录音计费清零。
runStep(
  '⑦ 回填统一 artifact 字节账本...',
  process.execPath,
  [path.join(SCRIPT_DIR, 'backfill-stored-artifacts.mjs')]
);

console.log('[db:init] Database schema is ready.');
