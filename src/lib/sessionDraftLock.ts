import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const heldLocks = new AsyncLocalStorage<Map<string, { active: boolean }>>();
const LOCK_WAIT_MS = 15_000;

interface LockOwner {
  host: string;
  pid: number;
  token: string;
  bootId?: string;
  startTicks?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

async function readOwner(file: string): Promise<LockOwner | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as LockOwner;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function processStartTicks(pid: number): Promise<string> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  // comm 字段可带空格和括号，最后一个右括号之后才是第三字段；starttime 是第二十二字段。
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

async function processIdentity(): Promise<Pick<LockOwner, 'bootId' | 'startTicks'>> {
  if (process.platform !== 'linux') return {};
  try {
    return {
      bootId: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      startTicks: await processStartTicks(process.pid),
    };
  } catch {
    // 限制 /proc 的部署回退到 PID 判活；无法证实死亡时保持锁和草稿，不贸然抢占。
    return {};
  }
}

async function ownerExited(owner: LockOwner, currentOwner: LockOwner): Promise<boolean> {
  // 只接管本机已经退出的进程；慢磁盘、长暂停或另一台机器的持锁者都不能按超时抢锁。
  if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  if (owner.bootId && currentOwner.bootId && owner.bootId !== currentOwner.bootId) return true;
  try {
    process.kill(owner.pid, 0);
    // Linux 重启服务后 PID 可能被复用，不能误把旧锁当成另一个活进程持有的锁。
    return Boolean(owner.startTicks && owner.startTicks !== await processStartTicks(owner.pid));
  } catch (error) {
    return errorCode(error) === 'ESRCH' || errorCode(error) === 'ENOENT';
  }
}

async function reclaimExitedOwner(lockPath: string, candidate: string, currentOwner: LockOwner): Promise<void> {
  const owner = await readOwner(lockPath);
  if (!owner || !(await ownerExited(owner, currentOwner))) return;
  // 回收者也必须互斥，否则两个回收者可能先后 unlink，把刚接管的新锁误删。
  const reapPath = `${lockPath}.reap`;
  try {
    await fs.link(candidate, reapPath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      // 回收者自身也可能崩溃；它的锁同样保存完整 owner，可继续回收，避免永久卡住。
      await reclaimExitedOwner(reapPath, candidate, currentOwner);
      return;
    }
    throw error;
  }
  try {
    const current = await readOwner(lockPath);
    if (current?.token === owner.token && await ownerExited(current, currentOwner)) {
      await fs.unlink(lockPath);
    }
  } finally {
    await fs.rm(reapPath, { force: true });
  }
}

/**
 * 音频、转录、seal 和清扫共用的短临界区。Web 与 WS 是不同进程，内存 Map 不能阻止
 * 后台收尾与 HTTP 写草稿交叉执行。锁与草稿放在同一共享文件系统，硬链接原子发布完整
 * owner 信息；不按租约超时抢活锁。耗时的媒体解码、云上传不能放进此锁。
 */
export async function withSessionDraftLock<T>(
  sessionId: string,
  task: () => Promise<T>
): Promise<T> {
  const key = path.join(
    process.cwd(), 'data', 'draft-locks',
    crypto.createHash('sha256').update(sessionId).digest('hex')
  );
  if (heldLocks.getStore()?.get(key)?.active) return task();

  await fs.mkdir(path.dirname(key), { recursive: true });
  const owner: LockOwner = {
    host: os.hostname(), pid: process.pid, token: crypto.randomUUID(),
    ...await processIdentity(),
  };
  const candidate = `${key}.${owner.token}.tmp`;
  await fs.writeFile(candidate, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  let acquired = false;
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!acquired) {
      try {
        await fs.link(candidate, key);
        acquired = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        await reclaimExitedOwner(key, candidate, owner);
        if (Date.now() >= deadline) throw new Error('Session draft is busy; retry saving');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const entry = { active: true };
    const context = new Map(heldLocks.getStore());
    context.set(key, entry);
    try {
      return await heldLocks.run(context, task);
    } finally {
      entry.active = false;
    }
  } finally {
    if (acquired) await fs.unlink(key);
    await fs.rm(candidate, { force: true });
  }
}
