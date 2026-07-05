import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { reserveStorageBytes, releaseStorageBytes } from '@/lib/quota';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  assertOwnership,
  parseStorageCategory,
  sanitizeHeaderFilename,
  sanitizeTextInput,
} from '@/lib/security';

// 兜底上限：1GB（防止配置异常值）
const ABSOLUTE_MAX_BYTES = 1024 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'storage:upload',
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 注意：此前用 checkQuota('storage_hours') 作为唯一配额闸门，但 storage_hours =
  // SUM(Session.durationMs)，上传永远不会增加它 —— 相当于对本端点完全不计量，任意
  // 用户可无限写入共享 Cloudreve。真正的字节额度在下方拿到 file.size 后用
  // reserveStorageBytes 原子预留（镜像 chat-uploads），失败再 releaseStorageBytes 回滚。

  try {
    // 从数据库读取管理员配置的最大文件大小（MB），转换为字节
    const siteSettings = await getSiteSettings();
    const maxUploadBytes = Math.min(
      (siteSettings.max_file_size || 500) * 1024 * 1024,
      ABSOLUTE_MAX_BYTES,
    );

    // Content-Length 预检：读 body 前先按声明长度挡掉明显超限的请求，避免把超大 body
    // 整个缓冲进内存才发现超限（应用层限额失效 + OOM 面）。multipart 有额外开销，给 1MB
    // 余量避免误杀；精确的 file.size 校验仍在下方兜底。
    const declaredLength = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes + 1024 * 1024) {
      return NextResponse.json(
        { error: `File size must be between 1 byte and ${maxUploadBytes} bytes` },
        { status: 413 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const categoryInput = formData.get('category');
    const fileNameInput = formData.get('fileName');
    const sessionId = sanitizeTextInput(String(formData.get('sessionId') ?? ''), {
      maxLength: 64,
      fallback: '',
    });

    if (
      !file ||
      typeof categoryInput !== 'string' ||
      typeof fileNameInput !== 'string' ||
      !sessionId
    ) {
      return NextResponse.json(
        { error: 'file, category, fileName, and sessionId are required' },
        { status: 400 }
      );
    }

    if (file.size <= 0 || file.size > maxUploadBytes) {
      return NextResponse.json(
        { error: `File size must be between 1 byte and ${maxUploadBytes} bytes` },
        { status: 400 }
      );
    }

    let category;
    try {
      category = parseStorageCategory(categoryInput);
    } catch {
      return NextResponse.json({ error: 'Invalid storage category' }, { status: 400 });
    }

    const fileName = sanitizeHeaderFilename(fileNameInput);

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    try {
      assertOwnership(user.id, session.userId);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // 配额：原子预留 file.size 字节（条件扣减，杜绝并发击穿）。预留成功后若上传
    // 失败必须 releaseStorageBytes 回滚，避免配额泄漏。ADMIN 视为无限。
    const reserved = await reserveStorageBytes(user.id, file.size);
    if (!reserved) {
      return NextResponse.json(
        { error: 'Storage quota exceeded' },
        { status: 403 }
      );
    }

    let remotePath: string;
    try {
      const storage = await CloudreveStorage.create();
      const data = Buffer.from(await file.arrayBuffer());
      remotePath = await storage.upload(user.id, category, fileName, data);
    } catch (uploadErr) {
      // 上传未成功，回滚预留的字节额度（否则额度泄漏）。
      await releaseStorageBytes(user.id, file.size).catch(() => undefined);
      throw uploadErr;
    }

    return NextResponse.json({ path: remotePath });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed' },
      { status: 500 }
    );
  }
}
