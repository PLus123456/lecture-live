import 'server-only';

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { logger, serializeError } from '@/lib/logger';

/**
 * 聊天图片持久化。
 *
 * ConversationMessage.content 是 MySQL TEXT（64KB 上限），无法内嵌 base64 图片，
 * 故把图片落到本地磁盘 data/chatimages/<conversationId>/<name>，并在 user 消息
 * content 里写入 markdown 图片引用 ![image](/api/conversations/<id>/images/<name>)。
 * 刷新页面后 loadConversationMessages 拿到 content 即可重新渲染图片。
 */

const imgLogger = logger.child({ component: 'chat-image-storage' });

const CHAT_IMAGE_ROOT = path.join(process.cwd(), 'data', 'chatimages');

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
  // base64 长度 → 字节数（每 4 字符 ≈ 3 字节）
  const byteLength = Math.floor((data.length * 3) / 4);
  return { mediaType, data, byteLength };
}

/** 仅允许字母数字与单段文件名，杜绝路径穿越 */
function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..');
}

/**
 * 把一张已解码图片写入本地磁盘，返回可渲染的相对 URL（落进 message content）。
 */
export async function persistChatImage(
  conversationId: string,
  image: DecodedChatImage
): Promise<string> {
  if (!isSafeName(conversationId)) {
    throw new Error('Invalid conversationId');
  }
  const ext = MIME_EXTENSION[image.mediaType] ?? 'png';
  const fileName = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
  const dir = path.join(CHAT_IMAGE_ROOT, conversationId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, fileName),
    Buffer.from(image.data, 'base64')
  );
  return `/api/conversations/${conversationId}/images/${fileName}`;
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
): Promise<void> {
  if (!isSafeName(conversationId)) return;
  const dir = path.join(CHAT_IMAGE_ROOT, conversationId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    imgLogger.warn(
      { conversationId, err: serializeError(err) },
      'failed to remove chat image dir'
    );
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
