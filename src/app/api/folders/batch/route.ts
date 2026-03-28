import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';

/**
 * DELETE /api/folders/batch
 * 批量删除文件夹（仅空文件夹可删除）
 * body: { ids: string[] }
 */
export async function DELETE(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'folders:batch-delete',
    limit: 20,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = await req.json();
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === 'string') : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: 'No folder IDs provided' }, { status: 400 });
    }

    // 验证所有文件夹归属
    const folders = await prisma.folder.findMany({
      where: { id: { in: ids }, userId: user.id },
      select: {
        id: true,
        name: true,
        _count: { select: { children: true, sessions: true } },
      },
    });

    const ownedIds = new Set(folders.map((f) => f.id));
    const notFound = ids.filter((id: string) => !ownedIds.has(id));
    if (notFound.length > 0) {
      return NextResponse.json(
        { error: `Folders not found: ${notFound.join(', ')}` },
        { status: 404 }
      );
    }

    // 检查哪些可以删除
    const blocked: string[] = [];
    const deletable: string[] = [];
    for (const f of folders) {
      if (f._count.children > 0 || f._count.sessions > 0) {
        blocked.push(f.name);
      } else {
        deletable.push(f.id);
      }
    }

    if (deletable.length > 0) {
      await prisma.folder.deleteMany({
        where: { id: { in: deletable } },
      });
    }

    return NextResponse.json({
      deleted: deletable.length,
      blocked,
    });
  } catch (error) {
    console.error('Batch delete folders error:', error);
    return NextResponse.json(
      { error: 'Failed to delete folders' },
      { status: 500 }
    );
  }
}
