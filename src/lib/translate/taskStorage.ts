import 'server-only';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 文档翻译任务的本地文件存储（data/translations/{taskId}/…）。
 *
 * 刻意不入 Cloudreve：翻译产物生命周期独立（用户下载后可删、删任务级联清目录）、
 * 单文件 ≤30MB 本地盘足够，且不与 chat 附件的 Cloudreve 字节配额纠缠。
 * 布局：source.pdf（原文）/ mono.pdf（译文单语）/ dual.pdf（双语对照）。
 * task 行的 sourcePath/monoPath/dualPath 存相对 data/ 的路径（自解释、可迁移）。
 */

const TRANSLATIONS_ROOT = path.join(process.cwd(), 'data', 'translations');

/** 防路径拼接逃逸：taskId 只允许 cuid 形态字符 */
function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    throw new Error(`非法 taskId: ${taskId}`);
  }
}

function taskDir(taskId: string): string {
  assertSafeTaskId(taskId);
  return path.join(TRANSLATIONS_ROOT, taskId);
}

export type OutputVariant = 'mono' | 'dual';

/**
 * L29：临时文件名必须每次唯一。
 *
 * 原来固定叫 `source.pdf.tmp` / `mono.pdf.tmp`：同一个 taskId 只要有两个写入者并存
 *（跨代重派、双进程 tick 同时收割、用户重传撞上在途收割），两条 writeFile 会交错写同一个
 * tmp 句柄，随后各自 rename —— 落地的是一个「前半段来自 A、后半段来自 B」的撕裂 PDF，
 * 而 rename 的原子性只保证「读者看到的要么是旧文件要么是新文件」，挡不住 tmp 自身被写花。
 * 加 pid + 随机后缀后，每个写入者独占自己的 tmp，rename 谁最后谁赢（内容都是完整的）。
 */
function tmpPathFor(dir: string, fileName: string): string {
  return path.join(
    dir,
    `${fileName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
}

/** 写 tmp → rename 的原子落盘；写坏时不留半截 tmp（rm -rf 兜底之外的即时清理）。 */
async function writeFileAtomic(dir: string, fileName: string, data: Buffer): Promise<void> {
  const tmp = tmpPathFor(dir, fileName);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path.join(dir, fileName));
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** task 行里存的相对引用（相对 data/） */
export function sourceReference(taskId: string): string {
  return `translations/${taskId}/source.pdf`;
}

export function outputReference(taskId: string, variant: OutputVariant): string {
  return `translations/${taskId}/${variant}.pdf`;
}

export async function saveSourceFile(taskId: string, data: Buffer): Promise<string> {
  const dir = taskDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  // tmp+rename 原子落盘（与 manifest 持久化同惯例，防写一半的撕裂文件被后续读走）
  await writeFileAtomic(dir, 'source.pdf', data);
  return sourceReference(taskId);
}

export async function readSourceFile(taskId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(taskDir(taskId), 'source.pdf'));
  } catch {
    return null;
  }
}

export async function saveOutputFile(
  taskId: string,
  variant: OutputVariant,
  data: Buffer
): Promise<string> {
  const dir = taskDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(dir, `${variant}.pdf`, data);
  return outputReference(taskId, variant);
}

export async function readOutputFile(
  taskId: string,
  variant: OutputVariant
): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(taskDir(taskId), `${variant}.pdf`));
  } catch {
    return null;
  }
}

/** 删任务级联清理整个任务目录（幂等） */
export async function deleteTaskFiles(taskId: string): Promise<void> {
  await fs.rm(taskDir(taskId), { recursive: true, force: true });
}
