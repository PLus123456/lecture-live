// 共享环境加载器 —— 把 .env.local / .env 载入 process.env。
//
// 为什么需要：Prisma CLI 原生只读 `.env`（及 prisma/.env），从不读 Next.js 约定的 `.env.local`。
// 本项目真实连接串（DATABASE_URL）放在 .env.local；主仓库靠 `.env -> .env.local` 软链兜底，
// 但该软链未提交（.gitignore），worktree / 全新克隆 / CI / 部署源码目录里都没有它，
// Prisma 于是解析不到 schema.prisma 的 env("DATABASE_URL")。本模块统一补上这一步。
//
// 语义：若 DATABASE_URL 已由环境注入（Docker environment / systemd / node --env-file），则不加载、不覆盖；
//      否则按 Next.js 优先级 .env.local → .env 依次尝试，一旦拿到 DATABASE_URL 即停。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

const ENV_FILE_NAMES = ['.env.local', '.env'];

/**
 * 按与 loadEnvFileIfNeeded 相同的优先级（.env.local → .env）读取单个键，不改动 process.env。
 * 给「开关类」变量用：loadEnvFileIfNeeded 在 DATABASE_URL 已由环境注入时整段不加载，
 * 只写在 env 文件里的开关（如 AUTO_DB_PUSH）就会被忽略。
 * @param {string} name 变量名
 * @param {string} [root] 项目根目录，默认 process.cwd()
 * @returns {string | undefined}
 */
export function readEnvFileValue(name, root = process.cwd()) {
  for (const fileName of ENV_FILE_NAMES) {
    const file = path.join(root, fileName);
    if (!existsSync(file)) continue;
    try {
      const value = parseEnv(readFileSync(file, 'utf8'))[name];
      if (value !== undefined) return value;
    } catch {
      /* 解析失败按「未配置」处理，与 loadEnvFileIfNeeded 一致 */
    }
  }
  return undefined;
}

/**
 * 载入 .env.local / .env 到 process.env（幂等；已注入 DATABASE_URL 时直接返回）。
 * @param {string} [root] 项目根目录，默认 process.cwd()
 */
export function loadEnvFileIfNeeded(root = process.cwd()) {
  if (process.env.DATABASE_URL?.trim()) return;
  // .env.local 优先（Next.js 约定：*.local 覆盖同名基文件，且本项目真实配置就在这里），再退回 .env。
  for (const name of ENV_FILE_NAMES) {
    const file = path.join(root, name);
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        /* 解析失败忽略，交由调用方的 DATABASE_URL 缺失检查兜底 */
      }
      if (process.env.DATABASE_URL?.trim()) return;
    }
  }
}
