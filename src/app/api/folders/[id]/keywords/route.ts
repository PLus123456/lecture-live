// v2.1 §D: Folder keyword pool management API
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateFoldersApiCache } from '@/lib/apiResponseCache';
import {
  getFolderKeywords,
  addManualKeyword,
  removeKeyword,
} from '@/lib/llm/folderKeywords';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify folder ownership
  const folder = await prisma.folder.findUnique({ where: { id: id } });
  if (!folder || folder.userId !== user.id) {
    return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
  }

  const keywords = await getFolderKeywords(id);
  return NextResponse.json(keywords);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const folder = await prisma.folder.findUnique({ where: { id: id } });
  if (!folder || folder.userId !== user.id) {
    return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
  }

  const body = await req.json();
  const keyword = body.keyword?.trim();
  if (!keyword) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 });
  }

  // 安全：关键词长度限制
  const MAX_KEYWORD_LENGTH = 200;
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return NextResponse.json(
      { error: `关键词长度不能超过 ${MAX_KEYWORD_LENGTH} 个字符` },
      { status: 400 }
    );
  }

  // 安全：每文件夹关键词数量上限
  const MAX_KEYWORDS_PER_FOLDER = 100;
  const existing = await getFolderKeywords(id);
  if (existing.length >= MAX_KEYWORDS_PER_FOLDER) {
    return NextResponse.json(
      { error: `每个文件夹最多 ${MAX_KEYWORDS_PER_FOLDER} 个关键词` },
      { status: 400 }
    );
  }

  const result = await addManualKeyword(id, keyword);
  await invalidateFoldersApiCache(user.id);
  return NextResponse.json(result, { status: 201 });
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

  const folder = await prisma.folder.findUnique({ where: { id: id } });
  if (!folder || folder.userId !== user.id) {
    return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const keyword = searchParams.get('keyword');
  if (!keyword) {
    return NextResponse.json({ error: 'keyword param required' }, { status: 400 });
  }

  await removeKeyword(id, keyword);
  await invalidateFoldersApiCache(user.id);
  return NextResponse.json({ success: true });
}
