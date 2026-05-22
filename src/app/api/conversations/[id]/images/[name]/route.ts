// GET /api/conversations/[id]/images/[name] → 读回某条聊天消息附带的图片。
//
// 图片落在本地磁盘（见 chatImageStorage.ts），content 里存的是这个 URL。
// 仅 conversation 所属用户可读。verifyAuth 同时支持 header 与 cookie，
// 故浏览器 <img> 标签请求（自动带 cookie）也能通过鉴权。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readChatImage } from '@/lib/llm/chatImageStorage';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, name } = await params;

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: { session: { select: { userId: true } } },
  });
  // Conversation.session 可空（纯 chat 对话无录音绑定）；此端点仅服务挂录音的对话。
  if (!conversation || !conversation.session || conversation.session.userId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const image = await readChatImage(id, name);
  if (!image) {
    return NextResponse.json({ error: 'Image not found' }, { status: 404 });
  }

  return new Response(new Uint8Array(image.data), {
    headers: {
      'Content-Type': image.contentType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
