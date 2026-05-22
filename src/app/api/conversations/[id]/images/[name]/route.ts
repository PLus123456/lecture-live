// GET /api/conversations/[id]/images/[name] → 读回某条聊天消息附带的图片。
//
// 图片落在本地磁盘（见 chatImageStorage.ts），content 里存的是这个 URL。
// 仅 conversation 所属用户可读。verifyAuth 同时支持 header 与 cookie，
// 故浏览器 <img> 标签请求（自动带 cookie）也能通过鉴权。
// 所有权用 assertConversationOwnership 统一判定（兼容全局对话）。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import {
  assertConversationOwnership,
  ownershipErrorResponse,
} from '@/lib/conversations';
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

  try {
    await assertConversationOwnership(id, user.id);
  } catch (err) {
    // 不暴露资源是否存在：所有非授权访问统一回 404
    const mapped = ownershipErrorResponse(err, { collapseForbiddenTo404: true });
    if (mapped) return mapped;
    throw err;
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
