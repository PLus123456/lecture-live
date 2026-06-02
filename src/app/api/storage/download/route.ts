import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import {
  assertOwnership,
  parseStorageCategory,
  sanitizeHeaderFilename,
  sanitizeTextInput,
} from '@/lib/security';

export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'storage:download',
    limit: 60,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const url = new URL(req.url);
  const categoryInput = url.searchParams.get('category');
  const fileNameInput = url.searchParams.get('fileName');
  const sessionId = sanitizeTextInput(url.searchParams.get('sessionId') ?? '', {
    maxLength: 64,
    fallback: '',
  });

  if (!categoryInput || !fileNameInput || !sessionId) {
    return NextResponse.json(
      { error: 'category, fileName, and sessionId are required' },
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

  try {
    const storage = await CloudreveStorage.create();
    // 流式透传远程文件体，不把整个文件读进内存（大录音会 OOM）
    const range = req.headers.get('range');
    const upstream = await storage.openDownloadStreamByCategory(
      user.id,
      category,
      fileName,
      range
    );

    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    // 透传上游的长度 / 断点续传相关头（若有）
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status === 206 ? 206 : 200,
      headers,
    });
  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Download failed' },
      { status: 500 }
    );
  }
}
