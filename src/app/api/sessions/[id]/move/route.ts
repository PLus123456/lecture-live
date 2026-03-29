import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateLibraryApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';

/**
 * POST /api/sessions/[id]/move
 * 将录音移动到指定文件夹，或移出所有文件夹（设 folderId 为 null）。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const folderId =
    typeof body.folderId === 'string' && body.folderId.trim()
      ? body.folderId.trim()
      : null;

  // 如果指定了目标文件夹，检查归属
  if (folderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: folderId, userId: user.id },
      select: { id: true },
    });
    if (!folder) {
      return NextResponse.json(
        { error: 'Target folder not found' },
        { status: 404 }
      );
    }
  }

  // 事务：先删除旧关联，再建立新关联
  await prisma.$transaction(async (tx) => {
    // 移除所有现有文件夹关联
    await tx.folderSession.deleteMany({
      where: { sessionId: id },
    });

    // 如果有目标文件夹，创建新关联
    if (folderId) {
      await tx.folderSession.create({
        data: { folderId, sessionId: id },
      });
    }
  });

  await invalidateLibraryApiCache(user.id);

  return NextResponse.json({
    success: true,
    folderId: folderId ?? null,
  });
}
