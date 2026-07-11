import { describe, it, expect } from 'vitest';
import {
  classifyStatusSync,
  isSessionReclaimedResult,
  localRecordingForSession,
  resolveFinalizeOutcome,
  deriveRecoveryMode,
  isActivelyRecording,
  isProtectedRecordingContext,
  shouldPlaybackYieldToLiveStore,
  isRecordingDraftComplete,
} from '../recordingLifecycle';

describe('classifyStatusSync', () => {
  it('2xx → ok', () => {
    expect(classifyStatusSync({ ok: true, status: 200 })).toBe('ok');
  });

  it('400/409（状态迁移冲突=会话已被回收）→ conflict', () => {
    expect(classifyStatusSync({ ok: false, status: 400 })).toBe('conflict');
    expect(classifyStatusSync({ ok: false, status: 409 })).toBe('conflict');
  });

  it('P2-1：401/403 是认证/权限，绝不当成会话被回收', () => {
    expect(classifyStatusSync({ ok: false, status: 401 })).toBe('unauthorized');
    expect(classifyStatusSync({ ok: false, status: 403 })).toBe('forbidden');
  });

  it('404 → not-found（会话已删除，按回收处理）', () => {
    expect(classifyStatusSync({ ok: false, status: 404 })).toBe('not-found');
  });

  it('其它 4xx → rejected 兜底', () => {
    expect(classifyStatusSync({ ok: false, status: 429 })).toBe('rejected');
  });

  it('5xx（服务端临时故障，会话状态未变）→ network-error，不误判回收', () => {
    expect(classifyStatusSync({ ok: false, status: 500 })).toBe('network-error');
    expect(classifyStatusSync({ ok: false, status: 503 })).toBe('network-error');
  });

  it('fetch 抛错（断网）→ network-error，不误判回收', () => {
    expect(classifyStatusSync({ error: true })).toBe('network-error');
  });
});

describe('isSessionReclaimedResult（P2-1）', () => {
  it('只有 conflict / not-found 才算会话被回收', () => {
    expect(isSessionReclaimedResult('conflict')).toBe(true);
    expect(isSessionReclaimedResult('not-found')).toBe(true);
  });

  it('关键回归：401/403/network-error/ok 一律不算回收，杜绝误报', () => {
    expect(isSessionReclaimedResult('unauthorized')).toBe(false);
    expect(isSessionReclaimedResult('forbidden')).toBe(false);
    expect(isSessionReclaimedResult('network-error')).toBe(false);
    expect(isSessionReclaimedResult('rejected')).toBe(false);
    expect(isSessionReclaimedResult('ok')).toBe(false);
  });
});

describe('localRecordingForSession（P0-3 跨会话隔离）', () => {
  it('store 绑定到别的会话 → 本会话视为本地无录音（null），绝不 live-refresh 串数据', () => {
    // 会话 A 正在录音，导航到 B：B 读到的 recordingState 属于 A，必须被过滤成 null
    expect(localRecordingForSession('sess-A', 'sess-B', 'recording')).toBeNull();
    expect(localRecordingForSession('sess-A', 'sess-B', 'paused')).toBeNull();
  });

  it('store 绑定到本会话 → 返回其 recordingState', () => {
    expect(localRecordingForSession('sess-A', 'sess-A', 'recording')).toBe('recording');
    expect(localRecordingForSession('sess-A', 'sess-A', 'paused')).toBe('paused');
  });

  it('向后兼容：store 未绑定（activeSessionId 空）→ 回退信任 recordingState，不回归刷新恢复', () => {
    expect(localRecordingForSession(null, 'sess-B', 'recording')).toBe('recording');
    expect(localRecordingForSession(undefined, 'sess-B', 'paused')).toBe('paused');
  });

  it('配合 deriveRecoveryMode：别会话录音态被过滤后不再 live-refresh', () => {
    // 过滤前（旧行为）：deriveRecoveryMode(true, 'CREATED', 'recording') === 'live-refresh'
    // 过滤后：localRecording 变 null → resume-cold/fresh，不复用 A 的 segments
    const filtered = localRecordingForSession('sess-A', 'sess-B', 'recording');
    expect(deriveRecoveryMode(true, 'CREATED', filtered)).toBe('fresh');
    expect(deriveRecoveryMode(true, 'RECORDING', filtered)).toBe('resume-cold');
  });
});

describe('resolveFinalizeOutcome', () => {
  // ── critical 不变量：只有 'ok' 才允许清空本地缓存 ──
  it('成功且未 alreadyCompleted → ok（可安全清库）', () => {
    expect(resolveFinalizeOutcome(true, { success: true })).toEqual({ kind: 'ok' });
    expect(resolveFinalizeOutcome(true, {})).toEqual({ kind: 'ok' });
  });

  it('alreadyCompleted:true → already-completed（禁止清库）', () => {
    expect(
      resolveFinalizeOutcome(true, { success: true, alreadyCompleted: true })
    ).toEqual({ kind: 'already-completed' });
  });

  it('只认严格布尔 true —— 字符串/真值不算 alreadyCompleted（避免误判为回收）', () => {
    expect(resolveFinalizeOutcome(true, { alreadyCompleted: 'true' })).toEqual({
      kind: 'ok',
    });
    expect(resolveFinalizeOutcome(true, { alreadyCompleted: 1 })).toEqual({
      kind: 'ok',
    });
    expect(resolveFinalizeOutcome(true, { alreadyCompleted: false })).toEqual({
      kind: 'ok',
    });
  });

  it('非 2xx → error，透传服务端 error 文案', () => {
    expect(resolveFinalizeOutcome(false, { error: 'Session not found' })).toEqual({
      kind: 'error',
      message: 'Session not found',
    });
  });

  it('非 2xx 且无 error 字段 → error（message undefined，调用方回退默认文案）', () => {
    expect(resolveFinalizeOutcome(false, {})).toEqual({
      kind: 'error',
      message: undefined,
    });
  });

  it('body 非对象（null / 字符串）不崩溃', () => {
    expect(resolveFinalizeOutcome(true, null)).toEqual({ kind: 'ok' });
    expect(resolveFinalizeOutcome(true, 'weird')).toEqual({ kind: 'ok' });
    expect(resolveFinalizeOutcome(false, null)).toEqual({
      kind: 'error',
      message: undefined,
    });
  });

  it('关键回归：ok=false 时即使带 alreadyCompleted 也走 error，绝不清库', () => {
    // 防御性：!ok 优先于 alreadyCompleted 判定，异常响应一律不清库
    const outcome = resolveFinalizeOutcome(false, { alreadyCompleted: true });
    expect(outcome.kind).toBe('error');
  });
});

describe('deriveRecoveryMode', () => {
  it('后端 status 未拉回 → pending（任何恢复/清除都不动）', () => {
    expect(deriveRecoveryMode(false, 'RECORDING', 'recording')).toBe('pending');
    expect(deriveRecoveryMode(false, null, null)).toBe('pending');
  });

  it('后端终态 → terminal', () => {
    expect(deriveRecoveryMode(true, 'COMPLETED', 'recording')).toBe('terminal');
    expect(deriveRecoveryMode(true, 'ARCHIVED', 'paused')).toBe('terminal');
  });

  it('后端 FINALIZING → finalizing（挂遮罩，绝不开麦）', () => {
    expect(deriveRecoveryMode(true, 'FINALIZING', 'recording')).toBe('finalizing');
  });

  it('后端在录 + 本地也在录 → live-refresh；本地无录音态 → resume-cold', () => {
    expect(deriveRecoveryMode(true, 'RECORDING', 'recording')).toBe('live-refresh');
    expect(deriveRecoveryMode(true, 'PAUSED', 'paused')).toBe('live-refresh');
    expect(deriveRecoveryMode(true, 'RECORDING', 'idle')).toBe('resume-cold');
    expect(deriveRecoveryMode(true, 'PAUSED', null)).toBe('resume-cold');
  });

  it('关键回归：后端 status 未知（GET 失败/无 status）且本地在录 → live-refresh 兜底，不误判 fresh', () => {
    // 一次网络抖动不能把进行中的会话当新会话，否则后续开录会清除覆盖
    expect(deriveRecoveryMode(true, null, 'recording')).toBe('live-refresh');
    expect(deriveRecoveryMode(true, undefined, 'paused')).toBe('live-refresh');
  });

  it('后端 status 未知且本地不在录 → fresh（真新会话）', () => {
    expect(deriveRecoveryMode(true, null, 'idle')).toBe('fresh');
    expect(deriveRecoveryMode(true, null, null)).toBe('fresh');
  });

  it('CREATED（新会话）本地不在录 → fresh；本地异常在录 → 优先保护 live-refresh', () => {
    expect(deriveRecoveryMode(true, 'CREATED', 'idle')).toBe('fresh');
    expect(deriveRecoveryMode(true, 'CREATED', 'recording')).toBe('live-refresh');
  });
});

describe('isActivelyRecording', () => {
  it('仅 recording 为 true（麦克风开着）', () => {
    expect(isActivelyRecording('recording')).toBe(true);
  });
  it('paused / stopped / idle / 空 → false（可去看回放，靠 resume-cold 兜底）', () => {
    expect(isActivelyRecording('paused')).toBe(false);
    expect(isActivelyRecording('stopped')).toBe(false);
    expect(isActivelyRecording('idle')).toBe(false);
    expect(isActivelyRecording(null)).toBe(false);
    expect(isActivelyRecording(undefined)).toBe(false);
  });
});

// P1-8：paused/finalizing 也算受保护上下文，回放页不得清空活跃 store。
describe('isProtectedRecordingContext（P1-8）', () => {
  it('recording / paused / finalizing 三态都受保护 → true', () => {
    expect(isProtectedRecordingContext('recording')).toBe(true);
    // 旧的 isActivelyRecording 对 paused 返回 false，这里必须为 true（负向锚点）
    expect(isProtectedRecordingContext('paused')).toBe(true);
    expect(isProtectedRecordingContext('finalizing')).toBe(true);
  });
  it('idle / stopped / 空 → false（可正常同步历史）', () => {
    expect(isProtectedRecordingContext('idle')).toBe(false);
    expect(isProtectedRecordingContext('stopped')).toBe(false);
    expect(isProtectedRecordingContext(null)).toBe(false);
    expect(isProtectedRecordingContext(undefined)).toBe(false);
  });
});

describe('shouldPlaybackYieldToLiveStore（P1-8 / P0-3 按 sessionId 隔离）', () => {
  it('本会话 recording/paused/finalizing → 让位（旧行为会清空导致丢未上传尾块）', () => {
    expect(shouldPlaybackYieldToLiveStore('sess-a', 'sess-a', 'recording')).toBe(true);
    expect(shouldPlaybackYieldToLiveStore('sess-a', 'sess-a', 'paused')).toBe(true);
    expect(shouldPlaybackYieldToLiveStore('sess-a', 'sess-a', 'finalizing')).toBe(true);
  });
  it('未绑定的旧数据（activeSessionId 空）+ 受保护态 → 让位（向后兼容）', () => {
    expect(shouldPlaybackYieldToLiveStore(null, 'sess-a', 'recording')).toBe(true);
    expect(shouldPlaybackYieldToLiveStore(undefined, 'sess-a', 'paused')).toBe(true);
  });
  it('P0-3 关键回归：store 绑定到别的会话 → **不让位**，回放 B 绝不被 A 的 live store 挡住（跨会话泄漏/丢历史）', () => {
    expect(shouldPlaybackYieldToLiveStore('sess-b', 'sess-a', 'recording')).toBe(false);
    expect(shouldPlaybackYieldToLiveStore('sess-b', 'sess-a', 'paused')).toBe(false);
    expect(shouldPlaybackYieldToLiveStore('sess-b', 'sess-a', 'finalizing')).toBe(false);
  });
  it('idle/stopped → 不让位，回放页可正常灌历史', () => {
    expect(shouldPlaybackYieldToLiveStore(null, 'sess-a', 'idle')).toBe(false);
    expect(shouldPlaybackYieldToLiveStore('sess-a', 'sess-a', 'stopped')).toBe(false);
  });
});

// P0-5 契约2：完整性用「集合包含 [0..maxSeq]」而非数量比较。
describe('isRecordingDraftComplete（P0-5）', () => {
  it('审计反例 local=[0,1] / remote=[0,9]：数量相等但缺 seq 1 → 不完整（旧数量逻辑会误判完整）', () => {
    expect(isRecordingDraftComplete([0, 1], [0, 9])).toBe(false);
  });
  it('leading gap：local=[1,2] / remote=[1,2] 缺 seq 0 → 不完整', () => {
    expect(isRecordingDraftComplete([1, 2], [1, 2])).toBe(false);
  });
  it('内部缺口：local=[0,1,2] / remote=[0,2] 缺 seq 1 → 不完整', () => {
    expect(isRecordingDraftComplete([0, 1, 2], [0, 2])).toBe(false);
  });
  it('完整：local=[0,1,2] / remote 覆盖 [0..2]（含多余高位）→ 完整', () => {
    expect(isRecordingDraftComplete([0, 1, 2], [0, 1, 2, 9])).toBe(true);
    expect(isRecordingDraftComplete([0, 1], new Set([0, 1]))).toBe(true);
  });
  it('续录尾段 local=[5,6,7] 但 remote 覆盖 [0..7]（前段由别的设备上传）→ 完整', () => {
    expect(
      isRecordingDraftComplete([5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7])
    ).toBe(true);
  });
  it('本地为空 → 视为完整（无需保护的空录音）', () => {
    expect(isRecordingDraftComplete([], [])).toBe(true);
  });
});
