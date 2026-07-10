import { describe, it, expect } from 'vitest';
import {
  classifyStatusSync,
  resolveFinalizeOutcome,
  deriveRecoveryMode,
  isActivelyRecording,
} from '../recordingLifecycle';

describe('classifyStatusSync', () => {
  it('2xx → ok', () => {
    expect(classifyStatusSync({ ok: true, status: 200 })).toBe('ok');
  });

  it('4xx（非法状态迁移=会话已被回收）→ rejected', () => {
    expect(classifyStatusSync({ ok: false, status: 400 })).toBe('rejected');
    expect(classifyStatusSync({ ok: false, status: 409 })).toBe('rejected');
  });

  it('5xx（服务端临时故障，会话状态未变）→ network-error，不误判回收', () => {
    expect(classifyStatusSync({ ok: false, status: 500 })).toBe('network-error');
    expect(classifyStatusSync({ ok: false, status: 503 })).toBe('network-error');
  });

  it('fetch 抛错（断网）→ network-error，不误判回收', () => {
    expect(classifyStatusSync({ error: true })).toBe('network-error');
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
