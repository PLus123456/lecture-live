import { NextResponse } from 'next/server';
import { writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import { requireAdminAccess } from '@/lib/adminApi';
import { sanitizeSvgContent } from '@/lib/svgSanitizer';
import { parseFormDataWithLimit, isUploadedFile } from '@/lib/requestBodyLimit';

// 所有允许的图标扩展名（用于重传换格式时清理旧扩展名的残留文件）
const ALL_ICON_EXTENSIONS = ['.png', '.jpg', '.svg', '.ico', '.webp', '.gif'];

// 允许的图标类型及对应文件名前缀
const ICON_TYPES: Record<string, string> = {
  logo: 'logo',
  favicon: 'favicon',
  icon_medium: 'icon-medium',
  icon_large: 'icon-large',
};

// 允许的图片 MIME 类型
const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/x-icon',
  'image/webp',
  'image/gif',
];

// 最大文件大小: 2MB
const MAX_FILE_SIZE = 2 * 1024 * 1024;

function hasBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((value, index) => buffer[offset + index] === value);
}

function matchesImageSignature(buffer: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case 'image/png':
      return hasBytes(buffer, [0x89, 0x50, 0x4e, 0x47]);
    case 'image/jpeg':
      return hasBytes(buffer, [0xff, 0xd8, 0xff]);
    case 'image/x-icon':
      return hasBytes(buffer, [0x00, 0x00, 0x01, 0x00]);
    case 'image/webp':
      return (
        buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      );
    case 'image/gif':
      return (
        buffer.length >= 6 &&
        ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))
      );
    default:
      return false;
  }
}

// 上传图标文件
export async function POST(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:upload-icon',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  // L59：body 上限靠**流式累计字节**，不靠对端声明的 content-length。
  // 旧写法 `Number(req.headers.get('content-length') ?? '')` 在 chunked 请求下得 0
  // （不是 NaN）→ `Number.isFinite(0)` 真而 `0 > 3MB` 假 → 预检被跳过，
  // `req.formData()` 随后把整个 body 缓冲进内存。multipart 开销给 1MB 余量避免误杀。
  const parsedForm = await parseFormDataWithLimit(req, MAX_FILE_SIZE + 1024 * 1024);
  if (!parsedForm.ok) {
    return parsedForm.reason === 'too-large'
      ? NextResponse.json({ error: '文件大小超过限制 (最大 2MB)' }, { status: 413 })
      : NextResponse.json({ error: '无效的表单数据' }, { status: 400 });
  }

  try {
    const formData = parsedForm.value;
    const fileRaw = formData.get('file');
    // L60（同 chat-uploads）：`as File` 只是类型断言。`file` 字段发成普通字符串时
    // `.type` / `.size` / `.arrayBuffer` 全不存在，会一路走到 `file.type.split` 抛
    // TypeError，被外层 catch 吞成含糊的 500「上传失败」。这里显式判成 400。
    const file = isUploadedFile(fileRaw) ? fileRaw : null;
    const { searchParams } = new URL(req.url);
    const type =
      (typeof formData.get('type') === 'string'
        ? (formData.get('type') as string)
        : searchParams.get('type')) ?? null;

    // 验证 type 参数
    if (!type || !ICON_TYPES[type]) {
      return NextResponse.json(
        { error: `无效的图标类型，允许值: ${Object.keys(ICON_TYPES).join(', ')}` },
        { status: 400 }
      );
    }

    // 验证文件存在
    if (!file) {
      return NextResponse.json({ error: '请上传图片文件' }, { status: 400 });
    }

    const normalizedMimeType = file.type.split(';')[0].trim().toLowerCase();

    // 验证文件类型
    if (!ALLOWED_MIME_TYPES.includes(normalizedMimeType)) {
      return NextResponse.json(
        { error: `不支持的文件类型: ${normalizedMimeType}，允许: png, jpg, svg, ico, webp, gif` },
        { status: 400 }
      );
    }

    // 验证文件大小
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: '文件大小超过限制 (最大 2MB)' },
        { status: 400 }
      );
    }

    // 获取文件扩展名
    const ext = getExtension(normalizedMimeType);
    const fileName = `${ICON_TYPES[type]}${ext}`;

    // 确保目标目录存在
    const iconsDir = path.join(process.cwd(), 'data', 'icons');
    await mkdir(iconsDir, { recursive: true });

    // 将文件写入磁盘
    const rawBuffer = Buffer.from(await file.arrayBuffer());
    const buffer =
      normalizedMimeType === 'image/svg+xml'
        ? Buffer.from(sanitizeSvgContent(rawBuffer.toString('utf-8')), 'utf-8')
        : rawBuffer;

    if (
      normalizedMimeType !== 'image/svg+xml' &&
      !matchesImageSignature(buffer, normalizedMimeType)
    ) {
      return NextResponse.json(
        { error: '文件内容与声明类型不匹配' },
        { status: 400 }
      );
    }
    // G7：写入前清理同一图标前缀但扩展名不同的旧文件，否则重传换格式（如 PNG→SVG）后
    // 旧 logo.png 不再被任何设置引用，却永久残留在 data/icons/（全站无 cron/unlink 兜底）。
    const prefix = ICON_TYPES[type];
    await Promise.all(
      ALL_ICON_EXTENSIONS.filter((otherExt) => otherExt !== ext).map((otherExt) =>
        unlink(path.join(iconsDir, `${prefix}${otherExt}`)).catch(() => undefined)
      )
    );

    const filePath = path.join(iconsDir, fileName);
    await writeFile(filePath, buffer);

    // 返回相对路径（前端可通过此路径访问）
    const relativePath = `/api/assets/icons/${fileName}`;

    return NextResponse.json({
      path: relativePath,
      fileName,
      size: file.size,
      type: normalizedMimeType,
    });
  } catch (err) {
    console.error('上传图标失败:', err);
    return NextResponse.json({ error: '上传失败' }, { status: 500 });
  }
}

// 根据 MIME 类型获取文件扩展名
function getExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/svg+xml':
      return '.svg';
    case 'image/x-icon':
      return '.ico';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.png';
  }
}
