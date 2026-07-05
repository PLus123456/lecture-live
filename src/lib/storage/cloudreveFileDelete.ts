import 'server-only';

import { prisma } from '@/lib/prisma';
import { resolveCloudreveConfig } from '@/lib/storage/cloudreve';
import { decrypt } from '@/lib/crypto';
import { logger, serializeError } from '@/lib/logger';

/**
 * Cloudreve 物理文件 best-effort 删除 —— 全站统一入口。
 *
 * 背景：CloudreveStorage 类没有公开 delete 方法，且 access_token 是其内部状态、无公开 getter。
 * 历史上 chat-uploads 删除、chatFilesCleanupJob、admin 删用户各自手抄了一份
 * `loadCloudreveContext` + `deleteFromCloudreveByPath`。本模块把它收敛成单一实现，
 * 供"删单条附件 / 清理 cron / 删用户 / 删对话"复用，避免再抄第四份、避免行为漂移。
 *
 * 一切 best-effort：任何失败（未配置 / 未授权 / 网络 / 服务端错误）只 warn，绝不抛、绝不阻塞
 * DB 清理。物理残留交由 admin 文件清理工具兜底。
 */

const fileLogger = logger.child({ component: 'cloudreve-file-delete' });

/**
 * 出站 DELETE 的超时（ms）。与 cloudreve.ts 的 CLOUDREVE_API_TIMEOUT_MS 对齐：
 * 删除是小 JSON 控制面请求，30s 足够覆盖慢网络，又能兜底防止 TCP 已连接但对端
 * 永不响应（进程 D-state / 网络黑洞）时 fetch 永久挂起——那会无限阻塞用户删除
 * 请求，并让 chatFilesCleanupJob 在第一个附件上永久卡死。
 */
const CLOUDREVE_DELETE_TIMEOUT_MS = 30_000;

export interface CloudreveDeleteContext {
  baseUrl: string;
  accessToken: string;
}

/**
 * 解出 Cloudreve 物理删除所需的 baseUrl + 解密后的 access_token。
 * 任一步失败（未配置 / 无 token / 解密失败）返回 null，调用方据此跳过物理删除。
 */
export async function loadCloudreveContext(): Promise<CloudreveDeleteContext | null> {
  try {
    const config = await resolveCloudreveConfig();
    if (!config) return null;

    const row = await prisma.siteSetting.findUnique({
      where: { key: 'cloudreve_access_token' },
    });
    if (!row?.value) return null;

    const accessToken = decrypt(row.value);
    if (!accessToken) return null;

    return {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      accessToken,
    };
  } catch (err) {
    fileLogger.warn(
      { err: serializeError(err) },
      'loadCloudreveContext 失败；跳过物理删除'
    );
    return null;
  }
}

/** 删 Cloudreve 上的一个文件（best-effort，V4 API：DELETE /api/v4/file）。失败仅 warn。 */
export async function deleteCloudreveFile(
  remotePath: string,
  ctx: CloudreveDeleteContext
): Promise<void> {
  try {
    const fileUri = remotePath.startsWith('/')
      ? `cloudreve://my${remotePath}`
      : `cloudreve://my/${remotePath}`;

    const response = await fetch(`${ctx.baseUrl}/api/v4/file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.accessToken}`,
      },
      body: JSON.stringify({ uris: [fileUri] }),
      // 兜底超时：对端 TCP 已连接但永不响应时，避免 fetch 永久挂起阻塞调用方。
      signal: AbortSignal.timeout(CLOUDREVE_DELETE_TIMEOUT_MS),
    });

    if (!response.ok) {
      fileLogger.warn(
        { remotePath, status: response.status },
        'Cloudreve DELETE non-2xx; 残留由清理工具兜底'
      );
    }
  } catch (err) {
    fileLogger.warn(
      { remotePath, err: serializeError(err) },
      'Cloudreve DELETE threw; 残留由清理工具兜底'
    );
  }
}

/**
 * 便捷批量删除：给定一批附件元数据（含 cloudrevePath + 可选 extractedTextPath），
 * 一次性加载 Cloudreve 上下文并 best-effort 删除其全部物理文件（原文件 + 抽取的 .txt）。
 *
 * 未配置 Cloudreve / 加载上下文失败 → 静默跳过，返回 false（不视作错误）。
 * 整个过程永不抛错。
 */
export async function deleteCloudreveAttachmentFiles(
  attachments: ReadonlyArray<{
    cloudrevePath: string;
    extractedTextPath: string | null;
  }>
): Promise<boolean> {
  if (attachments.length === 0) return true;
  const ctx = await loadCloudreveContext();
  if (!ctx) return false;
  for (const att of attachments) {
    await deleteCloudreveFile(att.cloudrevePath, ctx);
    if (att.extractedTextPath) {
      await deleteCloudreveFile(att.extractedTextPath, ctx);
    }
  }
  return true;
}
