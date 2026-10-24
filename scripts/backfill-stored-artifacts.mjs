// Build the TypeScript backfill into an isolated temporary executable. This keeps
// the db-push path independent of a prebuilt Next bundle while still reusing the
// exact production Cloudreve validation/authentication implementation.
//
// 产物必须落在**项目内**（这里是 node_modules 下的临时目录），不能放 os.tmpdir()：
// `@prisma/client` 是 --external 的，运行时仍是裸说明符，而 ESM 的裸说明符解析是从
// **导入文件所在目录**逐级向上找 node_modules 的，与 cwd 无关。放 /tmp 时 Node 从 /tmp
// 一路向上都找不到 node_modules → ERR_MODULE_NOT_FOUND，回填必挂；而回填是 ensure-database
// 的第 ⑦ 步，upgrade.sh 又是 `set -e` 且此前已 systemctl stop —— 一挂就是「服务停着、
// 升级中止」。放进 node_modules 后向上第一跳就是项目自己的 node_modules。
//
// 三种运行方式：
//   ① 有源码（裸机 upgrade/install 的源码目录、开发、CI）：现编 scripts/backfill-stored-artifacts.ts
//      并执行 —— 与此前完全一致。
//   ② Docker runner 镜像：Next standalone 不带 src/ 与 tsconfig.json，现编必挂
//      （Could not resolve "../src/lib/prisma" → 第 ⑦ 步 exit 1 → entrypoint 的 set -e
//      在 Web/WS 启动前打死容器，每次启动都失败）。builder 阶段用 `--build-only` 以同一套
//      参数预编译到 dist/backfill-stored-artifacts.mjs，镜像里直接执行它。
//   ③ `--build-only <outfile>`：只编译不执行（Dockerfile builder 阶段使用）。
// 有源码时**永远优先现编**：预编译产物可能是旧代码，绝不能盖过当前源码。
import { existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadEnvFileIfNeeded } from './load-env.mjs';

const root = process.cwd();

/** Docker builder 阶段预编译产物的位置（相对项目根）；Dockerfile 的 COPY 与此一致。 */
const PREBUILT_BACKFILL = path.join(root, 'dist', 'backfill-stored-artifacts.mjs');
/** 判定「源码在场」的哨兵：回填的真正实现。 */
const SOURCE_SENTINEL = path.join(root, 'src', 'lib', 'storage', 'storedArtifactBackfill.ts');

function resolveEsbuild() {
  return path.join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
  );
}

/** spawnSync 结果 → 退出码。被信号杀掉（status === null）一律视为失败，绝不当成功。 */
function exitCodeOf(result) {
  if (result.error) return 1;
  if (result.status === 0 && !result.signal) return 0;
  return result.status || 1;
}

function failureDetail(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `killed by ${result.signal}`;
  return `exit ${result.status}`;
}

function build(esbuild, outfile) {
  const result = spawnSync(
    esbuild,
    [
      path.join(root, 'scripts', 'backfill-stored-artifacts.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node24',
      `--outfile=${outfile}`,
      '--external:@prisma/client',
      // 打成 ESM 时 esbuild 会给 CJS 依赖塞一个会抛错的 __require 垫片；pino 之类
      // 在模块求值阶段 `require('node:os')` 的包会当场炸。补一个真的 require。
      '--banner:js=import { createRequire as __nodeCreateRequire } from "node:module"; const require = __nodeCreateRequire(import.meta.url);',
      `--alias:server-only=${path.join(root, 'deploy', 'shims', 'server-only.js')}`,
    ],
    { cwd: root, env: process.env, stdio: 'inherit' }
  );
  const code = exitCodeOf(result);
  if (code !== 0) {
    console.error('[backfill-stored-artifacts] build failed:', failureDetail(result));
  }
  return code;
}

function execute(bundle) {
  const result = spawnSync(process.execPath, [bundle], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  const code = exitCodeOf(result);
  if (code !== 0) {
    console.error('[backfill-stored-artifacts] execution failed:', failureDetail(result));
  }
  return code;
}

function main(argv) {
  const buildOnlyIndex = argv.indexOf('--build-only');
  if (buildOnlyIndex !== -1) {
    const outfile = argv[buildOnlyIndex + 1];
    if (!outfile) {
      console.error('[backfill-stored-artifacts] usage: --build-only <outfile>');
      return 1;
    }
    const esbuild = resolveEsbuild();
    if (!existsSync(esbuild)) {
      console.error('[backfill-stored-artifacts] esbuild is required to prebuild the backfill');
      return 1;
    }
    return build(esbuild, path.resolve(root, outfile));
  }

  loadEnvFileIfNeeded(root);

  if (!existsSync(SOURCE_SENTINEL)) {
    if (existsSync(PREBUILT_BACKFILL)) {
      return execute(PREBUILT_BACKFILL);
    }
    console.error(
      '[backfill-stored-artifacts] neither the TypeScript sources nor the prebuilt ' +
        `${path.relative(root, PREBUILT_BACKFILL)} are available`
    );
    return 1;
  }

  const esbuild = resolveEsbuild();
  if (!existsSync(esbuild)) {
    console.error('[backfill-stored-artifacts] esbuild is required for the database backfill');
    return 1;
  }

  const temp = mkdtempSync(
    path.join(root, 'node_modules', '.lecture-live-artifact-backfill-')
  );
  try {
    const output = path.join(temp, 'backfill.mjs');
    const buildCode = build(esbuild, output);
    if (buildCode !== 0) return buildCode;
    return execute(output);
  } finally {
    // 此前在 try 里直接 process.exit，finally 根本不会执行，失败时临时目录残留在 node_modules。
    rmSync(temp, { recursive: true, force: true });
  }
}

process.exitCode = main(process.argv.slice(2));
