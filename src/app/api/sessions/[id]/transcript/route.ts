import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  invalidateFoldersApiCache,
  invalidateSessionsApiCache,
} from '@/lib/apiResponseCache';
import { assertOwnership, assertSessionReadAccess } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import { callLLM } from '@/lib/llm/gateway';
import { extractAndAccumulateKeywords } from '@/lib/llm/folderKeywords';
import { validatePersistedTranscriptBundle } from '@/lib/sessionApi';
import {
  extractTranscriptText,
  loadSessionTranscriptBundle,
  persistSessionTranscriptArtifacts,
} from '@/lib/sessionPersistence';
import {
  deleteTranscriptDraft,
  loadTranscriptDraft,
} from '@/lib/transcriptDraftPersistence';
import { invalidateRagCache } from '@/lib/llm/embedding/transcriptRag';

// Save transcript + summary data
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:transcript-save',
    limit: 30,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
    include: {
      folders: {
        select: {
          folderId: true,
        },
      },
    },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // G2：终态会话不得再被覆写转录。已 COMPLETED/ARCHIVED 会话的转录被回放/导出引用，
  // 且转录里的 globalEndMs 会经 audio 路由派生进 durationMs（存储小时用量），禁止篡改。
  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return NextResponse.json(
      { error: 'Cannot overwrite transcript of a finalized session' },
      { status: 409 }
    );
  }

  try {
    const body = await req.json();
    let bundle = validatePersistedTranscriptBundle(body);

    // 如果客户端提交的 segments 为空，尝试从服务端草稿恢复
    if (!bundle || bundle.segments.length === 0) {
      const draft = await loadTranscriptDraft(session);
      if (draft && draft.segments.length > 0) {
        bundle = {
          segments: draft.segments,
          summaries: bundle?.summaries?.length ? bundle.summaries : draft.summaries,
          translations: Object.keys(bundle?.translations ?? {}).length > 0
            ? bundle!.translations
            : draft.translations,
        };
      }
    }

    if (!bundle) {
      return NextResponse.json(
        { error: 'Invalid transcript payload' },
        { status: 400 }
      );
    }

    const stored = await persistSessionTranscriptArtifacts(session, bundle);
    const fullTranscript = extractTranscriptText(bundle);
    const folderIds = session.folders.map((entry) => entry.folderId);

    const keywordResults = await Promise.all(
      folderIds.map(async (folderId) => {
        try {
          const added = await extractAndAccumulateKeywords(
            session.id,
            folderId,
            fullTranscript,
            callLLM
          );
          return { folderId, added };
        } catch (error) {
          console.error('Keyword accumulation error:', error);
          return { folderId, added: [] as string[] };
        }
      })
    );

    await prisma.session.update({
      where: { id: id },
      data: {
        transcriptPath: stored.transcript.path,
        summaryPath: stored.summary.path,
      },
    });
    await Promise.all([
      invalidateSessionsApiCache(user.id),
      invalidateFoldersApiCache(user.id),
    ]);

    // 转录被改写（纠错/重转写）后主动失效 RAG 缓存：既清该 session 的单录音 entry，
    // 也清所有引用了该录音的 multi-recording entry（invalidateRagCache 内部同时处理两者），
    // 避免全局/单录音对话继续检索到改写前的旧文本（v3 finding U76 后半）。
    invalidateRagCache(session.id);

    // 转录稿已永久保存，删除草稿临时文件
    try {
      await deleteTranscriptDraft(session);
    } catch {
      // 清理失败不影响响应
    }

    return NextResponse.json({
      success: true,
      transcriptPath: stored.transcript.path,
      summaryPath: stored.summary.path,
      storage: stored.transcript.storage,
      keywordsAdded: keywordResults.reduce(
        (total, entry) => total + entry.added.length,
        0
      ),
    });
  } catch (error) {
    console.error('Save transcript error:', error);
    return NextResponse.json(
      { error: 'Failed to save transcript' },
      { status: 500 }
    );
  }
}

// Load transcript + summary data
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    const { isCrossUserAdmin } = assertSessionReadAccess(user, session.userId);
    if (isCrossUserAdmin) {
      logAction(req, 'admin.session.transcript.read', {
        user,
        detail: `读取他人转录 (sessionId=${id}, owner=${session.userId})`,
      });
    }
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  try {
    const data = await loadSessionTranscriptBundle(session);
    if (!data) {
      return NextResponse.json({ segments: [], summaries: [], translations: {} });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('Load transcript error:', error);
    // No transcript file yet — return empty
    return NextResponse.json({ segments: [], summaries: [], translations: {} });
  }
}
