import 'server-only';

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
  const tmp = path.join(dir, 'source.pdf.tmp');
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path.join(dir, 'source.pdf'));
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
  const tmp = path.join(dir, `${variant}.pdf.tmp`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path.join(dir, `${variant}.pdf`));
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
