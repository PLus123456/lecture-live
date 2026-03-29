import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { checkQuota } from '@/lib/quota';
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

  const quotaOk = await checkQuota(user.id, 'storage_hours');
  if (!quotaOk) {
    return NextResponse.json(
      { error: 'Storage quota exceeded' },
      { status: 403 }
    );
  }

  try {
    // 从数据库读取管理员配置的最大文件大小（MB），转换为字节
    const siteSettings = await getSiteSettings();
    const maxUploadBytes = Math.min(
      (siteSettings.max_file_size || 500) * 1024 * 1024,
      ABSOLUTE_MAX_BYTES,
    );

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

    const storage = await CloudreveStorage.create();
    const data = Buffer.from(await file.arrayBuffer());
    const remotePath = await storage.upload(user.id, category, fileName, data);

    return NextResponse.json({ path: remotePath });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed' },
      { status: 500 }
    );
  }
}
