'use client';

import { useRef, useCallback } from 'react';
import { useSummaryStore } from '@/stores/summaryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { SummaryManager } from '@/lib/llm/summaryManager';

export function useSummary() {
  const managerRef = useRef<SummaryManager | null>(null);
  const addBlock = useSummaryStore((s) => s.addBlock);
  const freezeLastBlock = useSummaryStore((s) => s.freezeLastBlock);
  const updateRunningContext = useSummaryStore((s) => s.updateRunningContext);
  const setLoading = useSummaryStore((s) => s.setLoading);
  const setBatchSentences = useSummaryStore((s) => s.setBatchSentences);
  const setError = useSummaryStore((s) => s.setError);

  const init = useCallback(() => {
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
    });

    managerRef.current = manager;
  }, [addBlock, freezeLastBlock, updateRunningContext, setLoading, setError]);

  const onNewSentence = useCallback(
    (sentence: string) => {
      managerRef.current?.onNewSentence(sentence);
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
  }, []);

  return { init, onNewSentence, triggerManual, reset };
}
