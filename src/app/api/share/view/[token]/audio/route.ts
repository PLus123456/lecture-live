import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sanitizeToken } from '@/lib/security';
import {
  loadSessionAudioArtifact,
  resolveSessionAudioLocation,
  openLocalAudioRangeStream,
} from '@/lib/sessionPersistence';
import { CloudreveStorage } from '@/lib/storage/cloudreve';

const PLAYBACK_STATUSES = new Set(['COMPLETED', 'ARCHIVED']);

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
          enhancedAudioPath: true,
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

  // 音频增强：增强版（响度归一化+降噪）已就绪时分享回放优先播它——分享出去的课堂录音
  // 本就是给人听的，听得清的版本永远是更好的默认。原始录音仍可由 owner 在回放页切换。
  const shareSession = link.session.enhancedAudioPath
    ? { ...link.session, recordingPath: link.session.enhancedAudioPath }
    : link.session;

  // P2-2/P2-3：解析录音物理位置后按位置类型流式取字节，均不把整段录音读进内存（长录音 + 并发
  // Range 会放大内存直至 OOM）：Cloudreve 透传上游 range/stream；本地文件 createReadStream 按 range
  // 流式读。MIME 一律按引用扩展名推断（含 mp3/wav/ogg），修 async 生成的 MP3 在旧代码里被一律标成
  // audio/webm、在 nosniff 下无法播放的问题。流式失败/定位不到时回退到缓冲读取（保留旧候选回退语义）。
  try {
    const location = await resolveSessionAudioLocation(shareSession);

    if (location?.kind === 'cloudreve') {
      try {
        const storage = await CloudreveStorage.create();
        const upstream = await storage.openDownloadStream(location.remotePath, {
          expectedUserId: location.userId,
          range,
        });

        const headers = new Headers({
          'Content-Type': location.contentType,
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

    if (location?.kind === 'local') {
      const totalSize = location.size;
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

          return new Response(
            openLocalAudioRangeStream(location.filePath, { start, end }),
            {
              status: 206,
              headers: {
                'Content-Type': location.contentType,
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Content-Length': String(end - start + 1),
                'Accept-Ranges': 'bytes',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
              },
            }
          );
        }
      }

      return new Response(openLocalAudioRangeStream(location.filePath), {
        headers: {
          'Content-Type': location.contentType,
          'Content-Length': String(totalSize),
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }

    // 回退：Cloudreve 流式失败或无法定位物理文件 → 缓冲读取（含旧候选文件回退语义）。
    const artifact = await loadSessionAudioArtifact(shareSession);
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
