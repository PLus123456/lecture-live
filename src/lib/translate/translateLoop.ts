import 'server-only';

import { runDocTranslateTick } from '@/lib/translate/translateProcessor';

/**
 * 文档翻译调度 loop（与 audio-enhance loop 同款 globalThis 单例守卫）。
 * 跑在 ws 常驻进程里：大文档翻译要几十分钟到数小时，必须有不依赖 HTTP 请求的
 * 周期推进器；前端轮询任务状态只是加速通道。tick 幂等（进程级防重入 + 跨进程 claim CAS），
 * 未启用文档翻译时 tick 直接短路。
 */

const TRANSLATE_TICK_INTERVAL_MS = 20_000;

type DocTranslateLoopGlobal = typeof globalThis & {
  __lectureLiveDocTranslateLoopStarted?: boolean;
  __lectureLiveDocTranslateLoopTimer?: ReturnType<typeof setInterval>;
};

export function startDocTranslateLoop(intervalMs = TRANSLATE_TICK_INTERVAL_MS) {
  const globalState = globalThis as DocTranslateLoopGlobal;
  if (globalState.__lectureLiveDocTranslateLoopStarted) {
    return;
  }
  globalState.__lectureLiveDocTranslateLoopStarted = true;

  // runDocTranslateTick 从不 reject（内部吞掉并记录所有异常）
  void runDocTranslateTick();

  const timer = setInterval(() => {
    void runDocTranslateTick();
  }, intervalMs);
  timer.unref?.();
  globalState.__lectureLiveDocTranslateLoopTimer = timer;
}

export function stopDocTranslateLoop() {
  const globalState = globalThis as DocTranslateLoopGlobal;
  const timer = globalState.__lectureLiveDocTranslateLoopTimer;
  if (timer) {
    clearInterval(timer);
    globalState.__lectureLiveDocTranslateLoopTimer = undefined;
  }
  globalState.__lectureLiveDocTranslateLoopStarted = false;
}
