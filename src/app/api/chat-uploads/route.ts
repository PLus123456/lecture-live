// POST /api/chat-uploads   → 上传聊天附件（图片 / 文档 / 文本）到 Cloudreve，扣配额
// GET  /api/chat-uploads?conversationId=...  → 列出某对话下附件并 touch lastAccessedAt
//
// 路由结构：auth + rate-limit + quota(原子预留) + Cloudreve.upload 骨架，
// 但额外做：MIME 自动分类（image | document | text）、document/text 自动抽文本副本、
// addStorageBytes 扣配额、按 LRU 更新 lastAccessedAt。
//
// 归属校验：用 Conversation.userId（创建时由服务端写入）。userId 命中当前用户才放行；
// userId 为 NULL 的历史无主孤儿一律拒绝（此前的 orphan"宽进"已收紧）。

import crypto from 'crypto';
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import { getSiteSettings } from '@/lib/siteSettings';
import { sanitizeHeaderFilename } from '@/lib/security';
import { parseFormDataWithLimit, isUploadedFile } from '@/lib/requestBodyLimit';
import {
  DocumentParserError,
} from '@/lib/documentParserProcess';
import {
  extractTextFromBuffer,
  isExtractableMime,
} from '@/lib/llm/fileExtractor';
import {
  assessChatAttachmentForLlm,
  prepareExtractedTextForLlm,
} from '@/lib/llm/chatAttachmentPolicy';
import { logger, serializeError } from '@/lib/logger';
import {
  STORED_ARTIFACT_TYPE,
  STORED_ARTIFACT_STATE,
  StoredArtifactQuotaExceededError,
  getStoredArtifactById,
  markStoredArtifactOrphan,
  recordReservedStoredArtifactLocation,
  reserveStoredArtifact,
  rollbackStoredArtifact,
  settleStoredArtifactInTransaction,
} from '@/lib/storage/storedArtifactLedger';
import {
  deleteCloudreveAttachmentFiles,
} from '@/lib/storage/cloudreveFileDelete';

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
  // ledger 发布是否已经尝试过（决定失败时走回滚还是保留）。
  let publicationAttempted = false;

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

  // 单次上传大小限制（管理员配置，硬封顶 500MB）
  if (file.size > maxBytes) {
    return NextResponse.json(
      {
        error: `File too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`,
      },
      { status: 413 }
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
  const attachmentId = crypto.randomUUID();

  // 文档 / 文本类：先在内存中抽取，这样能在任何物理写入前对 raw +
  // extracted 两份实际字节各自预留。抽取失败仍保留原文件的旧兼容语义。
  let extractedTextPath: string | null = null;
  let extractedTextPreview: string | null = null;
  let extractedBuffer: Buffer | null = null;
  if (kind === 'document' || kind === 'text') {
    try {
      const extracted = await extractTextFromBuffer(buffer, mt, {
        signal: req.signal,
      });
      extractedTextPreview = extracted.text.slice(0, 500);
      extractedBuffer = Buffer.from(
        prepareExtractedTextForLlm(extracted.text),
        'utf8'
      );
    } catch (err) {
      if (
        req.signal.aborted ||
        (err instanceof DocumentParserError && err.code === 'cancelled')
      ) {
        return NextResponse.json(
          { error: 'Upload cancelled' },
          { status: 499 }
        );
      }
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

  let rawReservation: Awaited<ReturnType<typeof reserveStoredArtifact>>;
  try {
    rawReservation = await reserveStoredArtifact({
      userId: user.id,
      ownerType: 'chat_attachment',
      ownerId: attachmentId,
      conversationId,
      artifactType: STORED_ARTIFACT_TYPE.CHAT_RAW,
      expectedBytes: buffer.byteLength,
      reservationKey: `chat-upload:${attachmentId}:raw`,
    });
  } catch (error) {
    if (error instanceof StoredArtifactQuotaExceededError) {
      return NextResponse.json({ error: 'Storage quota exceeded' }, { status: 403 });
    }
    throw error;
  }

  let extractedReservation: Awaited<ReturnType<typeof reserveStoredArtifact>> | null =
    null;
  if (extractedBuffer && extractedBuffer.byteLength > 0) {
    try {
      extractedReservation = await reserveStoredArtifact({
        userId: user.id,
        ownerType: 'chat_attachment',
        ownerId: attachmentId,
        conversationId,
        artifactType: STORED_ARTIFACT_TYPE.CHAT_EXTRACTED,
        expectedBytes: extractedBuffer.byteLength,
        reservationKey: `chat-upload:${attachmentId}:extracted`,
      });
    } catch (error) {
      if (!(error instanceof StoredArtifactQuotaExceededError)) {
        await rollbackStoredArtifact(rawReservation.id).catch(() => undefined);
        throw error;
      }
      // 抽取副本原本就是 best-effort：额度不足时只不发布该副本，
      // 不能未预留便写盘，也不必拒绝已合法的原文件。
      extractedBuffer = null;
      extractedTextPreview = null;
    }
  }

  let cloudrevePath: string | null = null;
  try {
    const storage = await CloudreveStorage.create();
    cloudrevePath = await storage.upload(
      user.id,
      'chat-uploads',
      composedFileName,
      buffer
    );
    await recordReservedStoredArtifactLocation(rawReservation.id, {
      actualBytes: buffer.byteLength,
      storage: 'cloudreve',
      reference: cloudrevePath,
    });

    if (extractedReservation && extractedBuffer) {
      try {
        const extractedFileName = `${composedFileName}.extracted.txt`;
        extractedTextPath = await storage.upload(
          user.id,
          'chat-uploads',
          extractedFileName,
          extractedBuffer
        );
        await recordReservedStoredArtifactLocation(extractedReservation.id, {
          actualBytes: extractedBuffer.byteLength,
          storage: 'cloudreve',
          reference: extractedTextPath,
        });
      } catch (uploadErr) {
        routeLogger.warn(
          {
            conversationId,
            userId: user.id,
            err: serializeError(uploadErr),
          },
          'chat-uploads: extracted text upload failed; attachment 仍会创建但 extractedTextPath = null'
        );
        let deleted = true;
        if (extractedTextPath) {
          deleted = await deleteCloudreveAttachmentFiles([
            { cloudrevePath: extractedTextPath, extractedTextPath: null },
          ]);
        }
        if (deleted) {
          await rollbackStoredArtifact(extractedReservation.id).catch(
            () => undefined
          );
        } else {
          await markStoredArtifactOrphan(extractedReservation.id).catch(
            () => undefined
          );
        }
        extractedReservation = null;
        extractedTextPath = null;
      }
    }

    // Owner row and both ledger identities publish in one DB transaction. A
    // crash cannot expose a visible UPLOAD row whose RESERVED files are later
    // reclaimed by the TTL worker.
    if (!cloudrevePath) throw new Error('raw attachment upload returned no path');
    const publishedRawPath = cloudrevePath;
    const publishedExtractedPath = extractedTextPath;
    publicationAttempted = true;
    await prisma.$transaction(async (tx) => {
      await tx.chatAttachment.create({
        data: {
          id: attachmentId,
          conversationId,
          userId: user.id,
          kind,
          fileName: safeFileName,
          mimeType: mt,
          bytes: BigInt(file.size),
          cloudrevePath: publishedRawPath,
          extractedTextPath: publishedExtractedPath,
        },
      });
      // 当前工作树共享的 generated client 可能尚未包含新列；用参数化 SQL
      // 将附件与账本行关联，避免为此绕过类型或改共享 node_modules。
      await tx.$executeRaw`
        UPDATE ChatAttachment
        SET storedArtifactId = ${rawReservation.id}, source = 'UPLOAD'
        WHERE id = ${attachmentId}
      `;
      await settleStoredArtifactInTransaction(tx, rawReservation.id, {
        actualBytes: buffer.byteLength,
        storage: 'cloudreve',
        reference: publishedRawPath,
      });
      if (extractedReservation && publishedExtractedPath && extractedBuffer) {
        await settleStoredArtifactInTransaction(tx, extractedReservation.id, {
          actualBytes: extractedBuffer.byteLength,
          storage: 'cloudreve',
          reference: publishedExtractedPath,
        });
      }
    });
  } catch (err) {
    routeLogger.error(
      { conversationId, userId: user.id, err: serializeError(err) },
      'chat-uploads: publish failed'
    );
    let committedAfterReadback = false;
    if (publicationAttempted) {
      try {
        const [rows, rawArtifact, extractedArtifact] = await Promise.all([
          prisma.$queryRaw<
            Array<{
              storedArtifactId: string | null;
              source: string;
              cloudrevePath: string;
              extractedTextPath: string | null;
            }>
          >`
            SELECT storedArtifactId, source, cloudrevePath, extractedTextPath
            FROM ChatAttachment WHERE id = ${attachmentId} LIMIT 1
          `,
          getStoredArtifactById(rawReservation.id),
          extractedReservation
            ? getStoredArtifactById(extractedReservation.id)
            : Promise.resolve(null),
        ]);
        const owner = rows[0] ?? null;
        const rawCommitted =
          owner?.storedArtifactId === rawReservation.id &&
          owner.source === 'UPLOAD' &&
          owner.cloudrevePath === cloudrevePath &&
          rawArtifact?.state === STORED_ARTIFACT_STATE.ACTIVE &&
          rawArtifact.reference === cloudrevePath;
        const extractedCommitted = extractedReservation
          ? owner?.extractedTextPath === extractedTextPath &&
            extractedArtifact?.state === STORED_ARTIFACT_STATE.ACTIVE &&
            extractedArtifact.reference === extractedTextPath
          : true;
        if (rawCommitted && extractedCommitted) {
          committedAfterReadback = true;
          routeLogger.warn(
            { attachmentId, conversationId },
            'chat upload transaction returned failure but readback confirmed commit'
          );
        } else {
          const definitelyNotCommitted =
            owner === null &&
            rawArtifact?.state === STORED_ARTIFACT_STATE.RESERVED &&
            (!extractedReservation ||
              extractedArtifact?.state === STORED_ARTIFACT_STATE.RESERVED);
          if (!definitelyNotCommitted) {
            routeLogger.error(
              { attachmentId, conversationId },
              'chat upload publication outcome unknown; preserving files and reservations'
            );
            return NextResponse.json(
              { error: 'Upload publication status is being reconciled' },
              { status: 503, headers: { 'Retry-After': '30' } }
            );
          }
        }
      } catch (readbackError) {
        routeLogger.error(
          {
            attachmentId,
            conversationId,
            err: serializeError(readbackError),
          },
          'chat upload publication readback failed; preserving files and reservations'
        );
        return NextResponse.json(
          { error: 'Upload publication status is being reconciled' },
          { status: 503, headers: { 'Retry-After': '30' } }
        );
      }
    }
    if (committedAfterReadback) {
      // Owner and both ledger rows are durably visible; treating the lost ACK
      // as failure would delete a live attachment.
    } else {
      let deleted = true;
      if (cloudrevePath) {
        deleted = await deleteCloudreveAttachmentFiles([
          { cloudrevePath, extractedTextPath },
        ]);
      }
      if (deleted) {
        await rollbackStoredArtifact(rawReservation.id).catch(() => undefined);
        if (extractedReservation) {
          await rollbackStoredArtifact(extractedReservation.id).catch(
            () => undefined
          );
        }
      } else {
        await markStoredArtifactOrphan(rawReservation.id).catch(
          () => undefined
        );
        if (extractedReservation) {
          await markStoredArtifactOrphan(extractedReservation.id).catch(
            () => undefined
          );
        }
      }
      return NextResponse.json(
        {
          error: cloudrevePath
            ? 'Failed to record attachment'
            : 'Upload failed',
        },
        { status: 500 }
      );
    }
  }

  const llmPolicy = assessChatAttachmentForLlm({
    kind,
    bytes: file.size,
    hasExtractedText: Boolean(extractedTextPath),
  });

  return NextResponse.json({
    attachmentId,
    cloudrevePath,
    kind,
    bytes: file.size,
    extractedTextPreview,
    fileName: safeFileName,
    llmUsable: llmPolicy.llmUsable,
    llmUnavailableReason: llmPolicy.llmUnavailableReason,
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
    // INLINE 行是历史消息的内部持久对象，不是可重用附件，必须默认隐藏。
    where: { conversationId, source: 'UPLOAD' } as never,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      kind: true,
      bytes: true,
      createdAt: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
  });

  // touch lastAccessedAt 用于 LRU 清理（一次 updateMany 比逐条 update 快得多）
  if (rows.length > 0) {
    try {
      await prisma.chatAttachment.updateMany({
        where: { conversationId, source: 'UPLOAD' } as never,
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
    attachments: rows.map((r) => {
      // 前端要据此显示「该附件不会进 LLM 上下文」的原因（过大 / 未抽出文本等），
      // 不能只回裸元数据，否则用户以为传上去了就一定被读。
      const llmPolicy = assessChatAttachmentForLlm({
        kind: r.kind,
        bytes: r.bytes,
        hasExtractedText: Boolean(r.extractedTextPath),
      });
      return {
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        kind: r.kind,
        bytes: Number(r.bytes),
        createdAt: r.createdAt.toISOString(),
        cloudrevePath: r.cloudrevePath,
        llmUsable: llmPolicy.llmUsable,
        llmUnavailableReason: llmPolicy.llmUnavailableReason,
      };
    }),
  });
}
