import 'server-only';

import { runAudioEnhanceTick } from '@/lib/audio/enhanceProcessor';

/**
 * 音频增强调度 loop（与 billingMaintenance 同款 globalThis 单例守卫）。
 * 跑在 ws 常驻进程里（server/websocket.ts 启动时挂载）：worker 处理一节课要几十分钟，
 * 必须有不依赖任何 HTTP 请求的周期推进器；前端轮询 enhance-status 只是加速通道。
 *
 * tick 自身是幂等对账（runAudioEnhanceTick 内含进程级防重入 + 跨进程 claim CAS），
 * 未启用音频增强时 tick 直接短路，常驻开销可忽略。
 */

const ENHANCE_TICK_INTERVAL_MS = 20_000;

type AudioEnhanceLoopGlobal = typeof globalThis & {
  __lectureLiveAudioEnhanceLoopStarted?: boolean;
  __lectureLiveAudioEnhanceLoopTimer?: ReturnType<typeof setInterval>;
};

export function startAudioEnhanceLoop(intervalMs = ENHANCE_TICK_INTERVAL_MS) {
  const globalState = globalThis as AudioEnhanceLoopGlobal;
  if (globalState.__lectureLiveAudioEnhanceLoopStarted) {
    return;
  }
  globalState.__lectureLiveAudioEnhanceLoopStarted = true;

  // runAudioEnhanceTick 从不 reject（内部吞掉并记录所有异常），这里无需再包 catch
  void runAudioEnhanceTick();

  const timer = setInterval(() => {
    void runAudioEnhanceTick();
  }, intervalMs);
  timer.unref?.();
  globalState.__lectureLiveAudioEnhanceLoopTimer = timer;
}

export function stopAudioEnhanceLoop() {
  const globalState = globalThis as AudioEnhanceLoopGlobal;
  const timer = globalState.__lectureLiveAudioEnhanceLoopTimer;
  if (timer) {
    clearInterval(timer);
    globalState.__lectureLiveAudioEnhanceLoopTimer = undefined;
  }
  globalState.__lectureLiveAudioEnhanceLoopStarted = false;
}
