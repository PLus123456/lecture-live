import 'server-only';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 文档翻译任务的本地文件存储（data/translations/{taskId}/…）。
 *
 * 刻意不入 Cloudreve：翻译产物生命周期独立（用户下载后可删、删任务级联清目录）、
 * 单文件 ≤30MB 本地盘足够，且不与 chat 附件的 Cloudreve 字节配额纠缠。
 * 布局：source.pdf（原文）/ outputs/{attempt}/mono.pdf|dual.pdf（译文）。
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

function assertSafeOutputGeneration(generation: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(generation)) {
    throw new Error('非法翻译输出代次');
  }
}

function outputGenerationDir(taskId: string, generation: string): string {
  assertSafeOutputGeneration(generation);
  return path.join(taskDir(taskId), 'outputs', generation);
}

/** task 行里存的相对引用（相对 data/） */
export function sourceReference(taskId: string): string {
  return `translations/${taskId}/source.pdf`;
}

export function outputReference(
  taskId: string,
  variant: OutputVariant,
  generation?: string
): string {
  assertSafeTaskId(taskId);
  if (!generation) return `translations/${taskId}/${variant}.pdf`;
  assertSafeOutputGeneration(generation);
  return `translations/${taskId}/outputs/${generation}/${variant}.pdf`;
}

/**
 * L29：临时文件名必须每次唯一。
 *
 * 原来固定叫 `source.pdf.tmp`：同一个 taskId 只要有两个写入者并存（跨代重派、双进程 tick
 * 同时收割、用户重传撞上在途收割），两条 writeFile 会交错写同一个 tmp 句柄，随后各自
 * rename —— 落地的是一个「前半段来自 A、后半段来自 B」的撕裂 PDF；rename 的原子性只保证
 * 「读者看到的要么是旧文件要么是新文件」，挡不住 tmp 自身被写花。
 * 加 pid + 随机后缀后，每个写入者独占自己的 tmp，rename 谁最后谁赢（内容都是完整的）。
 */
function tmpPathFor(dir: string, fileName: string): string {
  return path.join(
    dir,
    `${fileName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
}

/** 写 tmp → rename 的原子落盘；写坏时不留半截 tmp。 */
async function writeFileAtomic(
  dir: string,
  fileName: string,
  data: Buffer
): Promise<void> {
  const tmp = tmpPathFor(dir, fileName);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path.join(dir, fileName));
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
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
  data: Buffer,
  generation?: string
): Promise<string> {
  const dir = generation
    ? outputGenerationDir(taskId, generation)
    : taskDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  // 调用方为每次 harvest 分配唯一 attempt；临时文件仍保持唯一，避免同一
  // attempt 内异常重入时互相 rename。
  const tmp = path.join(
    dir,
    `.${variant}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  // L29：写坏时立刻清掉半截 tmp（rm -rf 兜底之外的即时清理）。
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path.join(dir, `${variant}.pdf`));
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return outputReference(taskId, variant, generation);
}

export async function readOutputFile(
  taskId: string,
  variant: OutputVariant,
  reference?: string | null
): Promise<Buffer | null> {
  assertSafeTaskId(taskId);
  let filePath: string;
  const legacyReference = outputReference(taskId, variant);
  if (!reference || reference === legacyReference) {
    filePath = path.join(taskDir(taskId), `${variant}.pdf`);
  } else {
    const parts = reference.split('/');
    if (
      parts.length !== 5 ||
      parts[0] !== 'translations' ||
      parts[1] !== taskId ||
      parts[2] !== 'outputs' ||
      parts[4] !== `${variant}.pdf`
    ) {
      return null;
    }
    try {
      filePath = path.join(
        outputGenerationDir(taskId, parts[3]),
        `${variant}.pdf`
      );
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/** 只清理一个失败/过时 harvest attempt，绝不触碰 source 或已发布 attempt。 */
export async function deleteOutputGeneration(
  taskId: string,
  generation: string
): Promise<void> {
  await fs.rm(outputGenerationDir(taskId, generation), {
    recursive: true,
    force: true,
  });
}

/** 删任务级联清理整个任务目录（幂等） */
export async function deleteTaskFiles(taskId: string): Promise<void> {
  await fs.rm(taskDir(taskId), { recursive: true, force: true });
}
