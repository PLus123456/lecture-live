// POST /api/chat-uploads   → 上传聊天附件（图片 / 文档 / 文本）到 Cloudreve，扣配额
// GET  /api/chat-uploads?conversationId=...  → 列出某对话下附件并 touch lastAccessedAt
//
// 路由设计沿用 /api/storage/upload 的"auth + rate-limit + quota + Cloudreve.upload"骨架，
// 但额外做：MIME 自动分类（image | document | text）、document/text 自动抽文本副本、
// addStorageBytes 扣配额、按 LRU 更新 lastAccessedAt。
//
// 归属校验：Conversation 当前没有直接的 userId 列，因此本端点支持两种来源：
//   1. session-bound：Conversation.sessionId → Session.userId 等于当前 user
//   2. 多录音对话：Conversation.sessions[*].session.userId 包含当前 user
//   3. 纯 global 对话（既无 sessionId 也无 ConversationSession 行）—— 任何登录用户可写
//      （TODO: 后续 schema 迁移给 Conversation 加 userId 后收紧此分支）
// 这种"宽进"是临时的，因为 Wave 3 此时 schema 还没为 Conversation 加 userId。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { checkQuota, addStorageBytes } from '@/lib/quota';
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
    select: {
      sessionId: true,
      endedAt: true,
      session: { select: { userId: true } },
      sessions: { select: { session: { select: { userId: true } } } },
    },
  });

  if (!conversation) {
    return { ok: false, exists: false };
  }

  // 1) session-bound（单录音对话）
  if (conversation.session && conversation.session.userId === userId) {
    return { ok: true, exists: true, endedAt: conversation.endedAt };
  }

  // 2) 多录音绑定：sessions[*].session.userId 命中
  if (conversation.sessions.some((row) => row.session.userId === userId)) {
    return { ok: true, exists: true, endedAt: conversation.endedAt };
  }

  // 3) 纯 global 对话：无 sessionId 且无 ConversationSession 行 — 暂时放过
  //    TODO: schema 加上 Conversation.userId 后收紧此分支
  if (!conversation.sessionId && conversation.sessions.length === 0) {
    return { ok: true, exists: true, endedAt: conversation.endedAt };
  }

  return { ok: false, exists: true };
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

  // 配额检查
  const quotaOk = await checkQuota(user.id, 'storage_bytes');
  if (!quotaOk) {
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
    return NextResponse.json(
      { error: `Unsupported MIME type: ${mt}` },
      { status: 415 }
    );
  }

  // 文件名清洗 + 同 conversation 下加前缀防碰撞
  // （CloudreveStorage.upload() 内部 sanitizePath 会去 '/'，无法直接把 conversationId 当目录用；
  // 因此把 conversationId 编入 fileName 仍能保证不同对话间不重名）
  const safeFileName = sanitizeHeaderFilename(file.name);
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
    return NextResponse.json(
      { error: 'Failed to record attachment' },
      { status: 500 }
    );
  }

  // 扣配额（抽出的 .txt 算衍生产物不再扣，避免双重计费）
  try {
    await addStorageBytes(user.id, file.size);
  } catch (err) {
    routeLogger.warn(
      { userId: user.id, err: serializeError(err) },
      'chat-uploads: addStorageBytes failed; attachment 已记录，配额下次校准会兜底'
    );
  }

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
