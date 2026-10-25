import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 托管 CLI 以 root 执行的东西从哪来、谁能改它们：
 *   ① lecture-live update 不再去 /home/*\/lecture-live 里找检出；
 *   ② update / install / rollback / self-install 在以 root 执行检出里的东西之前，要求整条路径与
 *      要执行的目录树都只有 root 能改（first_writable_by_others / require_root_only）；
 *   ③ setup/install/upgrade/rollback 不再把整个 /opt/lecturelive 交给服务用户：$APP_DIR 本身、
 *      .env、backups/ 与（从托管检出运行时）src/ 归 root（deploy/ensure-root-ownership.sh）。
 * 照例从脚本里抠出真实的函数/命令在临时目录里执行。普通用户做不了 chown root，所以：CLI 的检查
 * 本来就认「root 或当前用户」（CLI 总以 root 运行，二者相同），这里由当前用户代替 root；部署脚本
 * 里的 chown 换成只记录参数的桩，chmod 照常真改。
 */

const ROOT = process.cwd();
const CLI = readFileSync(path.join(ROOT, 'deploy/lecture-live'), 'utf8');
const OWNERSHIP_SCRIPT = path.join(ROOT, 'deploy/ensure-root-ownership.sh');
const DEPLOY_SCRIPTS = ['setup.sh', 'install.sh', 'upgrade.sh', 'rollback.sh'] as const;
const IS_ROOT = process.getuid?.() === 0;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(relative: string) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** 临时目录，解析掉 macOS 的 /var → /private/var：CLI 查的、打印的、执行的都是真实路径。 */
function sandbox() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lecturelive-root-only-')));
  tempDirs.push(dir);
  return dir;
}

function write(file: string, contents = '') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** 目录 0755、文件 0644（软链不动）：与 root 在 umask 022 下建出来的一样，不受跑测试的 umask 影响。 */
function normalizeModes(dir: string) {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) normalizeModes(full);
    else chmodSync(full, 0o644);
  }
}

function mode(file: string) {
  return statSync(file).mode & 0o7777;
}

/** 抠出 `name() {` 到其后第一行顶格 `}` 的完整 shell 函数。 */
function extractFunction(script: string, name: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start === -1) throw new Error(`function not found: ${name}`);
  const end = lines.indexOf('}', start);
  if (end === -1) throw new Error(`function not terminated: ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

/** 抠出以 prefix 开头、以反斜杠续行的完整 shell 命令。 */
function extractCommand(script: string, prefix: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(prefix));
  if (start === -1) throw new Error(`command not found: ${prefix}`);
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    out.push(lines[i]);
    if (!lines[i].trimEnd().endsWith('\\')) break;
  }
  return out.join('\n');
}

/** 去掉注释行：注释里提到旧写法不算。 */
function commandsOnly(script: string) {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * 与 sudo 下一致的最小环境：vitest.setup 塞进 process.env 的东西不能漏进来。Next 的类型把
 * NODE_ENV 声明成必填，这里刻意不给，只能双重断言（同 managedUpgrade.test.ts）。
 */
function minimalEnv(pathValue = process.env.PATH ?? '/usr/bin:/bin') {
  return { PATH: pathValue, HOME: process.env.HOME ?? '' } as unknown as NodeJS.ProcessEnv;
}

/** 最小环境 + --norc（--norc 的原因见 managedUpgrade.test.ts）。argv 依次是 $0、$1…… */
function bash(script: string, argv: string[] = [], options: { cwd?: string; path?: string } = {}) {
  return spawnSync('bash', ['--norc', '-euo', 'pipefail', '-c', script, ...argv], {
    cwd: options.cwd,
    env: minimalEnv(options.path),
    encoding: 'utf8',
  });
}

function lines(file: string) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

const CLI_STUBS = [
  'RED= GREEN= YELLOW= BLUE= CYAN= BOLD= DIM= NC=',
  'info() { :; }',
  'step() { :; }',
  'divider() { :; }',
  'warn() { echo "$*" >&2; }',
  'error() { echo "$*" >&2; }',
  'fatal() { error "$*"; exit 1; }',
  'need_root() { :; }',
].join('\n');
const FIRST_WRITABLE = extractFunction(CLI, 'first_writable_by_others');
const OWNERSHIP_CHECK = [FIRST_WRITABLE, extractFunction(CLI, 'require_root_only')].join('\n');

/** 记录 git 调用与所在目录的桩（函数优先于 PATH，( cd … && git … ) 的子 shell 也继承它）。 */
function gitStub(out: string) {
  return `git() { printf 'git %s @ %s\\n' "$*" "$(pwd -P)" >> '${out}'; }`;
}

describe('first_writable_by_others：root 以外的人能不能改这条路径', () => {
  function check(target: string, fn = FIRST_WRITABLE) {
    const result = bash(`${fn}\nfirst_writable_by_others "$1"`, ['check', target]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  /** 一份像样的检出：.git（git 会执行其中的 hooks 与配置）、deploy/、node_modules 里的相对软链。 */
  function checkout(root: string) {
    const src = path.join(root, 'opt/lecturelive/src');
    write(path.join(src, '.git/config'), '[core]\n');
    write(path.join(src, '.git/hooks/post-merge.sample'));
    write(path.join(src, 'deploy/upgrade.sh'), 'echo upgrade\n');
    write(path.join(src, 'node_modules/next/dist/bin/next'));
    mkdirSync(path.join(src, 'node_modules/.bin'));
    symlinkSync('../next/dist/bin/next', path.join(src, 'node_modules/.bin/next'));
    normalizeModes(root);
    return src;
  }

  it('整棵树与每一级上级目录都只有属主能写时什么都不打印（软链自身的 777 不算数）', () => {
    expect(check(checkout(sandbox()))).toBe('');
  });

  it.each([
    ['.git/hooks', 0o775],
    ['.git/config', 0o664],
    ['deploy/upgrade.sh', 0o646],
    ['node_modules/next', 0o777],
  ])('树里任何一项组/其他可写都会被报出：%s', (relative, bits) => {
    const src = checkout(sandbox());
    chmodSync(path.join(src, relative), bits);
    expect(check(src)).toBe(path.join(src, relative));
  });

  it('上级目录可被他人写入时报出它：能写 /opt/lecturelive 就能把整个 src 换掉', () => {
    const root = sandbox();
    const src = checkout(root);
    chmodSync(path.join(root, 'opt/lecturelive'), 0o775);
    expect(check(src)).toBe(path.join(root, 'opt/lecturelive'));
  });

  it('带粘滞位的上级目录（如 /tmp）放行，不带的拒绝', () => {
    const root = sandbox();
    const src = checkout(root);
    const opt = path.join(root, 'opt');
    chmodSync(opt, 0o1777);
    expect(check(src)).toBe('');
    chmodSync(opt, 0o777);
    expect(check(src)).toBe(opt);
  });

  it('检出自己不享受粘滞位例外：别人能往里加文件', () => {
    const src = checkout(sandbox());
    chmodSync(src, 0o1777);
    expect(check(src)).toBe(src);
  });

  it.skipIf(IS_ROOT)('归别人所有同样拒绝（把「当前用户」换成无关的 uid 来模拟）', () => {
    const src = checkout(sandbox());
    expect(FIRST_WRITABLE.match(/-uid "\$EUID"/g)).toHaveLength(2);
    const foreign = FIRST_WRITABLE.replaceAll('-uid "$EUID"', '-uid 123456789');
    expect(check(src, foreign)).not.toBe('');
  });

  it('只接受解析过软链的绝对路径：查的必须就是随后要用的', () => {
    const root = sandbox();
    const src = checkout(root);
    const link = path.join(root, 'src-link');
    symlinkSync(src, link);
    expect(check(link)).toBe(link);
    expect(check('opt/lecturelive/src')).toBe('opt/lecturelive/src');
  });

  it('最后一级尚不存在时只查上级目录（install 克隆之前用）', () => {
    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');
    mkdirSync(appDir, { recursive: true });
    normalizeModes(root);
    expect(check(path.join(appDir, 'src'))).toBe('');
    chmodSync(appDir, 0o775);
    expect(check(path.join(appDir, 'src'))).toBe(appDir);
  });
}, 30_000);

/**
 * update 以 root 在检出里跑 git pull（git 会执行 .git 里的 hooks 与配置），再执行检出里的
 * deploy/upgrade.sh（npm ci、next build……）。旧版在 $SRC_DIR 没有 .git 时会去 /home/*\/lecture-live
 * 里找，任何本地用户都能在家目录放一份；托管检出本身也被 install.sh 的 chown -R 交给了服务用户。
 */
describe('lecture-live update：以 root 执行哪个检出、什么条件下执行', () => {
  const cmdUpdate = extractFunction(CLI, 'cmd_update');

  function layout() {
    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');
    return {
      root,
      appDir,
      srcDir: path.join(appDir, 'src'),
      rootCheckout: path.join(root, 'root/lecture-live'),
      out: path.join(root, 'calls.log'),
    };
  }

  function addCheckout(dir: string, out: string) {
    write(path.join(dir, '.git/config'), '[core]\n');
    write(path.join(dir, 'deploy/upgrade.sh'), `printf 'upgrade.sh %s\\n' "$0" >> '${out}'\n`);
  }

  /** /root/lecture-live 换成临时目录里的位置。 */
  function runUpdate(env: ReturnType<typeof layout>) {
    expect(cmdUpdate).toContain('/root/lecture-live');
    const script = [
      CLI_STUBS,
      gitStub(env.out),
      `APP_DIR='${env.appDir}'`,
      `SRC_DIR='${env.srcDir}'`,
      OWNERSHIP_CHECK,
      cmdUpdate.replaceAll('/root/lecture-live', env.rootCheckout),
      'cmd_update',
    ].join('\n');
    return bash(script);
  }

  it('不再去 /home/* 里找检出（只看命令行，注释里会提到）', () => {
    expect(commandsOnly(cmdUpdate)).not.toContain('/home/');
  });

  it('托管检出只有 root 能改：在它里面 git pull，再执行它的 deploy/upgrade.sh', () => {
    const env = layout();
    addCheckout(env.srcDir, env.out);
    normalizeModes(env.root);

    const result = runUpdate(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(lines(env.out)).toEqual([
      `git pull --ff-only @ ${env.srcDir}`,
      `upgrade.sh ${env.srcDir}/deploy/upgrade.sh`,
    ]);
  });

  it('检出里有服务用户能改的东西（旧版 chown -R 的结果）：拒绝，git 与 upgrade.sh 都不碰', () => {
    const env = layout();
    addCheckout(env.srcDir, env.out);
    normalizeModes(env.root);
    chmodSync(path.join(env.srcDir, '.git/config'), 0o664);

    const result = runUpdate(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('不是只有 root 能改');
    expect(result.stderr).toContain('源码检出与备份的所有权');
    expect(result.stdout).toContain(path.join(env.srcDir, '.git/config'));
    expect(lines(env.out)).toEqual([]);
  });

  it('$APP_DIR 本身可被他人写入时同样拒绝：能把整个 src 换掉', () => {
    const env = layout();
    addCheckout(env.srcDir, env.out);
    normalizeModes(env.root);
    chmodSync(env.appDir, 0o775);

    const result = runUpdate(env);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(env.appDir);
    expect(lines(env.out)).toEqual([]);
  });

  it('托管检出不可信时不会退而去用 /root/lecture-live', () => {
    const env = layout();
    addCheckout(env.srcDir, env.out);
    addCheckout(env.rootCheckout, env.out);
    normalizeModes(env.root);
    chmodSync(path.join(env.srcDir, 'deploy/upgrade.sh'), 0o666);

    const result = runUpdate(env);
    expect(result.status).not.toBe(0);
    expect(lines(env.out)).toEqual([]);
  });

  it('没有托管检出时用 /root/lecture-live，同样要求只有 root 能改', () => {
    const env = layout();
    addCheckout(env.rootCheckout, env.out);
    normalizeModes(env.root);

    const ok = runUpdate(env);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(lines(env.out)).toEqual([
      `git pull --ff-only @ ${env.rootCheckout}`,
      `upgrade.sh ${env.rootCheckout}/deploy/upgrade.sh`,
    ]);

    rmSync(env.out);
    chmodSync(path.join(env.rootCheckout, 'deploy'), 0o777);
    const refused = runUpdate(env);
    expect(refused.status).not.toBe(0);
    expect(lines(env.out)).toEqual([]);
  });

  it('两处都没有检出：报未找到，并指向手工部署的做法', () => {
    const env = layout();
    mkdirSync(env.appDir, { recursive: true });
    normalizeModes(env.root);

    const result = runUpdate(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('未找到源码目录');
    expect(result.stderr).toContain('sudo bash deploy/upgrade.sh');
  });

  it('托管检出是软链时：查的与执行的都是它指向的真实目录', () => {
    const env = layout();
    const real = path.join(env.root, 'srv/lecture-live');
    addCheckout(real, env.out);
    mkdirSync(env.appDir, { recursive: true });
    symlinkSync(real, env.srcDir);
    normalizeModes(env.root);

    const result = runUpdate(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(lines(env.out)).toEqual([
      `git pull --ff-only @ ${real}`,
      `upgrade.sh ${real}/deploy/upgrade.sh`,
    ]);

    // 软链所在的 $APP_DIR 没问题不够：真实目录的上级可被他人写入照样拒绝
    rmSync(env.out);
    chmodSync(path.join(env.root, 'srv'), 0o777);
    const refused = runUpdate(env);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain(path.join(env.root, 'srv'));
    expect(lines(env.out)).toEqual([]);
  });
}, 30_000);

describe('lecture-live install：克隆或拉取之前同样要求只有 root 能改', () => {
  const install = CLI.slice(CLI.indexOf('cmd_install() {'), CLI.indexOf('cmd_uninstall() {'));

  /** 从 mkdir -p "$APP_DIR" 到克隆/拉取分支结束的 fi。 */
  function cloneBlock() {
    const blockLines = install.split('\n');
    const start = blockLines.findIndex((line) => line === '    mkdir -p "$APP_DIR"');
    const end = blockLines.indexOf('    fi', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return blockLines.slice(start, end + 1).join('\n');
  }

  function runBlock(root: string, appDir: string, srcDir: string, out: string) {
    const script = [
      CLI_STUBS,
      gitStub(out),
      `APP_DIR='${appDir}'`,
      `SRC_DIR='${srcDir}'`,
      "REPO_URL='https://example.invalid/lecture-live.git'",
      OWNERSHIP_CHECK,
      cloneBlock(),
      `printf 'SRC_DIR=%s\\n' "$SRC_DIR"`,
    ].join('\n');
    return bash(script, [], { cwd: root });
  }

  it('检查排在 git clone / git pull 之前，二者又都在 npm ci 与任何部署脚本之前', () => {
    const block = cloneBlock();
    const clone = block.indexOf('git clone "$REPO_URL" "$SRC_DIR"');
    const pull = block.indexOf('(cd "$SRC_DIR" && git pull --ff-only)');
    const checks = [...block.matchAll(/require_root_only "\$SRC_DIR"/g)].map((m) => m.index ?? -1);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(clone);
    expect(checks[1]).toBeGreaterThan(clone);
    expect(checks[1]).toBeLessThan(pull);

    const blockEnd = install.indexOf(block) + block.length;
    for (const later of [
      '(cd "$SRC_DIR" && npm ci)',
      'bash "$SRC_DIR/deploy/ensure-security-env.sh"',
      'bash "$SRC_DIR/deploy/install.sh"',
    ]) {
      expect(install.indexOf(later)).toBeGreaterThan(blockEnd);
    }
  });

  it('首次安装：$APP_DIR 只有 root 能改才克隆，克隆到解析软链后的真实路径', () => {
    const root = sandbox();
    const realApp = path.join(root, 'data/lecturelive');
    mkdirSync(realApp, { recursive: true });
    mkdirSync(path.join(root, 'opt'));
    symlinkSync(realApp, path.join(root, 'opt/lecturelive'));
    normalizeModes(root);
    const out = path.join(root, 'calls.log');

    const result = runBlock(root, path.join(root, 'opt/lecturelive'), path.join(root, 'opt/lecturelive/src'), out);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(lines(out)).toEqual([
      `git clone https://example.invalid/lecture-live.git ${realApp}/src @ ${root}`,
    ]);
    expect(result.stdout.trim()).toBe(`SRC_DIR=${realApp}/src`);
  });

  it('首次安装：$APP_DIR 可被他人写入（比如旧版 setup.sh 交给了服务用户）时拒绝克隆', () => {
    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');
    mkdirSync(appDir, { recursive: true });
    normalizeModes(root);
    chmodSync(appDir, 0o775);
    const out = path.join(root, 'calls.log');

    const result = runBlock(root, appDir, path.join(appDir, 'src'), out);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(appDir);
    expect(lines(out)).toEqual([]);
  });

  it('重装：已有检出只有 root 能改才 git pull，有他人可写的条目就拒绝', () => {
    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');
    const srcDir = path.join(appDir, 'src');
    write(path.join(srcDir, '.git/config'), '[core]\n');
    write(path.join(srcDir, 'package.json'), '{}\n');
    normalizeModes(root);
    const out = path.join(root, 'calls.log');

    const ok = runBlock(root, appDir, srcDir, out);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(lines(out)).toEqual([`git pull --ff-only @ ${srcDir}`]);

    rmSync(out);
    chmodSync(path.join(srcDir, 'package.json'), 0o666);
    const refused = runBlock(root, appDir, srcDir, out);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain(path.join(srcDir, 'package.json'));
    expect(lines(out)).toEqual([]);
  });

  it('以 root 用 node --env-file 编译之前，.env 也必须只有 root 能改（node 会应用其中的 NODE_OPTIONS）', () => {
    const check = install
      .split('\n')
      .find((line) => line.trim().startsWith('require_root_only "$(readlink -f "$APP_DIR")/.env"'));
    expect(check).toBeDefined();
    const at = install.indexOf(check!);
    expect(at).toBeLessThan(install.indexOf('bash "$SRC_DIR/deploy/ensure-security-env.sh"'));
    expect(at).toBeLessThan(install.indexOf('node --env-file="$APP_DIR/.env"'));

    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');
    const env = path.join(appDir, '.env');
    write(env, 'NODE_OPTIONS=--require=/opt/lecturelive/data/x.js\n');
    normalizeModes(root);
    const runCheck = () => bash([CLI_STUBS, `APP_DIR='${appDir}'`, OWNERSHIP_CHECK, check!].join('\n'));

    chmodSync(env, 0o640);
    const ok = runCheck();
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);

    chmodSync(env, 0o660);
    const writable = runCheck();
    expect(writable.status).not.toBe(0);
    expect(writable.stdout).toContain(env);

    // 软链（旧布局下服务用户能换）同样拒绝
    rmSync(env);
    write(path.join(root, 'elsewhere.env'));
    symlinkSync(path.join(root, 'elsewhere.env'), env);
    expect(runCheck().status).not.toBe(0);
  });
}, 30_000);

/**
 * 装进 /usr/local/bin 的 CLI 此后每次都以 root 运行。self-install 从已安装的 CLI 运行时找不到
 * 自己的检出，会退到托管检出 $APP_DIR/src 里的那份。
 */
describe('self-install 不会把服务用户能改的 CLI 装成 root 命令', () => {
  const installSelf = extractFunction(CLI, '_install_self');

  function run(appDir: string, target: string) {
    expect(installSelf).toContain('"/usr/local/bin/lecture-live"');
    const script = [
      CLI_STUBS,
      `APP_DIR='${appDir}'`,
      OWNERSHIP_CHECK,
      installSelf.replace('"/usr/local/bin/lecture-live"', `'${target}'`),
      "_install_self ''",
    ].join('\n');
    return bash(script);
  }

  function managedCli(root: string) {
    const appDir = path.join(root, 'opt/lecturelive');
    write(path.join(appDir, 'src/deploy/lecture-live'), '#!/usr/bin/env bash\necho managed\n');
    mkdirSync(path.join(root, 'bin'));
    normalizeModes(root);
    return { appDir, target: path.join(root, 'bin/lecture-live') };
  }

  it('托管检出里的 deploy/ 只有 root 能改：照常安装', () => {
    const { appDir, target } = managedCli(sandbox());
    const result = run(appDir, target);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('echo managed');
  });

  it('托管检出里的 deploy/ 有他人可写的条目：拒绝，不生成目标文件', () => {
    const { appDir, target } = managedCli(sandbox());
    chmodSync(path.join(appDir, 'src/deploy/lecture-live'), 0o664);
    const result = run(appDir, target);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('不是只有 root 能改');
    expect(existsSync(target)).toBe(false);
  });
}, 30_000);

describe('deploy/ensure-root-ownership.sh', () => {
  const USER = userInfo().username;

  function deployment(root: string) {
    const appDir = path.join(root, 'opt/lecturelive');
    write(path.join(appDir, 'server.js'));
    write(path.join(appDir, '.env'), 'JWT_SECRET=x\n');
    write(path.join(appDir, 'data/transcripts/t.json'), '{}');
    write(path.join(appDir, 'backups/app-20261020_100000.tar.gz'));
    write(path.join(appDir, 'backups/systemd-20261020_100000.tar.gz'));
    write(path.join(appDir, 'src/.git/config'), '[core]\n');
    write(path.join(appDir, 'src/deploy/upgrade.sh'));
    normalizeModes(root);
    // 旧版 chown -R 之后服务用户能改它们；普通用户做不了 chown，这里用组/其他可写来模拟
    chmodSync(appDir, 0o777);
    chmodSync(path.join(appDir, '.env'), 0o666);
    chmodSync(path.join(appDir, 'backups'), 0o777);
    chmodSync(path.join(appDir, 'backups/systemd-20261020_100000.tar.gz'), 0o666);
    chmodSync(path.join(appDir, 'src/.git/config'), 0o664);
    return appDir;
  }

  /** chown 换成只记录参数的桩；chmod、mkdir 照常真执行。 */
  function run(root: string, args: string[]) {
    const bin = path.join(root, 'fake-bin');
    const log = path.join(root, 'chown.log');
    write(path.join(bin, 'chown'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(path.join(bin, 'chown'), 0o755);
    const result = spawnSync('bash', ['--norc', OWNERSHIP_SCRIPT, ...args], {
      env: minimalEnv(`${bin}:${process.env.PATH}`),
      encoding: 'utf8',
    });
    const chowns = lines(log);
    rmSync(log, { force: true });
    return { result, chowns };
  }

  function runOk(root: string, args: string[]) {
    const { result, chowns } = run(root, args);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return chowns;
  }

  it('$APP_DIR 归 root:<服务用户>、去掉组/其他写；.env 归 root:<服务用户> 0640；backups/ 整个归 root', () => {
    const root = sandbox();
    const appDir = deployment(root);

    const chowns = runOk(root, [appDir, USER]);
    // .env 先写成新文件、收好属主与权限，再原子地换上去
    expect(chowns).toEqual([
      `root:${USER} ${appDir}`,
      `root:${USER} ${appDir}/.env.new`,
      `-R root:root ${appDir}/backups`,
    ]);
    expect(mode(appDir)).toBe(0o755);
    expect(mode(path.join(appDir, '.env'))).toBe(0o640);
    expect(readFileSync(path.join(appDir, '.env'), 'utf8')).toBe('JWT_SECRET=x\n');
    expect(existsSync(path.join(appDir, '.env.new'))).toBe(false);
    expect(mode(path.join(appDir, 'backups'))).toBe(0o755);
    expect(mode(path.join(appDir, 'backups/systemd-20261020_100000.tar.gz'))).toBe(0o644);
  });

  it('.env 换成新的 inode：服务用户事先留着的可写描述符写不进新文件', () => {
    const root = sandbox();
    const appDir = deployment(root);
    const env = path.join(appDir, '.env');
    const before = statSync(env).ino;
    // 旧布局下 .env 归服务用户，它可以先打开、留着描述符，等 root 改完属主再写 NODE_OPTIONS
    const retained = openSync(env, 'r+');
    try {
      runOk(root, [appDir, USER]);
      writeSync(retained, 'NODE_OPTIONS=--require=/opt/lecturelive/data/x.js\n');
    } finally {
      closeSync(retained);
    }
    expect(statSync(env).ino).not.toBe(before);
    expect(readFileSync(env, 'utf8')).toBe('JWT_SECRET=x\n');
    expect(mode(env)).toBe(0o640);
  });

  it('残留的 .env.new 是软链（旧布局下服务用户能放）时不会写穿到它指向的文件', () => {
    const root = sandbox();
    const appDir = deployment(root);
    const target = path.join(root, 'elsewhere/cron-job');
    write(target, 'original\n');
    symlinkSync(target, path.join(appDir, '.env.new'));

    runOk(root, [appDir, USER]);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(readFileSync(path.join(appDir, '.env'), 'utf8')).toBe('JWT_SECRET=x\n');
  });

  it('$APP_DIR 原本对其他人关闭时保持关闭，但服务用户的组仍能进入', () => {
    const root = sandbox();
    const appDir = deployment(root);
    chmodSync(appDir, 0o700);

    runOk(root, [appDir, USER]);
    expect(mode(appDir)).toBe(0o750);
  });

  it('不传调用方的检出（setup/rollback）、或调用方是别处的检出时，不碰 src/', () => {
    const root = sandbox();
    const appDir = deployment(root);
    const elsewhere = path.join(root, 'home/ops/lecture-live');
    mkdirSync(elsewhere, { recursive: true });

    for (const args of [[appDir, USER], [appDir, USER, elsewhere]]) {
      const chowns = runOk(root, args);
      expect(chowns.some((line) => line.includes(`${appDir}/src`))).toBe(false);
      expect(mode(path.join(appDir, 'src/.git/config'))).toBe(0o664);
    }
  });

  it('从托管检出运行时（install/upgrade 传入自己的 $SRC_DIR）把它整个收归 root', () => {
    const root = sandbox();
    const appDir = deployment(root);

    // upgrade.sh 的 SRC_DIR 来自 pwd（不解析软链），可能经软链指向托管检出：按真实路径比较
    const viaLink = path.join(root, 'src-link');
    symlinkSync(path.join(appDir, 'src'), viaLink);
    const chowns = runOk(root, [appDir, USER, viaLink]);
    expect(chowns).toContain(`-R root:root ${appDir}/src`);
    expect(mode(path.join(appDir, 'src/.git/config'))).toBe(0o644);
  });

  it('$APP_DIR/src 本身是软链时不收归：不以 root 跟着它去改别处的属主', () => {
    const root = sandbox();
    const appDir = deployment(root);
    const real = path.join(root, 'srv/lecture-live');
    write(path.join(real, 'deploy/upgrade.sh'));
    normalizeModes(path.join(root, 'srv'));
    chmodSync(path.join(real, 'deploy/upgrade.sh'), 0o664);
    rmSync(path.join(appDir, 'src'), { recursive: true });
    symlinkSync(real, path.join(appDir, 'src'));

    const chowns = runOk(root, [appDir, USER, real]);
    expect(chowns.some((line) => line.includes(real) || line.includes(`${appDir}/src`))).toBe(false);
    expect(mode(path.join(real, 'deploy/upgrade.sh'))).toBe(0o664);
  });

  it.each(['.env', 'backups'])(
    '%s 是软链时拒绝，且不跟着它 chown/chmod（否则能让 root 改任意文件的属主与权限）',
    (entry) => {
      const root = sandbox();
      const appDir = deployment(root);
      // 比如指向 /etc/shadow 或 /usr/bin
      const target = path.join(root, 'elsewhere', entry === '.env' ? 'shadow' : 'bin');
      if (entry === '.env') write(target, 'root:x:0:0\n');
      else write(path.join(target, 'sudo'));
      normalizeModes(path.join(root, 'elsewhere'));
      const targetFile = entry === '.env' ? target : path.join(target, 'sudo');
      chmodSync(targetFile, 0o600);
      rmSync(path.join(appDir, entry), { recursive: true });
      symlinkSync(target, path.join(appDir, entry));

      const { result, chowns } = run(root, [appDir, USER]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${appDir}/${entry} 是软链`);
      // 先收紧 $APP_DIR 本身（之后没人能再调包），然后就停下
      expect(chowns).toEqual([`root:${USER} ${appDir}`]);
      expect(mode(targetFile)).toBe(0o600);
    }
  );

  it('.env 还有别的硬链接时拒绝：照着它复制，会把另一处文件的内容变成服务用户可读', () => {
    const root = sandbox();
    const appDir = deployment(root);
    const other = path.join(root, 'elsewhere/env-copy');
    mkdirSync(path.dirname(other), { recursive: true });
    linkSync(path.join(appDir, '.env'), other);

    const { result, chowns } = run(root, [appDir, USER]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('硬链接');
    expect(chowns).toEqual([`root:${USER} ${appDir}`]);
    expect(mode(other)).toBe(0o666);
  });

  it('$APP_DIR 尚不存在时先建出来（install.sh 在首次安装时最早调用它）', () => {
    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');

    const chowns = runOk(root, [appDir, USER]);
    expect(statSync(appDir).isDirectory()).toBe(true);
    expect(chowns).toEqual([`root:${USER} ${appDir}`]);
  });

  it('缺参数时报用法并失败', () => {
    const result = spawnSync('bash', ['--norc', OWNERSHIP_SCRIPT], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('用法');
  });
}, 30_000);

describe('setup/install/upgrade/rollback 不再把整个 $APP_DIR 交给服务用户', () => {
  const HANDOFF = 'find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name src ! -name backups ! -name .env';
  const PROTECT = 'bash "$SCRIPT_DIR/ensure-root-ownership.sh" "$APP_DIR" "$APP_USER"';

  it.each(DEPLOY_SCRIPTS)('%s：没有对 $APP_DIR 的 chown -R；交接之后再收紧一次', (name) => {
    const script = read(`deploy/${name}`);
    const commands = commandsOnly(script);
    expect(commands).not.toMatch(/chown -R [^\n]*"\$APP_DIR"\s*$/m);
    // .env 的属主与权限只由 ensure-root-ownership.sh 设（root:服务用户 0640），脚本不再自己 chmod 600
    expect(commands).not.toMatch(/chmod [0-7]+ "\$APP_DIR\/\.env"/);
    expect(script).toContain('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"');
    const handoff = script.indexOf(HANDOFF);
    expect(handoff).toBeGreaterThan(0);
    expect(script.indexOf(`${PROTECT}\n`, handoff)).toBeGreaterThan(handoff);
  });

  it.each(DEPLOY_SCRIPTS)('%s：交接命令只把 src/、backups/ 与 .env 以外的顶层条目交给服务用户', (name) => {
    const command = extractCommand(read(`deploy/${name}`), HANDOFF);
    const root = sandbox();
    const appDir = path.join(root, 'opt/lecturelive');
    for (const entry of ['server.js', '.env', '.next/BUILD_ID', 'data/t.json', 'ws-server/websocket.js']) {
      write(path.join(appDir, entry));
    }
    for (const entry of ['src/deploy/upgrade.sh', 'backups/app-1.tar.gz']) {
      write(path.join(appDir, entry));
    }
    const bin = path.join(root, 'fake-bin');
    const log = path.join(root, 'chown.log');
    write(path.join(bin, 'chown'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(path.join(bin, 'chown'), 0o755);

    const result = bash(`APP_DIR='${appDir}'\nAPP_USER=svc\n${command}`, [], {
      path: `${bin}:${process.env.PATH}`,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const handedOff = lines(log)
      .flatMap((line) => {
        expect(line.startsWith('-R svc:svc ')).toBe(true);
        return line.slice('-R svc:svc '.length).split(' ');
      })
      .sort();
    expect(handedOff).toEqual(
      ['.next', 'data', 'server.js', 'ws-server'].map((entry) => path.join(appDir, entry))
    );
  });

  it.each(['install.sh', 'upgrade.sh'])(
    '%s：任何可能失败的步骤之前就收回（含自己所在的托管检出），cp -a 之后、启动之前再收紧',
    (name) => {
      const script = read(`deploy/${name}`);
      const early = script.indexOf(`${PROTECT} "$SRC_DIR"\n`);
      expect(early).toBeGreaterThan(0);
      for (const later of [
        'ensure-security-env.sh',
        'systemctl stop lecturelive-web',
        // 第一处以 root 运行、会应用 .env 里 NODE_OPTIONS 的 node
        'node --env-file="$APP_DIR/.env"',
        'scripts/ensure-database.mjs --require-database',
      ]) {
        expect(script.indexOf(later)).toBeGreaterThan(early);
      }
      // cp -a 会把 standalone 目录的属主与权限带到 $APP_DIR 本身上
      const copy = script.indexOf('cp -a "$SRC_DIR/.next/standalone/." "$APP_DIR/"');
      const late = script.indexOf(`${PROTECT}\n`, copy);
      expect(copy).toBeGreaterThan(early);
      expect(late).toBeGreaterThan(copy);
      expect(late).toBeLessThan(script.indexOf('systemctl start lecturelive-web lecturelive-ws'));
    }
  );

  it('upgrade.sh：早于 npm ci；install.sh：早于产物检查', () => {
    const upgrade = read('deploy/upgrade.sh');
    expect(upgrade.indexOf(`${PROTECT} "$SRC_DIR"`)).toBeLessThan(upgrade.indexOf('\nnpm ci\n'));
    const install = read('deploy/install.sh');
    expect(install.indexOf(`${PROTECT} "$SRC_DIR"`)).toBeLessThan(
      install.indexOf('[[ -d "$SRC_DIR/.next/standalone" ]]')
    );
  });

  it('rollback.sh：解包之后、启动之前收紧；setup.sh：建好目录之后', () => {
    const rollback = read('deploy/rollback.sh');
    const restore = rollback.indexOf('tar xzf "$BACKUP_FILE"');
    const protect = rollback.indexOf(`${PROTECT}\n`);
    expect(protect).toBeGreaterThan(restore);
    expect(protect).toBeLessThan(rollback.indexOf('systemctl start lecturelive-web lecturelive-ws'));

    const setup = read('deploy/setup.sh');
    expect(setup.indexOf(`${PROTECT}\n`)).toBeGreaterThan(
      setup.indexOf('mkdir -p "$APP_DIR" "$WS_DIR" "$APP_DIR/data" "$APP_DIR/backups"')
    );
  });
}, 30_000);
