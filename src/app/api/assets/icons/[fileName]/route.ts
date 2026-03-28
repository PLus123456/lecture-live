import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { sanitizePath } from '@/lib/security';

const ICONS_DIR = path.join(process.cwd(), 'data', 'icons');

function resolveContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();

  switch (extension) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fileName: string }> }
) {
  const { fileName } = await params;
  const safeFileName = sanitizePath(path.basename(fileName));
  if (!safeFileName || safeFileName !== fileName) {
    return NextResponse.json({ error: 'Invalid icon path' }, { status: 400 });
  }

  const filePath = path.join(ICONS_DIR, safeFileName);

  try {
    const file = await readFile(filePath);
    const contentType = resolveContentType(safeFileName);

    const response = new NextResponse(new Uint8Array(file), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });

    if (contentType === 'image/svg+xml') {
      response.headers.set(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
      );
    }

    return response;
  } catch {
    return NextResponse.json({ error: 'Icon not found' }, { status: 404 });
  }
}
