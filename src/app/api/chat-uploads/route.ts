// POST /api/chat-uploads   → 上传聊天附件（图片 / 文档 / 文本）到 Cloudreve，扣配额
// GET  /api/chat-uploads?conversationId=...  → 列出某对话下附件并 touch lastAccessedAt
//
// 路由设计沿用 /api/storage/upload 的"auth + rate-limit + quota + Cloudreve.upload"骨架，
// 但额外做：MIME 自动分类（image | document | text）、document/text 自动抽文本副本、
// addStorageBytes 扣配额、按 LRU 更新 lastAccessedAt。
//
// 归属校验：用 Conversation.userId（创建时由服务端写入）。userId 命中当前用户才放行；
// userId 为 NULL 的历史无主孤儿一律拒绝（此前的 orphan"宽进"已收紧）。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { reserveStorageBytes, releaseStorageBytes } from '@/lib/quota';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import { getSiteSettings } from '@/lib/siteSettings';
import { sanitizeHeaderFilename } from '@/lib/security';
import {
  extractTextFromBuffer,
  isExtractableMime,
} from '@/lib/llm/fileExtractor';
import { logger, serializeError } from '@/lib/logger';

const routeLogger = logger.child({ component: 'chat-uploads-api' });

/** 单次上传字节硬上限（兜底）—— 防止管理员误把 max_upload_mb 配成 > 500 而 OOM。 */
const ABSOLUTE_MAX_BYTES = 500 * 1024 * 1024;

/** 与 fileExtractor 内 PLAIN_TEXT_MIMES 同步：这些是抽不出"另存为 .txt"语义的纯文本/代码 MIME。 */
const PLAIN_TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
]);

type AttachmentKind = 'image' | 'document' | 'text';

/** MIME → kind 分类。text/* 与 PLAIN_TEXT_MIMES 归 'text'；可抽文本的 Office/PDF 归 'document'；
 *  image/* 归 'image'；其它返回 null 让调用方 415 拒绝。 */
function classifyKind(mt: string): AttachmentKind | null {
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('text/') || PLAIN_TEXT_MIMES.has(mt)) return 'text';
  if (isExtractableMime(mt)) return 'document';
  return null;
}

/** ChatAttachment.fileName / cloudrevePath / extractedTextPath 的列宽（VARCHAR(191)）。 */
const ATTACHMENT_COLUMN_MAX = 191;
/** 抽取文本副本追加的后缀，也要计入 extractedTextPath 长度。 */
const EXTRACTED_SUFFIX = '.extracted.txt';

/**
 * U32：把清洗后的文件名截断到能让 fileName / cloudrevePath / extractedTextPath 三列
 * 都 ≤ VARCHAR(191)。最紧约束是 extractedTextPath：
 *   `/{userId}/chat-uploads/{conversationId}_{name}.extracted.txt`
 * 反推出 name 的最大可用长度，仅在超限时截断（尽量保留文件扩展名）。
 */
function truncateSafeFileName(
  name: string,
  userId: string,
  conversationId: string
): string {
  // 固定开销：`/` + userId + `/chat-uploads/` + conversationId + `_` + …name… + `.extracted.txt`
  const fixed =
    1 +
    userId.length +
    '/chat-uploads/'.length +
    conversationId.length +
    1 +
    EXTRACTED_SUFFIX.length;
  // fileName 列本身也受 191 限；取两者更紧的上限。
  const maxNameLen = Math.min(ATTACHMENT_COLUMN_MAX, ATTACHMENT_COLUMN_MAX - fixed);
  if (name.length <= maxNameLen) return name;

  // 尽量保留扩展名：`base.ext` → 截 base，保留 `.ext`（扩展名过长则整体硬截断）。
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  if (ext && ext.length < maxNameLen) {
    const base = name.slice(0, maxNameLen - ext.length);
    return `${base}${ext}`;
  }
  return name.slice(0, Math.max(1, maxNameLen));
}

/**
 * 校验 conversation 是否归属当前用户。
 * 返回 true 表示允许，false 表示拒绝。
 */
async function isConversationAccessible(
  conversationId: string,
  userId: string
): Promise<{ ok: boolean; exists: boolean; endedAt?: Date | null }> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, endedAt: true },
  });

  if (!conversation) {
    return { ok: false, exists: false };
  }

  // 归属：Conversation.userId 命中本人即可（userId 为 NULL 的无主孤儿 → 拒绝）。
  const ok = conversation.userId !== null && conversation.userId === userId;
  return { ok, exists: true, endedAt: conversation.endedAt };
}

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'chat:upload',
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // Content-Length 预检：读 body 前按声明长度挡掉超过硬上限的请求，避免把超大 body
  // 整个缓冲进内存（OOM 面）。这里用绝对硬上限兜底（精确的 chat_files_max_upload_mb
  // 校验在下方按配置进行）；multipart 开销给 1MB 余量避免误杀。
  const declaredLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > ABSOLUTE_MAX_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: `File too large (max ${Math.floor(ABSOLUTE_MAX_BYTES / (1024 * 1024))} MB)` },
      { status: 413 }
    );
  }

  // 解析 form data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  const conversationIdRaw = formData.get('conversationId');
  const mimeOverrideRaw = formData.get('mimeTypeOverride');

  if (!file || typeof conversationIdRaw !== 'string' || !conversationIdRaw) {
    return NextResponse.json(
      { error: 'file and conversationId are required' },
      { status: 400 }
    );
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  }

  const conversationId = conversationIdRaw;

  // 归属校验
  const access = await isConversationAccessible(conversationId, user.id);
  if (!access.exists) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  if (!access.ok) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
  if (access.endedAt) {
    return NextResponse.json(
      { error: 'Conversation is closed (read-only)' },
      { status: 409 }
    );
  }

  // 单次上传大小限制（管理员配置，硬封顶 500MB）
  const siteSettings = await getSiteSettings();
  const maxBytes = Math.min(
    Math.max(1, siteSettings.chat_files_max_upload_mb) * 1024 * 1024,
    ABSOLUTE_MAX_BYTES
  );
  if (file.size > maxBytes) {
    return NextResponse.json(
      {
        error: `File too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`,
      },
      { status: 413 }
    );
  }

  // 配额：原子预留 file.size 字节（条件扣减，杜绝并发击穿）。预留成功后若后续任一
  // 步骤失败，必须 releaseStorageBytes 回滚，避免配额泄漏。
  const reserved = await reserveStorageBytes(user.id, file.size);
  if (!reserved) {
    return NextResponse.json(
      { error: 'Storage quota exceeded' },
      { status: 403 }
    );
  }

  // MIME 分类（允许显式 override，但仍要分类成 image/document/text 之一）
  const mt = (
    (typeof mimeOverrideRaw === 'string' && mimeOverrideRaw) ||
    file.type ||
    'application/octet-stream'
  )
    .toLowerCase()
    .trim();
  const kind = classifyKind(mt);
  if (!kind) {
    // 回滚预留的字节配额（MIME 不受支持，文件不会入库/入云，额度不应被占用）。
    // 与下方 Cloudreve-fail / DB-insert-fail 两个退出口一致，杜绝配额泄漏。
    await releaseStorageBytes(user.id, file.size).catch(() => undefined);
    return NextResponse.json(
      { error: `Unsupported MIME type: ${mt}` },
      { status: 415 }
    );
  }

  // 文件名清洗 + 同 conversation 下加前缀防碰撞
  // （CloudreveStorage.upload() 内部 sanitizePath 会去 '/'，无法直接把 conversationId 当目录用；
  // 因此把 conversationId 编入 fileName 仍能保证不同对话间不重名）
  //
  // U32：ChatAttachment.fileName / cloudrevePath / extractedTextPath 均为 VARCHAR(191)。
  // sanitizeHeaderFilename 只截到 255，且 cloudrevePath 还要拼
  // `/{userId}/chat-uploads/{conversationId}_{name}`（+ 可能的 `.extracted.txt`），
  // 过长文件名会让 DB insert 在 MySQL strict 下报 "Data too long"（且 Cloudreve 已存文件成孤儿）。
  // 这里先按最紧约束（extractedTextPath）反推 name 的最大可用长度并截断，保证三列都 ≤191。
  const safeFileName = truncateSafeFileName(
    sanitizeHeaderFilename(file.name),
    user.id,
    conversationId
  );
  const composedFileName = `${conversationId}_${safeFileName}`;

  // 读 buffer（后续上传 + 可选抽文本都要用同一份）
  const buffer = Buffer.from(await file.arrayBuffer());

  // 上传 Cloudreve
  let cloudrevePath: string;
  try {
    const storage = await CloudreveStorage.create();
    cloudrevePath = await storage.upload(
      user.id,
      'chat-uploads',
      composedFileName,
      buffer
    );
  } catch (err) {
    routeLogger.error(
      { conversationId, userId: user.id, err: serializeError(err) },
      'chat-uploads: Cloudreve upload failed'
    );
    // 回滚预留的字节配额（文件没传成功，不应占额度）
    await releaseStorageBytes(user.id, file.size).catch(() => undefined);
    return NextResponse.json(
      { error: 'Upload failed' },
      { status: 500 }
    );
  }

  // 文档 / 文本类：尝试抽文本并把 .txt 也写回 Cloudreve（best-effort）
  let extractedTextPath: string | null = null;
  let extractedTextPreview: string | null = null;
  if (kind === 'document' || kind === 'text') {
    try {
      const extracted = await extractTextFromBuffer(buffer, mt);
      // 取前 500 字符给前端 preview；完整文本另写入 .txt（仅 document 必需，text 也写一份以便统一读取）
      extractedTextPreview = extracted.text.slice(0, 500);

      try {
        const storage = await CloudreveStorage.create();
        const extractedFileName = `${composedFileName}.extracted.txt`;
        extractedTextPath = await storage.upload(
          user.id,
          'chat-uploads',
          extractedFileName,
          Buffer.from(extracted.text, 'utf8')
        );
      } catch (uploadErr) {
        routeLogger.warn(
          {
            conversationId,
            userId: user.id,
            err: serializeError(uploadErr),
          },
          'chat-uploads: extracted text upload failed; attachment 仍会创建但 extractedTextPath = null'
        );
        extractedTextPath = null;
      }
    } catch (err) {
      // 抽文本失败（损坏的 PDF 等）—— 不阻塞上传，仍记录 attachment 行，让用户至少能看到文件
      routeLogger.warn(
        {
          conversationId,
          userId: user.id,
          mt,
          err: serializeError(err),
        },
        'chat-uploads: text extraction failed; attachment still recorded'
      );
    }
  }

  // 写 ChatAttachment 行（fileName 存原始 safeFileName，cloudrevePath 存 Cloudreve 返回的实际路径）
  let attachmentId: string;
  try {
    const created = await prisma.chatAttachment.create({
      data: {
        conversationId,
        userId: user.id,
        kind,
        fileName: safeFileName,
        mimeType: mt,
        bytes: BigInt(file.size),
        cloudrevePath,
        extractedTextPath,
      },
      select: { id: true },
    });
    attachmentId = created.id;
  } catch (err) {
    routeLogger.error(
      { conversationId, userId: user.id, err: serializeError(err) },
      'chat-uploads: DB insert failed'
    );
    // 回滚预留的字节配额（行没建成，额度不应被占用）。
    // 注意：此时 Cloudreve 上已有物理文件成为孤儿，留给清理 cron 兜底（与原行为一致）。
    await releaseStorageBytes(user.id, file.size).catch(() => undefined);
    return NextResponse.json(
      { error: 'Failed to record attachment' },
      { status: 500 }
    );
  }

  // 注意：字节配额已在上传前用 reserveStorageBytes 原子预留，这里不再重复扣减。
  // 抽出的 .txt 算衍生产物，本就不计费。

  return NextResponse.json({
    attachmentId,
    cloudrevePath,
    kind,
    bytes: file.size,
    extractedTextPreview,
    fileName: safeFileName,
  });
}

export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId');
  if (!conversationId) {
    return NextResponse.json(
      { error: 'conversationId required' },
      { status: 400 }
    );
  }

  const access = await isConversationAccessible(conversationId, user.id);
  if (!access.exists) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  if (!access.ok) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const rows = await prisma.chatAttachment.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      kind: true,
      bytes: true,
      createdAt: true,
      cloudrevePath: true,
    },
  });

  // touch lastAccessedAt 用于 LRU 清理（一次 updateMany 比逐条 update 快得多）
  if (rows.length > 0) {
    try {
      await prisma.chatAttachment.updateMany({
        where: { conversationId },
        data: { lastAccessedAt: new Date() },
      });
    } catch (err) {
      routeLogger.warn(
        { conversationId, err: serializeError(err) },
        'chat-uploads: updateMany lastAccessedAt failed'
      );
    }
  }

  return NextResponse.json({
    attachments: rows.map((r) => ({
      id: r.id,
      fileName: r.fileName,
      mimeType: r.mimeType,
      kind: r.kind,
      bytes: Number(r.bytes),
      createdAt: r.createdAt.toISOString(),
      cloudrevePath: r.cloudrevePath,
    })),
  });
}
