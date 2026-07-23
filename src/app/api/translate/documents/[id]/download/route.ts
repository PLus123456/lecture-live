import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readOutputFile, readSourceFile } from '@/lib/translate/taskStorage';

export const runtime = 'nodejs';

/**
 * GET /api/translate/documents/[id]/download?variant=mono|dual|source[&inline=1]
 * 下载/在线预览产物 PDF。inline=1 时浏览器内嵌预览（双语对照在线看）。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const url = new URL(req.url);
  const variantRaw = url.searchParams.get('variant') ?? 'mono';
  const inline = url.searchParams.get('inline') === '1';
  if (!['mono', 'dual', 'source'].includes(variantRaw)) {
    return NextResponse.json({ error: 'variant 非法' }, { status: 400 });
  }

  const task = await prisma.translationTask.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      fileName: true,
      targetLang: true,
      monoPath: true,
      dualPath: true,
    },
  });
  if (!task || task.userId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let data: Buffer | null = null;
  let suffix = '';
  if (variantRaw === 'source') {
    data = await readSourceFile(id);
    suffix = '';
  } else {
    if (task.status !== 'COMPLETED') {
      return NextResponse.json({ error: '翻译尚未完成' }, { status: 409 });
    }
    if (variantRaw === 'mono' && !task.monoPath) {
      return NextResponse.json({ error: '单语产物不存在' }, { status: 404 });
    }
    if (variantRaw === 'dual' && !task.dualPath) {
      return NextResponse.json({ error: '双语产物不存在' }, { status: 404 });
    }
    data = await readOutputFile(id, variantRaw as 'mono' | 'dual');
    suffix = variantRaw === 'mono' ? `.${task.targetLang}` : `.${task.targetLang}.dual`;
  }
  if (!data) {
    return NextResponse.json({ error: '文件不存在或已清理' }, { status: 404 });
  }

  const base = task.fileName.replace(/\.pdf$/i, '');
  const downloadName = `${base}${suffix}.pdf`;
  // RFC 5987 编码中文文件名
  const encoded = encodeURIComponent(downloadName).replace(/['()]/g, escape);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(data.length),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
