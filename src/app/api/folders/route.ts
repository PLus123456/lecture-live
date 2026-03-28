import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import {
  ensureFolderParentOwnership,
  listFoldersForUser,
  normalizeFolderId,
  normalizeFolderName,
} from '@/lib/folders';

export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const folders = await listFoldersForUser(user.id);
  const response = NextResponse.json(folders);
  // 文件夹列表短时缓存
  response.headers.set('Cache-Control', 'private, max-age=30');
  return response;
}

export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'folders:create',
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = await req.json();
    let name: string;
    try {
      name = normalizeFolderName(body.name);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Folder name is required' },
        { status: 400 }
      );
    }

    const parentId = normalizeFolderId(body.parentId);

    try {
      await ensureFolderParentOwnership(user.id, parentId);
    } catch {
      return NextResponse.json(
        { error: 'Parent folder not found' },
        { status: 404 }
      );
    }

    const existing = await prisma.folder.findFirst({
      where: {
        userId: user.id,
        parentId,
        name,
      },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: 'A folder with the same name already exists here' },
        { status: 409 }
      );
    }

    const folder = await prisma.folder.create({
      data: {
        userId: user.id,
        name,
        parentId,
      },
      select: {
        id: true,
        name: true,
        parentId: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      {
        ...folder,
        createdAt: folder.createdAt.toISOString(),
        sessionCount: 0,
        keywordCount: 0,
        childCount: 0,
        depth: 0,
        path: [folder.name],
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Create folder error:', error);
    return NextResponse.json({ error: 'Failed to create folder' }, { status: 500 });
  }
}
