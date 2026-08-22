// POST /api/chat-uploads   → 上传聊天附件（图片 / 文档 / 文本）到 Cloudreve，扣配额
// GET  /api/chat-uploads?conversationId=...  → 列出某对话下附件并 touch lastAccessedAt
//
// 路由结构：auth + rate-limit + quota(原子预留) + Cloudreve.upload 骨架，
// 但额外做：MIME 自动分类（image | document | text）、document/text 自动抽文本副本、
// addStorageBytes 扣配额、按 LRU 更新 lastAccessedAt。
//
// 归属校验：用 Conversation.userId（创建时由服务端写入）。userId 命中当前用户才放行；
// userId 为 NULL 的历史无主孤儿一律拒绝（此前的 orphan"宽进"已收紧）。

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { reserveStorageBytes, releaseStorageBytes } from '@/lib/quota';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import { getSiteSettings } from '@/lib/siteSettings';
import { sanitizeHeaderFilename } from '@/lib/security';
import { parseFormDataWithLimit, isUploadedFile } from '@/lib/requestBodyLimit';
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
 * L61：远程文件名的唯一化段长度（hex 字符数）。
 *
 * 此前 remote 名是 `${conversationId}_${safeFileName}` —— **完全确定性、零随机成分**。
 * 同一对话里重传同名文件会得到同一个 cloudrevePath（`CloudreveStorage.upload()`
 * 返回的是本地拼出来的 remotePath，不是服务端实际落盘路径，所以即便 Cloudreve 端
 * 改名/冲突处理了，DB 里两行记的仍是同一个字符串）→ DELETE 其中任一行都会物理删掉
 * 另一行还在用的那个文件，剩下的行变成永久悬空引用（下载/LLM 注入 404）。
 *
 * 6 字节 = 12 hex 字符 = 48 bit 随机，同名重传的碰撞概率可忽略。
 */
const UNIQUE_SEGMENT_HEX_LEN = 12;

/** 生成远程文件名的唯一化段（12 hex）。 */
function makeUniqueSegment(): string {
  return randomBytes(UNIQUE_SEGMENT_HEX_LEN / 2).toString('hex');
}

/**
 * U32：把清洗后的文件名截断到能让 fileName / cloudrevePath / extractedTextPath 三列
 * 都 ≤ VARCHAR(191)。最紧约束是 extractedTextPath：
 *   `/{userId}/chat-uploads/{conversationId}_{unique}_{name}.extracted.txt`
 * 反推出 name 的最大可用长度，仅在超限时截断（尽量保留文件扩展名）。
 *
 * L61 后固定开销多了 `{unique}_`（12 hex + 1 个下划线 = 13 字符），三列上限重新核对过。
 */
function truncateSafeFileName(
  name: string,
  userId: string,
  conversationId: string
): string {
  // 固定开销：`/` + userId + `/chat-uploads/` + conversationId + `_`
  //           + unique + `_` + …name… + `.extracted.txt`
  const fixed =
    1 +
    userId.length +
    '/chat-uploads/'.length +
    conversationId.length +
    1 +
    UNIQUE_SEGMENT_HEX_LEN +
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

  // M29：单次上传大小限制必须在**读 body 之前**就位，因为它同时决定了 body 的内存闸门。
  // 旧写法先 `req.formData()`（整份 body 进内存）再看 file.size，唯一的前置闸是
  // `Number(header ?? '')` —— chunked 请求没有 content-length，`Number('')` 得 0，
  // `Number.isFinite(0)` 真而 `0 > MAX` 假 → 预检整段被跳过，"绝对硬上限"形同虚设。
  const siteSettings = await getSiteSettings();
  const maxBytes = Math.min(
    Math.max(1, siteSettings.chat_files_max_upload_mb) * 1024 * 1024,
    ABSOLUTE_MAX_BYTES
  );
  // multipart 的 boundary/header 开销给 1MB 余量，避免刚好卡在上限的合法文件被误杀。
  const bodyCapBytes = maxBytes + 1024 * 1024;

  // 解析 form data —— 流式累计字节，越线立刻断流（不依赖对端声明的 content-length）。
  const parsed = await parseFormDataWithLimit(req, bodyCapBytes);
  if (!parsed.ok) {
    if (parsed.reason === 'too-large') {
      return NextResponse.json(
        { error: `File too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)` },
        { status: 413 }
      );
    }
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }
  const formData = parsed.value;

  const fileRaw = formData.get('file');
  const conversationIdRaw = formData.get('conversationId');
  const mimeOverrideRaw = formData.get('mimeTypeOverride');

  // L60：`formData.get('file') as File` 只是类型断言。攻击者把 `file` 发成普通字符串
  // 字段时，`.size` 是 undefined —— `size <= 0` 与 `size > maxBytes` 双双为 false，
  // 两道大小检查全绕过，一路走到 try 之外的 `file.arrayBuffer()` 抛 TypeError → 稳定 500。
  if (!isUploadedFile(fileRaw) || typeof conversationIdRaw !== 'string' || !conversationIdRaw) {
    return NextResponse.json(
      { error: 'file and conversationId are required' },
      { status: 400 }
    );
  }
  const file = fileRaw;
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

  // 单次上传大小限制（管理员配置，硬封顶 500MB）——
  // maxBytes 已在读 body 前解析（见上方 M29 注释），这里做精确的单文件校验。
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
  // L61：远程名插入随机段，保证「同对话 + 同文件名」的两次上传落到两个不同的
  // cloudrevePath；否则删掉其中一行会把另一行的物理文件一并删掉。
  // DB 的 fileName 列仍存用户可见的原始名（safeFileName），随机段只进远程路径。
  const composedFileName = `${conversationId}_${makeUniqueSegment()}_${safeFileName}`;

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

  // L65：不要 select cloudrevePath —— 它是服务器内部存储布局（`/{userId}/chat-uploads/...`），
  // 对客户端零用处（AttachmentChipData 只吃 id/fileName/bytes/kind），返回它等于白送
  // 一份用户 id 与目录结构的情报。下载走 /api/chat-uploads/[id] 一类的间接入口，不靠路径。
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
    })),
  });
}
