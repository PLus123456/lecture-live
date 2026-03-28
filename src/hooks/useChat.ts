'use client';

import { useCallback, useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import type { ChatMessage, ChatModelsResponse } from '@/types/llm';

export function useChat() {
  const {
    messages,
    isLoading,
    selectedModel,
    selectedDepth,
    availableModels,
    modelsLoaded,
    addMessage,
    setLoading,
    setSelectedModel,
    setSelectedDepth,
    setAvailableModels,
    clearAll,
  } = useChatStore();
  const token = useAuthStore((s) => s.token);

  // Fetch available models on mount
  useEffect(() => {
    if (!token || modelsLoaded) return;

    fetch('/api/llm/models', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch models');
        return res.json() as Promise<ChatModelsResponse>;
      })
      .then((data) => {
        setAvailableModels(data.models, data.defaultModel);
      })
      .catch((err) => {
        console.error('Failed to load chat models:', err);
      });
  }, [token, modelsLoaded, setAvailableModels]);

  const sendMessage = useCallback(
    async (
      question: string,
      transcriptContext: string,
      summaryContext: string
    ) => {
      if (!token) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: question,
        timestamp: Date.now(),
      };
      addMessage(userMsg);
      setLoading(true);

      try {
        const chatHistory = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await fetch('/api/llm/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            question,
            transcriptContext,
            summaryContext,
            chatHistory,
            model: selectedModel || undefined,
            thinkingDepth: selectedDepth,
          }),
        });

        if (!res.ok) throw new Error(`Chat API returned ${res.status}`);

        const data = await res.json();
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.reply,
          timestamp: Date.now(),
          model: data.model,
          thinkingDepth: data.thinkingDepth,
        };
        addMessage(assistantMsg);
      } catch (error) {
        const errMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Chat failed'}`,
          timestamp: Date.now(),
        };
        addMessage(errMsg);
      } finally {
        setLoading(false);
      }
    },
    [token, messages, addMessage, setLoading, selectedModel, selectedDepth]
  );

  return {
    messages,
    isLoading,
    selectedModel,
    selectedDepth,
    availableModels,
    modelsLoaded,
    sendMessage,
    setSelectedModel,
    setSelectedDepth,
    clearAll,
  };
}
