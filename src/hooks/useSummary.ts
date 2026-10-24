'use client';

import { useRef, useCallback } from 'react';
import { useSummaryStore } from '@/stores/summaryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { SummaryManager, type SentenceTiming } from '@/lib/llm/summaryManager';

export function useSummary() {
  const managerRef = useRef<SummaryManager | null>(null);
  const addBlock = useSummaryStore((s) => s.addBlock);
  const freezeLastBlock = useSummaryStore((s) => s.freezeLastBlock);
  const updateRunningContext = useSummaryStore((s) => s.updateRunningContext);
  const setLoading = useSummaryStore((s) => s.setLoading);
  const setBatchSentences = useSummaryStore((s) => s.setBatchSentences);
  const setError = useSummaryStore((s) => s.setError);

  const init = useCallback(() => {
    // M15：重复 init（换录音/重新开始）时，先让上一个 manager 失效并 abort 在途请求，
    // 否则旧 manager 的 in-flight summarize resolve 后仍会通过构造时捕获的闭包写 store。
    managerRef.current?.reset();

    const settings = useSettingsStore.getState();
    const token = useAuthStore.getState().token;

    const manager = new SummaryManager({
      courseContext: `${settings.domain}${settings.topic ? ' - ' + settings.topic : ''}`,
      targetLanguage: settings.summaryLanguage,
      triggerSentences: settings.summaryTriggerSentences,
      triggerMinutes: settings.summaryTriggerMinutes,
      providerOverride: settings.llmProvider || undefined,
      authToken: token || '',
      onSummaryStart: () => setLoading(true),
      onStateUpdate: (state) => {
        setLoading(false);
        // 添加最新的 block
        const latestBlock = state.blocks[state.blocks.length - 1];
        if (latestBlock) {
          // 先冻结上一个 block
          freezeLastBlock();
          addBlock(latestBlock);
        }
        updateRunningContext(state.runningContext);
      },
      onSummaryError: (error) => {
        setLoading(false);
        setError(error);
      },
      // 审计 #6：刷新 / 冷恢复后新建的 manager 接续 store 里本会话已有的块与滚动上下文（store
      // 归属已由会话页 init 判定，外来数据在 init 前清空），否则块号从 #1、时间从 00:00 重来、
      // LLM 丢失此前的上下文。惰性读取：冷恢复的草稿在 init 之后才异步灌进 store。
      getBaseline: () => {
        const { blocks, runningContext } = useSummaryStore.getState();
        return { blocks, runningContext };
      },
    });

    managerRef.current = manager;
  }, [addBlock, freezeLastBlock, updateRunningContext, setLoading, setError]);

  const onNewSentence = useCallback(
    (sentence: string, timing?: SentenceTiming) => {
      managerRef.current?.onNewSentence(sentence, timing);
      const count = managerRef.current?.bufferedSentenceCount ?? 0;
      setBatchSentences(count);
    },
    [setBatchSentences]
  );

  const triggerManual = useCallback(() => {
    return managerRef.current?.triggerIncrementalSummary();
  }, []);

  const reset = useCallback(() => {
    managerRef.current?.reset();
    managerRef.current = null;
    // reset 会 abort 在途 summarize，那次请求不再回调 onSummaryError/onStateUpdate，
    // 若不在这里收尾，store 的 isLoading 会永远停在 true（转圈不停）。
    setLoading(false);
    setBatchSentences(0);
  }, [setLoading, setBatchSentences]);

  return { init, onNewSentence, triggerManual, reset };
}
