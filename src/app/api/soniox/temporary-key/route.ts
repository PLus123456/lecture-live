import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  ensureActiveInterpretSession,
  settleInterpretSessionAsVoid,
} from '@/lib/interpret/session';
import { resolveUserMaxConcurrentSessions } from '@/lib/userRoles';
import {
  countActiveStreamGrants,
  createStreamGrantWithReservation,
  rollbackStreamGrant,
  type StreamGrantKind,
} from '@/lib/soniox/streamGrant';
import {
  parseSonioxRegionPreference,
  resolveRequestedRegionAsync,
  resolveSonioxRuntimeConfigAsync,
} from '@/lib/soniox/env';

// key TTL：只授权「拿 key → 建立连接」这一步，窗口越短越好。连接建立后的串流时长由
// max_session_duration_seconds 管（与 TTL 无关——实测 key 过期不断已建立的连接）。
const KEY_EXPIRES_IN_SECONDS = 60;

/**
 * POST /api/soniox/temporary-key —— R1-L1/L2：mint 即计费闸门。
 *
 * 浏览器直连 Soniox 串流，本端点是服务端唯一必经点。旧实现只发 key 不设限，单连接可串流
 * 数小时且服务端全程不可见（B3/R1 白嫖洞）。现在每次签发：
 *  1. 原子预扣 min(D=15min, 剩余额度)（收缩式；剩 0 → 403），落一行 SonioxStreamGrant 台账；
 *  2. key 带 max_session_duration_seconds=预扣分钟 —— 到点 Soniox 服务端硬断连（实测生效），
 *     单 key 可串流量恒 ≤ 已预扣量；续流必须回来 re-mint 再预扣 → 白嫖收益=0；
 *  3. single_use —— 一 key 一连接，堵「预扣一份并发开 N 条流」（实测第二条连接 401）；
 *  4. client_reference_id 由服务端构造（kind:userId:grantId，客户端不可控）——每条流在
 *     Soniox /v1/usage-logs 留下可归属记录（实测暴力断连也入账），供 usage cron 精确对账：
 *     正常收尾按实结算退差、孤儿有用量转实扣、key 没用过退预扣。
 *
 * 流量护栏：IP 粗限流（鉴权前，挡匿名刷）＋按 user 细限流＋并发活跃 grant 上限（保护我们
 * 在 Soniox 的组织级配额，也掐死脚本高频 mint）。
 */
export async function POST(req: Request) {
  const ipLimited = await enforceRateLimit(req, {
    scope: 'soniox:temporary-key',
    limit: 30,
    windowMs: 60_000,
  });
  if (ipLimited) {
    return ipLimited;
  }

  // JWT 鉴权
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 按 user 细限流：正常客户端每条流每 D 分钟 1 次 mint + 断线重连纠偏，12/min 给足重连
  // 风暴余量；真人操作到不了这个频率。IP 限流对 NAT 后的多用户偏松，这层才是个人配额。
  const userLimited = await enforceRateLimit(req, {
    scope: 'soniox:temporary-key:user',
    limit: 12,
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (userLimited) {
    return userLimited;
  }

  const body = (await req.json().catch(() => ({}))) as {
    region?: string;
    kind?: string;
    sessionId?: string;
    anchorId?: string;
    clientReferenceId?: string;
  };
  const requestedRegion = parseSonioxRegionPreference(body.region) ?? 'auto';

  // 流归属解析。新协议：{ kind: 'realtime', sessionId } / { kind: 'interpret' }。
  // 旧协议兼容（发版瞬间仍在线的旧页面）：clientReferenceId 恒为 'interpret:<a>:<b>'（useInterpret）
  // 或 sessionId（useSoniox），据此推断。两者皆无 → 400：不再签发无归属的 key（无归属=无结算路径，
  // 只能靠 usage cron 兜底，能挡在门口就不放进来）。
  let kind: StreamGrantKind | null = null;
  let sessionId: string | null = null;
  if (body.kind === 'realtime' || body.kind === 'interpret') {
    kind = body.kind;
    sessionId =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim().slice(0, 64)
        : null;
  } else if (
    typeof body.clientReferenceId === 'string' &&
    body.clientReferenceId.trim()
  ) {
    const legacy = body.clientReferenceId.trim();
    if (legacy.startsWith('interpret:')) {
      kind = 'interpret';
    } else {
      kind = 'realtime';
      sessionId = legacy.slice(0, 64);
    }
  }
  if (!kind) {
    return NextResponse.json(
      { error: 'Missing stream kind (expected { kind, sessionId? })' },
      { status: 400 }
    );
  }

  // realtime 必须锚定一个属于本人、未终态的真实会话——finalize/reclaim 链路就是它的结算路径。
  // 假/他人/已完结的 sessionId 一律拒（旧洞：任意字符串都放行，假 session 串流只能白嫖）。
  if (kind === 'realtime') {
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Missing sessionId for realtime stream' },
        { status: 400 }
      );
    }
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (!['CREATED', 'RECORDING', 'PAUSED'].includes(session.status)) {
      return NextResponse.json(
        { error: 'Session is not active' },
        { status: 409 }
      );
    }
  }

  // 并发活跃 grant 上限：realtime+interpret 各占一路 × 角色并发上限，+1 轮换重叠余量。
  // 防脚本囤 key 并发多开（预扣是量闸，这是流数闸），也保护组织级 Soniox 并发连接配额。
  const owner = await prisma.user.findUnique({
    where: { id: user.id },
    select: { customGroupId: true },
  });
  const maxConcurrent = await resolveUserMaxConcurrentSessions({
    role: user.role,
    customGroupId: owner?.customGroupId ?? null,
  });
  const grantCap = maxConcurrent * 2 + 1;
  const activeGrants = await countActiveStreamGrants(user.id);
  if (activeGrants >= grantCap) {
    return NextResponse.json(
      {
        error: `Too many concurrent transcription streams (max ${grantCap}). Close an existing stream first.`,
      },
      { status: 429 }
    );
  }

  const resolvedRegion = await resolveRequestedRegionAsync(requestedRegion, req.headers);
  const sonioxConfig = await resolveSonioxRuntimeConfigAsync({
    requestedRegion,
    headers: req.headers,
  });
  if (!sonioxConfig) {
    return NextResponse.json(
      { error: 'Soniox credentials not configured' },
      { status: 500 }
    );
  }

  // interpret：预扣前先保证有活锚点（/start 建的或此处补建），grant 关联它 —— deduct/cron 结算
  // 锚点时一并结算其 grants。客户端带了 /start 返回的 anchorId 时精确关联（多标签页并发同传时
  // 「复用最近活锚点」的启发式会挂错场，anchorId 消除歧义）；没带或查不到（伪造/DB 曾建行失败）
  // 退回 ensure 启发式。补建失败（DB 抖动）不阻塞：grant 无锚点关联，孤儿交给 usage cron。
  let interpretSessionId: string | null = null;
  let interpretAnchorCreated = false;
  if (kind === 'interpret') {
    const bodyAnchorId =
      typeof body.anchorId === 'string' ? body.anchorId.trim().slice(0, 64) : '';
    if (bodyAnchorId) {
      const anchored = await prisma.interpretSession
        .findFirst({
          where: { anchorId: bodyAnchorId, userId: user.id, settledAt: null },
          orderBy: { startedAt: 'desc' },
          select: { id: true },
        })
        .catch(() => null);
      interpretSessionId = anchored?.id ?? null;
    }
    if (!interpretSessionId) {
      const ensured = await ensureActiveInterpretSession(user.id);
      interpretSessionId = ensured.id;
      interpretAnchorCreated = ensured.created;
    }
  }

  // 原子预扣 + 落 grant 台账。额度剩 0 → 403（与旧 checkQuota 拒绝语义一致，前端已处理）。
  // 收缩式：剩 3 分钟给 3 分钟的 key（max_session 同步收缩）——额度从「事后超扣」变成实时强制。
  let grant: Awaited<ReturnType<typeof createStreamGrantWithReservation>>;
  try {
    grant = await createStreamGrantWithReservation({
      userId: user.id,
      kind,
      sessionId: kind === 'realtime' ? sessionId : null,
      interpretSessionId,
      region: sonioxConfig.region,
    });
  } catch (error) {
    console.error('Stream grant reservation error:', error);
    if (interpretAnchorCreated && interpretSessionId) {
      await settleInterpretSessionAsVoid(interpretSessionId, 'mint_failed');
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
  if (!grant.ok) {
    // 本次新建的空锚点一并作废，防 cron 7h 后按墙钟对「从未串流的锚点」误扣。
    if (interpretAnchorCreated && interpretSessionId) {
      await settleInterpretSessionAsVoid(interpretSessionId, 'mint_failed');
    }
    if (grant.reason === 'quota_exhausted') {
      return NextResponse.json({ error: 'Quota exceeded' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const response = await fetch(
      `${sonioxConfig.restBaseUrl}/v1/auth/temporary-api-key`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sonioxConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          usage_type: 'transcribe_websocket',
          expires_in_seconds: KEY_EXPIRES_IN_SECONDS,
          // 单连接串流硬上限 = 本次预扣量。到点 Soniox 服务端断连（403 temp_api_key_session_expired），
          // 客户端不可绕过；诚实客户端在到点前主动平滑轮换（见 useSoniox/useInterpret）。
          max_session_duration_seconds: grant.maxSessionSeconds,
          // 一 key 一连接：同 key 第二条连接 401（实测），杜绝「预扣一份、并发开 N 条流」。
          single_use: true,
          // 服务端构造、客户端不可控。usage-logs 按它把每条流归属到 user+grant（对账/退款/补扣的键）。
          client_reference_id: `${kind === 'interpret' ? 'it' : 'rt'}:${user.id}:${grant.grantId}`,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      // 安全：仅记录状态码，避免完整错误响应中可能包含的敏感信息
      console.error(`Soniox API error: status=${response.status}`, errorText.slice(0, 200));
      // 签发失败 = 客户端拿不到 key、不可能串流：立即退预扣（settledBy=mint_failed），
      // 空锚点一并作废。回滚失败不阻塞（usage cron 查无用量会 usage_refund 兜底退）。
      await rollbackStreamGrant(grant.grantId);
      if (interpretAnchorCreated && interpretSessionId) {
        await settleInterpretSessionAsVoid(interpretSessionId, 'mint_failed');
      }
      return NextResponse.json(
        { error: 'Failed to get temporary key' },
        { status: response.status }
      );
    }

    const data = await response.json();

    return NextResponse.json({
      ...data,
      ws_url: sonioxConfig.wsBaseUrl,
      ws_base_url: sonioxConfig.wsBaseUrl,
      rest_base_url: sonioxConfig.restBaseUrl,
      region: sonioxConfig.region,
      requested_region: requestedRegion,
      resolved_region: resolvedRegion,
      // 客户端据此在到点前主动平滑轮换连接（提前量见 useSoniox/useInterpret），避免被硬断丢
      // 最后几秒未 final 的字（实测硬断时最后 ~5s 音频不出 final token）。
      max_session_duration_seconds: grant.maxSessionSeconds,
    });
  } catch (error) {
    console.error('Temporary key error:', error);
    await rollbackStreamGrant(grant.grantId);
    if (interpretAnchorCreated && interpretSessionId) {
      await settleInterpretSessionAsVoid(interpretSessionId, 'mint_failed');
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
