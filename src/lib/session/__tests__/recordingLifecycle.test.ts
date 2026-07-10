import { describe, it, expect } from 'vitest';
import {
  classifyStatusSync,
  resolveFinalizeOutcome,
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
