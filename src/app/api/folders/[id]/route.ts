import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  API_RESPONSE_CACHE_TTL,
  buildFoldersApiCacheKey,
  getOrSetApiCache,
  invalidateFoldersApiCache,
} from '@/lib/apiResponseCache';
import {
  ensureFolderParentOwnership,
  getOwnedFolder,
  listFoldersForUser,
  normalizeFolderId,
  normalizeFolderName,
  validateFolderMove,
} from '@/lib/folders';
import { jsonWithCache } from '@/lib/httpCache';

function folderNotFound() {
  return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { value: folderList } = await getOrSetApiCache(
    buildFoldersApiCacheKey(user.id),
    API_RESPONSE_CACHE_TTL.folders,
    () => listFoldersForUser(user.id)
  );
  const detail = folderList.find((item) => item.id === id);

  if (!detail) {
    return folderNotFound();
  }

  return jsonWithCache(req, detail, {
    cacheControl: 'private, no-cache, must-revalidate',
    vary: ['Authorization', 'Cookie'],
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const folder = await getOwnedFolder(id, user.id);
  if (!folder) {
    return folderNotFound();
  }

  try {
    const body = await req.json();
    const nextName = body.name === undefined ? undefined : normalizeFolderName(body.name);
    const nextParentId =
      body.parentId === undefined ? undefined : normalizeFolderId(body.parentId);

    if (nextParentId !== undefined) {
      try {
        await ensureFolderParentOwnership(user.id, nextParentId);
        await validateFolderMove(user.id, folder.id, nextParentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid parent folder';
        return NextResponse.json(
          { error: message },
          { status: message === 'Parent folder not found' ? 404 : 400 }
        );
      }
    }

    if (
      nextName !== undefined ||
      nextParentId !== undefined
    ) {
      const duplicate = await prisma.folder.findFirst({
        where: {
          userId: user.id,
          parentId: nextParentId ?? folder.parentId,
          name: nextName ?? folder.name,
          NOT: { id: folder.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: 'A folder with the same name already exists here' },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.folder.update({
      where: { id: folder.id },
      data: {
        ...(nextName !== undefined && { name: nextName }),
        ...(nextParentId !== undefined && { parentId: nextParentId }),
      },
      select: {
        id: true,
      },
    });

    await invalidateFoldersApiCache(user.id);
    const folderList = await listFoldersForUser(user.id);
    const detail = folderList.find((item) => item.id === updated.id);
    return NextResponse.json(detail ?? { id: updated.id });
  } catch (error) {
    console.error('Update folder error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update folder';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const folder = await getOwnedFolder(id, user.id);
  if (!folder) {
    return folderNotFound();
  }

  if (folder._count.children > 0) {
    return NextResponse.json(
      { error: 'Move or delete child folders before removing this folder' },
      { status: 409 }
    );
  }

  if (folder._count.sessions > 0) {
    return NextResponse.json(
      { error: 'Move or delete the sessions in this folder before removing it' },
      { status: 409 }
    );
  }

  try {
    await prisma.folder.delete({
      where: { id: folder.id },
    });
    await invalidateFoldersApiCache(user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete folder error:', error);
    return NextResponse.json(
      { error: 'Failed to delete folder' },
      { status: 500 }
    );
  }
}
