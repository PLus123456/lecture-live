'use client';

/**
 * Composer 工具行里的「模型 · 思考强度」选择器 —— 从 GlobalChat 抽出的共享组件，
 * GlobalChat（对话详情）与 ChatHomeClient（首页起聊 composer）共用；
 * ChatTab 仍持有自己的副本（B4 抽 ChatPanel 时再统一）。
 *
 * 状态全在 chatStore（selectedModel / selectedThinkingPreference / availableModels），
 * 本组件自带「模型列表未加载则拉取」的兜底，父组件无需再管。
 */

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import {
  useChatStore,
  type ThinkingPreference,
} from '@/stores/chatStore';
import type {
  ChatModelOption,
  ChatModelsResponse,
  ThinkingDepth,
  ThinkingMode,
} from '@/types/llm';

function thinkingOptionsForMode(mode: ThinkingMode): Array<{
  pref: ThinkingPreference;
  label: string;
  description: string;
  disabled?: boolean;
  disabledTitle?: string;
}> {
  if (mode === 'DEPTH') {
    return [
      { pref: 'off', label: '不思考', description: '快速答复（OpenAI 会发 minimal effort）' },
      { pref: 'low', label: '低', description: '少量思考 token' },
      { pref: 'medium', label: '中', description: '默认深度' },
      { pref: 'high', label: '高', description: '最深思考，速度较慢' },
    ];
  }
  if (mode === 'AUTO') {
    return [
      { pref: 'off', label: '不思考', description: '强制不带思考参数' },
      { pref: 'auto', label: '自动', description: '让模型自己决定' },
      { pref: 'forced', label: '强制思考', description: '尽可能启用深度思考' },
    ];
  }
  return [
    {
      pref: 'off',
      label: '不思考',
      description: '该模型自带思考无法关闭',
      disabled: true,
      disabledTitle: '该模型自带思考，无法关闭',
    },
    { pref: 'auto', label: '自动', description: '让模型自己决定' },
    { pref: 'forced', label: '强制思考', description: '尽可能启用深度思考' },
  ];
}

/**
 * 按用户组的思考能力收敛可选项：
 *  - DEPTH 模型只保留服务端下发的 allowedDepths（组深度上限内的档位）+ 恒定的「不思考」。
 *    组上限 medium 时 high 直接从菜单消失，避免「UI 让选 high、服务端静默降级到 medium」的
 *    设置与实际不一致（服务端仍会 clamp，这里是把 UI 对齐真实可执行档位）。
 *  - 非 DEPTH 模型：档位与深度无关，原样返回。
 */
function thinkingOptionsForModel(
  model: ChatModelOption | undefined
): ReturnType<typeof thinkingOptionsForMode> {
  const mode = model?.thinkingMode ?? 'NONE';
  const all = thinkingOptionsForMode(mode);
  if (mode !== 'DEPTH') return all;
  const allowed = model?.allowedDepths ?? [];
  return all.filter(
    (opt) =>
      opt.pref === 'off' || allowed.includes(opt.pref as ThinkingDepth)
  );
}

export default function ComposerModelControls({
  disabled = false,
  direction = 'up',
  layout = 'inline',
}: {
  /** 发送中等场景下置灰两个入口 */
  disabled?: boolean;
  /** 弹层展开方向：底部 composer 用 up（默认），页面上方的 composer 用 down */
  direction?: 'up' | 'down';
  /**
   * 排版：
   * - inline（默认）：紧凑一行，弹层定宽右对齐（composer 工具行用）。
   * - block：占满整行、弹层与容器同宽向上展开（对话侧栏底部用；侧栏 overflow-hidden，
   *   定宽右对齐的弹层会被裁切，故这里改为 left-0 right-0 撑满、恒向上）。
   */
  layout?: 'inline' | 'block';
}) {
  const token = useAuthStore((s) => s.token);
  const {
    selectedModel,
    selectedThinkingPreference,
    // 兜底 []：任何页面上 availableModels 若为 undefined（接口异常/未 mock），
    // 下面的 .find/.length/.map 都不应抛错（本组件如今也挂在对话侧栏，会随每个面板渲染）。
    availableModels = [],
    modelsLoaded,
    setSelectedModel,
    setSelectedThinkingPreference,
    setAvailableModels,
  } = useChatStore();

  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);

  /* 一次性：模型列表未加载则拉取（与 GlobalChat 原逻辑一致，多实例由 modelsLoaded 去重） */
  useEffect(() => {
    if (!token || modelsLoaded) return;
    fetch('/api/llm/models', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch models');
        return res.json() as Promise<ChatModelsResponse>;
      })
      .then((data) => setAvailableModels(data.models, data.defaultModel))
      .catch((err) => {
        console.error('Failed to load chat models:', err);
      });
  }, [token, modelsLoaded, setAvailableModels]);

  /* Outside-click 关闭 popover */
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    if (showModelMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showModelMenu]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        thinkingMenuRef.current &&
        !thinkingMenuRef.current.contains(e.target as Node)
      ) {
        setShowThinkingMenu(false);
      }
    };
    if (showThinkingMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showThinkingMenu]);

  const currentModelInfo = availableModels.find((m) => m.name === selectedModel);
  const currentModelLabel =
    currentModelInfo?.displayName || selectedModel || 'Default';

  /* 切模型时收敛 thinking 偏好 —— 与 ChatTab 同步；同时尊重用户组深度上限 */
  const handleSelectModel = (modelName: string) => {
    const model = availableModels.find((m) => m.name === modelName);
    setSelectedModel(modelName);
    if (model) {
      const validPrefs = thinkingOptionsForModel(model)
        .filter((opt) => !opt.disabled)
        .map((opt) => opt.pref);
      if (model.thinkingMode === 'NONE' || !model.supportsThinking) {
        setSelectedThinkingPreference('auto');
      } else if (!validPrefs.includes(selectedThinkingPreference)) {
        if (model.thinkingMode === 'DEPTH') {
          // 落到组允许集合里最高的档位（优先 medium），组禁思考时 allowedDepths 为空 → off
          const allowed = model.allowedDepths ?? [];
          const fallback: ThinkingPreference = allowed.includes('medium')
            ? 'medium'
            : (allowed[allowed.length - 1] as ThinkingPreference) ?? 'off';
          setSelectedThinkingPreference(fallback);
        } else {
          setSelectedThinkingPreference('auto');
        }
      }
    }
    setShowModelMenu(false);
  };

  // 组禁思考（supportsThinking=false，含 cap='off'）或模型本身 NONE → 禁用思考入口，
  // 让 UI 与「组是否允许思考」一致，而不是仅看模型的 thinkingMode。
  const thinkingDisabled = !(currentModelInfo?.supportsThinking ?? false);
  const thinkingOptions = thinkingOptionsForModel(currentModelInfo);
  const isThinkingActive =
    !thinkingDisabled && selectedThinkingPreference !== 'off';
  const thinkingLabel = (() => {
    switch (selectedThinkingPreference) {
      case 'off':
        return '不思考';
      case 'low':
        return '低思考';
      case 'medium':
        return '中思考';
      case 'high':
        return '高思考';
      case 'forced':
        return '强制思考';
      case 'auto':
        return '自动思考';
    }
  })();

  const popoverPlacement =
    direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2';
  const isBlock = layout === 'block';
  const modelMenuClass = isBlock
    ? 'absolute bottom-full mb-2 left-0 right-0 max-h-64 overflow-y-auto bg-white border border-cream-300 rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale'
    : `absolute ${popoverPlacement} right-0 w-56 bg-white border border-cream-300 rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale`;
  const thinkingMenuClass = isBlock
    ? 'absolute bottom-full mb-2 left-0 right-0 bg-white border border-cream-300 rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale'
    : `absolute ${popoverPlacement} right-0 w-44 bg-white border border-cream-300 rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale`;

  return (
    <div
      className={
        isBlock
          ? 'flex items-center gap-2 w-full text-[11px] min-w-0'
          : 'flex items-center gap-1.5 text-[11px] min-w-0'
      }
    >
      <div ref={modelMenuRef} className={isBlock ? 'relative flex-1 min-w-0' : 'relative'}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setShowModelMenu((v) => !v)}
          title={`模型: ${currentModelLabel}`}
          className={
            isBlock
              ? 'w-full text-left font-medium text-rust-600 hover:text-rust-700 transition-colors truncate disabled:opacity-40 disabled:cursor-not-allowed'
              : 'font-medium text-rust-600 hover:text-rust-700 transition-colors truncate max-w-[120px] disabled:opacity-40 disabled:cursor-not-allowed'
          }
        >
          {currentModelLabel}
        </button>
        {showModelMenu && (
          <div className={modelMenuClass}>
            {availableModels.length === 0 ? (
              <div className="px-3 py-2 text-xs text-charcoal-400">
                暂无可用模型
              </div>
            ) : (
              availableModels.map((model) => {
                const modeLabel =
                  model.thinkingMode === 'FORCED'
                    ? '自带深度思考'
                    : model.thinkingMode === 'DEPTH'
                      ? '可调节深度思考'
                      : model.thinkingMode === 'AUTO'
                        ? '自决思考'
                        : '标准模式';
                const imageLabel = model.supportsImage ? '· 文字+图片' : '';
                return (
                  <button
                    key={model.name}
                    onClick={() => handleSelectModel(model.name)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-cream-50 transition-colors
                      ${selectedModel === model.name ? 'text-rust-600 bg-rust-50' : 'text-charcoal-600'}`}
                  >
                    <div className="font-medium">{model.displayName}</div>
                    <div className="text-[10px] text-charcoal-400 mt-0.5">
                      {modeLabel} {imageLabel}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <span className="text-charcoal-300">·</span>

      <div ref={thinkingMenuRef} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (thinkingDisabled) return;
            setShowThinkingMenu((v) => !v);
          }}
          title={
            thinkingDisabled ? '该模型不支持思考' : `思考: ${thinkingLabel}`
          }
          className={`font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            thinkingDisabled
              ? 'text-charcoal-300 cursor-not-allowed'
              : isThinkingActive
                ? 'text-purple-500 hover:text-purple-600'
                : 'text-charcoal-400 hover:text-charcoal-600'
          }`}
        >
          {thinkingDisabled ? '不支持思考' : thinkingLabel}
        </button>

        {showThinkingMenu && !thinkingDisabled && (
          <div className={thinkingMenuClass}>
            {thinkingOptions.map((opt) => {
              const isSelected = selectedThinkingPreference === opt.pref;
              return (
                <button
                  key={opt.pref}
                  type="button"
                  disabled={opt.disabled}
                  onClick={() => {
                    if (opt.disabled) return;
                    setSelectedThinkingPreference(opt.pref);
                    setShowThinkingMenu(false);
                  }}
                  title={opt.disabledTitle ?? opt.description}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors
                    ${
                      opt.disabled
                        ? 'text-charcoal-300 cursor-not-allowed'
                        : isSelected
                          ? 'bg-purple-50 text-purple-700'
                          : 'text-charcoal-600 hover:bg-cream-50'
                    }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{opt.label}</span>
                    {isSelected && <Check className="w-3 h-3" />}
                  </div>
                  <div className="text-[10px] text-charcoal-400 mt-0.5">
                    {opt.description}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
