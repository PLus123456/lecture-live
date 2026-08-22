import 'server-only';

import fs from 'fs/promises';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger, serializeError } from '@/lib/logger';
import {
  STORED_ARTIFACT_RESERVATION_TTL_MS,
  STORED_ARTIFACT_STATE,
  STORED_ARTIFACT_TYPE,
  getStoredArtifactById,
  markStoredArtifactOrphan,
  recordReservedStoredArtifactLocation,
  reserveStoredArtifact,
  rollbackStoredArtifact,
  settleStoredArtifactInTransaction,
} from '@/lib/storage/storedArtifactLedger';

/**
 * 聊天图片持久化。
 *
 * ConversationMessage.content 是 MySQL TEXT（64KB 上限），无法内嵌 base64 图片，
 * 故把图片落到本地磁盘 data/chatimages/<conversationId>/<name>，并在 user 消息
 * content 里写入 markdown 图片引用 ![image](/api/conversations/<id>/images/<name>)。
 * 刷新页面后 loadConversationMessages 拿到 content 即可重新渲染图片。
 */

const imgLogger = logger.child({ component: 'chat-image-storage' });

export const CHAT_IMAGE_ROOT = path.join(process.cwd(), 'data', 'chatimages');

/** 每轮最多 4×5MiB；对话累计额外给 5 轮余量，但仍有硬顶。 */
export const MAX_INLINE_IMAGE_BYTES_PER_CONVERSATION = 100 * 1024 * 1024;
export const MAX_INLINE_IMAGES_PER_CONVERSATION = 128;

/** 受支持的图片 MIME 类型 → 文件扩展名 */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface DecodedChatImage {
  mediaType: string;
  /** 纯 base64（不含 data: 前缀） */
  data: string;
  /** 解码后的字节数 */
  byteLength: number;
}

/**
 * 解析 `data:image/png;base64,xxxx` 形式的 data URL。
 * 非法格式或不支持的 MIME 返回 null。
 */
export function parseImageDataUrl(dataUrl: unknown): DecodedChatImage | null {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl.trim()
  );
  if (!match) return null;
  const mediaType = match[1].toLowerCase();
  if (!MIME_EXTENSION[mediaType]) return null;
  const data = match[2];
  // 必须按真正解码后的字节量判限/计费；公式估算会被 padding 等边界偏差。
  const byteLength = Buffer.from(data, 'base64').byteLength;
  return { mediaType, data, byteLength };
}

/** 仅允许字母数字与单段文件名，杜绝路径穿越 */
function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..');
}

export interface StagedChatImage {
  attachmentId: string;
  artifactId: string;
  conversationId: string;
  fileName: string;
  filePath: string;
  reference: string;
  url: string;
  bytes: number;
  mediaType: string;
}

export class ChatImagePublicationOutcomeUnknownError extends Error {
  constructor(cause?: unknown) {
    super('chat image publication outcome is unknown', { cause });
    this.name = 'ChatImagePublicationOutcomeUnknownError';
  }
}

/**
 * 内联图片两阶段发布的 stage：先原子预留，再写物理文件和隐藏的
 * ChatAttachment(INLINE) 行。此时 artifact 仍是 RESERVED，附件行带 1h TTL；
 * 只有与 ConversationMessage 在同一 DB 事务成功后才转 ACTIVE 并清 TTL。
 */
export async function stageChatImage(
  conversationId: string,
  userId: string,
  image: DecodedChatImage
): Promise<StagedChatImage> {
  if (!isSafeName(conversationId)) {
    throw new Error('Invalid conversationId');
  }
  if (!isSafeName(userId)) {
    throw new Error('Invalid userId');
  }
  const decoded = Buffer.from(image.data, 'base64');
  if (decoded.byteLength <= 0) {
    throw new Error('Empty chat image');
  }

  const ext = MIME_EXTENSION[image.mediaType] ?? 'png';
  const fileName = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
  const attachmentId = randomUUID();
  const dir = path.join(CHAT_IMAGE_ROOT, conversationId);
  const filePath = path.join(dir, fileName);
  const reference = `local:chatimages/${conversationId}/${fileName}`;
  const url = `/api/conversations/${conversationId}/images/${fileName}`;
  const expiresAt = new Date(Date.now() + STORED_ARTIFACT_RESERVATION_TTL_MS);
  const reservation = await reserveStoredArtifact({
    userId,
    ownerType: 'chat_attachment',
    ownerId: attachmentId,
    conversationId,
    artifactType: STORED_ARTIFACT_TYPE.INLINE_IMAGE,
    expectedBytes: decoded.byteLength,
    reservationKey: `inline-image:${attachmentId}`,
    expiresAt,
    conversationLimitBytes: MAX_INLINE_IMAGE_BYTES_PER_CONVERSATION,
    conversationLimitCount: MAX_INLINE_IMAGES_PER_CONVERSATION,
  });

  let written = false;
  let attachmentInserted = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, decoded);
    written = true;
    await recordReservedStoredArtifactLocation(reservation.id, {
      actualBytes: decoded.byteLength,
      storage: 'local',
      reference,
    });
    await prisma.$executeRaw`
      INSERT INTO ChatAttachment (
        id, conversationId, userId, kind, fileName, mimeType, bytes,
        cloudrevePath, extractedTextPath, source, storedArtifactId, expiresAt,
        createdAt, lastAccessedAt
      ) VALUES (
        ${attachmentId}, ${conversationId}, ${userId}, 'image', ${fileName},
        ${image.mediaType}, ${BigInt(decoded.byteLength)}, ${reference}, NULL,
        'INLINE', ${reservation.id}, ${expiresAt}, NOW(3), NOW(3)
      )
    `;
    attachmentInserted = true;
    return {
      attachmentId,
      artifactId: reservation.id,
      conversationId,
      fileName,
      filePath,
      reference,
      url,
      bytes: decoded.byteLength,
      mediaType: image.mediaType,
    };
  } catch (error) {
    if (attachmentInserted) {
      await prisma.$executeRaw`
        DELETE FROM ChatAttachment WHERE id = ${attachmentId} AND source = 'INLINE'
      `.catch(() => undefined);
    }
    let deleted = !written;
    if (written) {
      try {
        await fs.rm(filePath, { force: true });
        deleted = true;
      } catch {
        deleted = false;
      }
    }
    if (deleted) {
      await rollbackStoredArtifact(reservation.id).catch(() => undefined);
    } else {
      await markStoredArtifactOrphan(reservation.id).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * 用户消息和 INLINE 附件在同一事务发布：任何一张 settle 或消息写入
 * 失败都整体回滚，不会出现「永久文件但没有消息引用」的窗口。
 */
export async function createUserMessageWithStagedChatImages(args: {
  conversationId: string;
  content: string;
  transcriptOffsetMs: number;
  images: ReadonlyArray<StagedChatImage>;
}): Promise<void> {
  const messageId = randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      for (const image of args.images) {
        await settleStoredArtifactInTransaction(tx, image.artifactId, {
          actualBytes: image.bytes,
          storage: 'local',
          reference: image.reference,
        });
      }
      await tx.conversationMessage.create({
        data: {
          id: messageId,
          conversationId: args.conversationId,
          role: 'user',
          content: args.content,
          transcriptOffsetMs: args.transcriptOffsetMs,
        },
      });
      if (args.images.length > 0) {
        const ids = args.images.map((image) => image.attachmentId);
        await tx.$executeRaw(
          Prisma.sql`
            UPDATE ChatAttachment
            SET expiresAt = NULL, lastAccessedAt = NOW(3)
            WHERE id IN (${Prisma.join(ids)})
              AND source = 'INLINE'
          `
        );
      }
    });
  } catch (publishError) {
    try {
      const [message, attachmentRows, artifacts] = await Promise.all([
        prisma.conversationMessage.findUnique({
          where: { id: messageId },
          select: { conversationId: true, content: true },
        }),
        args.images.length > 0
          ? prisma.$queryRaw<
              Array<{
                id: string;
                storedArtifactId: string | null;
                expiresAt: Date | null;
              }>
            >(Prisma.sql`
              SELECT id, storedArtifactId, expiresAt
              FROM ChatAttachment
              WHERE id IN (${Prisma.join(args.images.map((image) => image.attachmentId))})
                AND source = 'INLINE'
            `)
          : Promise.resolve([]),
        Promise.all(
          args.images.map((image) => getStoredArtifactById(image.artifactId))
        ),
      ]);
      const attachmentsById = new Map(
        attachmentRows.map((row) => [row.id, row])
      );
      const committed =
        message?.conversationId === args.conversationId &&
        message.content === args.content &&
        args.images.every((image, index) => {
          const attachment = attachmentsById.get(image.attachmentId);
          const artifact = artifacts[index];
          return (
            attachment?.storedArtifactId === image.artifactId &&
            attachment.expiresAt === null &&
            artifact?.state === STORED_ARTIFACT_STATE.ACTIVE &&
            artifact.reference === image.reference
          );
        });
      if (committed) {
        imgLogger.warn(
          { conversationId: args.conversationId, messageId },
          'chat image transaction returned failure but readback confirmed commit'
        );
        return;
      }
      const definitelyNotCommitted =
        message === null &&
        args.images.every((image, index) => {
          const attachment = attachmentsById.get(image.attachmentId);
          const artifact = artifacts[index];
          return (
            attachment !== undefined &&
            attachment.expiresAt !== null &&
            artifact?.state === STORED_ARTIFACT_STATE.RESERVED
          );
        });
      if (definitelyNotCommitted) throw publishError;
      throw new ChatImagePublicationOutcomeUnknownError(publishError);
    } catch (readbackError) {
      if (
        readbackError === publishError ||
        readbackError instanceof ChatImagePublicationOutcomeUnknownError
      ) {
        throw readbackError;
      }
      throw new ChatImagePublicationOutcomeUnknownError(readbackError);
    }
  }
}

export async function rollbackStagedChatImages(
  images: ReadonlyArray<StagedChatImage>
): Promise<void> {
  for (const image of images) {
    let deleted = false;
    try {
      await fs.rm(image.filePath, { force: true });
      deleted = true;
    } catch (err) {
      imgLogger.warn(
        { conversationId: image.conversationId, err: serializeError(err) },
        'failed to rollback staged chat image'
      );
    }
    await prisma.$executeRaw`
      DELETE FROM ChatAttachment
      WHERE id = ${image.attachmentId} AND source = 'INLINE'
    `.catch(() => undefined);
    if (deleted) {
      await rollbackStoredArtifact(image.artifactId).catch(() => undefined);
    } else {
      await markStoredArtifactOrphan(image.artifactId).catch(() => undefined);
    }
  }
}

/**
 * 删除一个对话的全部本地内嵌图片目录 `data/chatimages/<conversationId>/`（best-effort）。
 *
 * 这些图片不进 ChatAttachment 表、不计配额，仅被 message.content 的 markdown URL 引用，
 * 故删对话时必须显式清理本地目录，否则永久残留（cron 也不扫这个目录）。
 * 失败仅 warn —— 不能因本地 IO 失败阻塞删对话的 DB 清理。
 */
export async function deleteConversationImages(
  conversationId: string
): Promise<boolean> {
  if (!isSafeName(conversationId)) return false;
  const dir = path.join(CHAT_IMAGE_ROOT, conversationId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    imgLogger.warn(
      { conversationId, err: serializeError(err) },
      'failed to remove chat image dir'
    );
    return false;
  }
}

/** 从磁盘读回一张聊天图片（供 serving 路由用）。找不到返回 null。 */
export async function readChatImage(
  conversationId: string,
  fileName: string
): Promise<{ data: Buffer; contentType: string } | null> {
  if (!isSafeName(conversationId) || !isSafeName(fileName)) {
    return null;
  }
  const filePath = path.join(CHAT_IMAGE_ROOT, conversationId, fileName);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const contentType =
      Object.entries(MIME_EXTENSION).find(([, e]) => e === ext)?.[0] ??
      'application/octet-stream';
    return { data, contentType };
  } catch (err) {
    imgLogger.warn(
      { conversationId, fileName, err: serializeError(err) },
      'chat image not found on disk'
    );
    return null;
  }
}
