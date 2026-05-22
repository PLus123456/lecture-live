import 'server-only';

import { prisma } from '@/lib/prisma';
import { resolveCloudreveConfig } from '@/lib/storage/cloudreve';
import { decrypt } from '@/lib/crypto';
import { logger, serializeError } from '@/lib/logger';

const jobLogger = logger.child({ component: 'chat-files-cleanup-job' });

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_SOFT_CAP_PERCENT = 90;
/**
 * 软上限触发清理后，目标下沉到 (softCap - SOFT_CAP_TARGET_DROP)% 再停。
 * 留一个缓冲，避免在临界点附近反复触发。
 */
const SOFT_CAP_TARGET_DROP = 10;

export interface ChatFilesCleanupResult {
  agingDeleted: number;
  softCapDeleted: number;
  bytesReleased: bigint;
  errors: number;
}

interface AttachmentRow {
  id: string;
  userId: string;
  bytes: bigint;
  cloudrevePath: string;
  extractedTextPath: string | null;
}

/**
 * 一次运行内复用的 Cloudreve 配置 + token + base URL，避免每条附件都重复查 DB / 解密。
 * null = 未配置 / 未授权，所有删除直接跳过物理文件这一步。
 */
interface CloudreveContext {
  baseUrl: string;
  accessToken: string;
}

/**
 * 主入口：跑 aging + soft-cap 两路清理。可被定时 worker 调用，也可被 admin 手动触发
 * （但 admin 手动批量清理另有路由，本函数主要给 cron）。
 *
 * 两种模式都由 SiteSetting 控制（U13 单元引入 key），本函数防御性读取并附带默认值：
 *   - chat_files_retention_days   默认 14；置 0 表示不做老化清理
 *   - chat_files_soft_cap_percent 默认 90；置 0 表示不做软上限 LRU 清理
 */
export async function runChatFilesCleanup(): Promise<ChatFilesCleanupResult> {
  const [retentionDays, softCapPercent, cloudreveContext] = await Promise.all([
    readNumericSiteSetting('chat_files_retention_days', DEFAULT_RETENTION_DAYS),
    readNumericSiteSetting(
      'chat_files_soft_cap_percent',
      DEFAULT_SOFT_CAP_PERCENT
    ),
    loadCloudreveContext(),
  ]);

  const result: ChatFilesCleanupResult = {
    agingDeleted: 0,
    softCapDeleted: 0,
    bytesReleased: BigInt(0),
    errors: 0,
  };

  // ─── Aging cleanup ───
  if (retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const stale = await prisma.chatAttachment.findMany({
      where: { createdAt: { lt: cutoff } },
      select: {
        id: true,
        userId: true,
        bytes: true,
        cloudrevePath: true,
        extractedTextPath: true,
      },
    });
    for (const att of stale) {
      try {
        await deleteAttachment(att, cloudreveContext);
        result.agingDeleted += 1;
        result.bytesReleased += att.bytes;
      } catch (err) {
        result.errors += 1;
        jobLogger.error(
          { attachmentId: att.id, err: serializeError(err) },
          'aging cleanup failed for attachment'
        );
      }
    }
  }

  // ─── Soft-cap LRU cleanup ───
  if (softCapPercent > 0) {
    // 下沉目标只与全局 softCapPercent 有关，所有用户共享 —— 提到循环外避免重复算。
    const targetPercent = Math.max(
      0,
      Math.min(100, softCapPercent - SOFT_CAP_TARGET_DROP)
    );

    // 找出所有 used > softCap * limit / 100 的用户。Prisma 不支持 column-to-column
    // 比较直接 where；用 raw SQL。ADMIN 用户配额事实上无限，不参与 LRU 清理。
    const overCapUsers: Array<{
      id: string;
      storageBytesUsed: bigint;
      storageBytesLimit: bigint;
    }> = await prisma.$queryRaw`
      SELECT id, storageBytesUsed, storageBytesLimit
      FROM User
      WHERE role <> 'ADMIN'
        AND storageBytesLimit > 0
        AND storageBytesUsed * 100 >= storageBytesLimit * ${softCapPercent}
    `;

    for (const u of overCapUsers) {
      const target =
        (u.storageBytesLimit * BigInt(targetPercent)) / BigInt(100);
      let used = u.storageBytesUsed;

      if (used <= target) continue;

      const attachments = await prisma.chatAttachment.findMany({
        where: { userId: u.id },
        orderBy: { lastAccessedAt: 'asc' },
        select: {
          id: true,
          userId: true,
          bytes: true,
          cloudrevePath: true,
          extractedTextPath: true,
        },
      });

      for (const att of attachments) {
        if (used <= target) break;
        try {
          await deleteAttachment(att, cloudreveContext);
          result.softCapDeleted += 1;
          result.bytesReleased += att.bytes;
          used -= att.bytes;
        } catch (err) {
          result.errors += 1;
          jobLogger.error(
            { attachmentId: att.id, err: serializeError(err) },
            'soft-cap cleanup failed for attachment'
          );
        }
      }
    }
  }

  jobLogger.info(
    {
      agingDeleted: result.agingDeleted,
      softCapDeleted: result.softCapDeleted,
      // bigint 不能直接被 pino 序列化为 JSON，转字符串
      bytesReleased: result.bytesReleased.toString(),
      errors: result.errors,
    },
    'chat-files cleanup finished'
  );

  return result;
}

/**
 * 删除一条 ChatAttachment：
 *   1) 先尽力删 Cloudreve 物理文件（失败不抛 — 删不掉就让它残留，配置/网络问题不应阻塞 DB 清理）
 *   2) 然后删 DB 行（一旦走到这步必须成功，否则下次循环还会撞上同一条）
 *   3) 用 raw SQL 把 user.storageBytesUsed 减掉，GREATEST(0, ...) 防止负数
 */
async function deleteAttachment(
  att: AttachmentRow,
  cloudreve: CloudreveContext | null
): Promise<void> {
  if (cloudreve) {
    await deleteFromCloudreveByPath(att.cloudrevePath, cloudreve);
    if (att.extractedTextPath) {
      await deleteFromCloudreveByPath(att.extractedTextPath, cloudreve);
    }
  }

  await prisma.chatAttachment.delete({ where: { id: att.id } });

  await prisma.$executeRaw`
    UPDATE User
    SET storageBytesUsed = GREATEST(0, CAST(storageBytesUsed AS SIGNED) - ${att.bytes})
    WHERE id = ${att.userId}
  `;
}

/**
 * 读取一个数值型 SiteSetting；找不到 / 解析失败时返回 fallback。
 * 不走 getSiteSettings()：这些 key 尚未在 SiteSettings 接口中声明（U13 单元负责注册），
 * 直接 raw 读 DB 是当前阶段最稳妥的方式 —— 即使 U13 还没上线，本 cron 也能正常跑。
 */
async function readNumericSiteSetting(
  key: string,
  fallback: number
): Promise<number> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key } });
    if (!row?.value) return fallback;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 把 Cloudreve 配置 + 加密 access_token 一次性解出来，给后续每条附件的删除复用。
 *
 * 为什么不调 CloudreveStorage：
 *   - 该类此刻没有公开 delete 方法（其他单元的领地），按 plan 不许动它。
 *   - access_token 与 refresh_token 都是内部状态，没有公开 getter。
 *
 * 失败语义：任意一步出错（未配置 / 未授权 / 解密失败）都返回 null，调用方据此跳过物理删除。
 * 这是 best-effort —— 不能因为外部存储不可达就把整个 cron 卡住，DB 行该删的还是要删。
 */
async function loadCloudreveContext(): Promise<CloudreveContext | null> {
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
    jobLogger.warn(
      { err: serializeError(err) },
      '[chat-files-cleanup] 加载 Cloudreve 上下文失败；将跳过所有物理文件删除'
    );
    return null;
  }
}

/**
 * 删 Cloudreve 上的一个文件（best-effort）。
 *
 * 用 V4 API：DELETE /api/v4/file，body `{ uris: ["cloudreve://my/{path}"] }`。
 * 任何失败（网络 / 鉴权 / 服务端错误）都静默 warn 然后返回 —— 残留文件可由 admin
 * 手动批量清理工具兜底，不能阻塞 DB 清理。
 */
async function deleteFromCloudreveByPath(
  remotePath: string,
  cloudreve: CloudreveContext
): Promise<void> {
  try {
    const fileUri = remotePath.startsWith('/')
      ? `cloudreve://my${remotePath}`
      : `cloudreve://my/${remotePath}`;

    const response = await fetch(`${cloudreve.baseUrl}/api/v4/file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloudreve.accessToken}`,
      },
      body: JSON.stringify({ uris: [fileUri] }),
    });

    if (!response.ok) {
      jobLogger.warn(
        { remotePath, status: response.status },
        '[chat-files-cleanup] Cloudreve delete non-2xx; 残留文件可由 admin 手动清理'
      );
    }
  } catch (err) {
    jobLogger.warn(
      { remotePath, err: serializeError(err) },
      '[chat-files-cleanup] Cloudreve delete threw; 残留文件可由 admin 手动清理'
    );
  }
}
