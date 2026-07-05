import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';
import { loadSessionAudioArtifact } from '@/lib/sessionPersistence';
import { CloudreveStorage } from '@/lib/storage/cloudreve';

const PLAYBACK_STATUSES = new Set(['COMPLETED', 'ARCHIVED']);

/** 从录音引用的扩展名推断音频 MIME（与 sessionPersistence 的推断保持一致）。 */
function audioContentTypeFromPath(reference: string): string {
  const normalized = reference.toLowerCase();
  return normalized.endsWith('.mp4') || normalized.endsWith('.m4a')
    ? 'audio/mp4'
    : 'audio/webm';
}

// 公开 API：通过分享 token 获取已完成会话的音频（无需认证）
// 严格限流防止流量滥用
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;

  // 限流按分享 token 分桶（而非纯 IP）：音频走 HTTP Range、单个观众一次播放就会产生多次请求，
  // 且同一 NAT 出口的多名观众共享一个公网 IP —— 原来的「10 次/10 分钟/IP」会误封第 11 名及以后的观众。
  // 改为按 token 分桶并放宽额度：既容纳 Range 流式与 NAT 多观众，又把滥用限定在单个分享链接内
  //（拿到 token 者本就有完整访问权，按 token 限流不额外放权）。
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:view:audio',
    limit: 300,
    windowMs: 10 * 60_000,
    key: `share-audio:${rawToken.slice(0, 128)}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  let token: string;
  try {
    token = sanitizeToken(rawToken);
  } catch {
    return Response.json(
      { error: 'Invalid share token' },
      { status: 400, headers: secureHeaders() }
    );
  }

  if (token.length > 128) {
    return Response.json(
      { error: 'Invalid share token' },
      { status: 400, headers: secureHeaders() }
    );
  }

  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      session: {
        select: {
          id: true,
          userId: true,
          status: true,
          recordingPath: true,
          transcriptPath: true,
          summaryPath: true,
        },
      },
    },
  });

  if (!link || (link.expiresAt && link.expiresAt < new Date())) {
    return Response.json(
      { error: 'Share link not found or expired' },
      { status: 404, headers: secureHeaders() }
    );
  }

  // 只有已完成/已归档的会话才能通过此接口获取音频
  if (!PLAYBACK_STATUSES.has(link.session.status)) {
    return Response.json(
      { error: 'Session is not completed yet' },
      { status: 409, headers: secureHeaders() }
    );
  }

  const range = req.headers.get('range');

  // Cloudreve 后端：直接流式透传远程文件体，不把整个录音读进内存（大录音会 OOM）。
  // recordingPath 以 '/' 开头即为 Cloudreve 远程路径；本地文件（local: 前缀）走下方
  // 缓冲分支（从磁盘读取，非 OOM 风险点）。
  // 流式失败时不直接 404，而是落到下方缓冲分支 —— 后者还会尝试本地候选文件，
  // 保持与原有 loadSessionAudioArtifact 回退行为一致。
  const recordingPath = link.session.recordingPath;
  if (recordingPath && recordingPath.startsWith('/')) {
    try {
      const storage = await CloudreveStorage.create();
      const upstream = await storage.openDownloadStream(recordingPath, {
        expectedUserId: link.session.userId,
        range,
      });

      const contentType = audioContentTypeFromPath(recordingPath);
      const headers = new Headers({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      // 透传上游长度 / 断点续传相关头
      for (const name of ['content-length', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value) {
          headers.set(name, value);
        }
      }

      return new Response(upstream.body, {
        status: upstream.status === 206 ? 206 : 200,
        headers,
      });
    } catch (error) {
      // 流式失败（含 416 / 远程节点错误 / 配置缺失）：落到缓冲回退分支
      console.error('Share audio stream error, falling back to buffered load:', error);
    }
  }

  try {
    const artifact = await loadSessionAudioArtifact(link.session);
    if (!artifact) {
      return Response.json(
        { error: 'Audio not found' },
        { status: 404, headers: secureHeaders() }
      );
    }

    const data = artifact.data;
    const totalSize = data.length;

    // 支持 Range 请求（音频流式播放）—— range 已在上方读取
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const rawEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const end = Math.min(rawEnd, totalSize - 1);
        if (
          Number.isNaN(start) ||
          Number.isNaN(end) ||
          start < 0 ||
          end < start ||
          start >= totalSize
        ) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }

        const chunk = data.subarray(start, end + 1);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: {
            'Content-Type': artifact.contentType,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': String(chunk.length),
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          },
        });
      }
    }

    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': artifact.contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    console.error('Share audio load error:', error);
    return Response.json(
      { error: 'Audio not found' },
      { status: 404, headers: secureHeaders() }
    );
  }
}

function secureHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
