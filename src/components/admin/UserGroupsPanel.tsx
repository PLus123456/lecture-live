'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Edit3,
  Users,
  Clock,
  HardDrive,
  Cpu,
  ChevronDown,
  X,
  RefreshCw,
  Plus,
  Trash2,
  Brain,
  Sparkles,
  FileText,
  MessageCircle,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import ModalPortal from '@/components/ModalPortal';

/** 思考深度上限档位（'off' 表示禁止思考） */
type ThinkingDepthCap = 'off' | 'low' | 'medium' | 'high';
const DEPTH_CHOICES: Exclude<ThinkingDepthCap, 'off'>[] = ['low', 'medium', 'high'];

interface GroupPermissions {
  transcriptionMinutesLimit: number;
  storageHoursLimit: number;
  allowedModels: string;
  maxConcurrentSessions: number;
  maxThinkingDepth: ThinkingDepthCap;
  allowRealtimeSummary: boolean;
  allowFinalSummary: boolean;
  /** 该组实时摘要模型（DB model id；'' = 跟随全局默认） */
  realtimeSummaryModelId?: string;
  /** 该组总摘要模型（DB model id；'' = 跟随全局默认） */
  finalSummaryModelId?: string;
  /** 该组默认聊天模型（DB model id；'' = 跟随全局 CHAT 默认；用户未显式选模型时生效） */
  chatModelId?: string;
}

interface UserGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  permissions: GroupPermissions;
  userCount: number;
  isSystem: boolean;
}

// 角色 → 颜色 / 描述映射
const GROUP_COLORS: Record<string, string> = {
  FREE: 'bg-cream-200 text-charcoal-600',
  PRO: 'bg-amber-50 text-amber-600',
  ADMIN: 'bg-rust-50 text-rust-600',
};

function getGroupDescription(t: (key: string) => string, id: string): string {
  const map: Record<string, string> = {
    FREE: t('admin.freeDesc'),
    PRO: t('admin.proDesc'),
    ADMIN: t('admin.adminDesc'),
  };
  return map[id] ?? '';
}

function GroupCard({
  group,
  catalog,
  onEdit,
  onDelete,
  expanded,
  onToggle,
}: {
  group: UserGroup;
  catalog: ModelCatalog;
  onEdit: () => void;
  onDelete?: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="bg-white rounded-xl border border-cream-200 overflow-hidden hover:shadow-sm transition-shadow">
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${group.color}`}>
            <Users className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-charcoal-800">{group.name}</span>
              {group.isSystem ? (
                <span className="text-[10px] px-1.5 py-0.5 bg-cream-100 text-charcoal-400 rounded font-medium">
                  {t('admin.builtIn')}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded font-medium">
                  {t('admin.custom')}
                </span>
              )}
            </div>
            <div className="text-xs text-charcoal-400 mt-0.5">{group.description}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-charcoal-400">{t('admin.nUsers', { n: group.userCount })}</span>
          <ChevronDown
            className={`w-4 h-4 text-charcoal-400 transition-transform duration-300 ease-out ${
              expanded ? 'rotate-180' : 'rotate-0'
            }`}
          />
        </div>
      </div>

      {/* 用 CSS grid 行 0fr → 1fr 做高度过渡，避免 JS 计算高度 */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out
                    ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
        <div className="px-5 pb-4 border-t border-cream-100">
          <div className="grid grid-cols-2 gap-3 pt-4">
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <Clock className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.transcription')}</span>
              <span className="font-medium">
                {group.permissions.transcriptionMinutesLimit >= 999999
                  ? t('admin.unlimited')
                  : `${group.permissions.transcriptionMinutesLimit} min/month`}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <HardDrive className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.storage')}</span>
              <span className="font-medium">
                {group.permissions.storageHoursLimit >= 999999
                  ? t('admin.unlimited')
                  : `${group.permissions.storageHoursLimit} hours`}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <Cpu className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.llmModels')}</span>
              <span className="font-medium">
                {group.permissions.allowedModels === '*'
                  ? t('common.all')
                  : group.permissions.allowedModels.split(',').join(', ')}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <Users className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.concurrent')}</span>
              <span className="font-medium">
                {group.permissions.maxConcurrentSessions >= 999
                  ? t('admin.unlimited')
                  : group.permissions.maxConcurrentSessions}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <Brain className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.thinking')}</span>
              <span className="font-medium">
                {group.permissions.maxThinkingDepth === 'off'
                  ? t('admin.disabled')
                  : t(`admin.depth.${group.permissions.maxThinkingDepth}`)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <Sparkles className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.realtimeSummary')}</span>
              <span className="font-medium">
                {group.permissions.allowRealtimeSummary
                  ? t('admin.enabled')
                  : t('admin.disabled')}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-charcoal-600">
              <FileText className="w-3.5 h-3.5 text-charcoal-400" />
              <span>{t('admin.finalSummary')}</span>
              <span className="font-medium">
                {group.permissions.allowFinalSummary
                  ? t('admin.enabled')
                  : t('admin.disabled')}
              </span>
            </div>
            {group.permissions.allowRealtimeSummary && (
              <div className="flex items-center gap-2 text-sm text-charcoal-600 min-w-0">
                <Sparkles className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
                <span className="shrink-0">{t('admin.realtimeSummaryModel')}</span>
                <span className="font-medium truncate">
                  {summaryModelDisplay(
                    t,
                    group.permissions.realtimeSummaryModelId,
                    catalog.realtimeSummary,
                    catalog.realtimeDefault,
                  )}
                </span>
              </div>
            )}
            {group.permissions.allowFinalSummary && (
              <div className="flex items-center gap-2 text-sm text-charcoal-600 min-w-0">
                <FileText className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
                <span className="shrink-0">{t('admin.finalSummaryModel')}</span>
                <span className="font-medium truncate">
                  {summaryModelDisplay(
                    t,
                    group.permissions.finalSummaryModelId,
                    catalog.finalSummary,
                    catalog.finalDefault,
                  )}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-charcoal-600 min-w-0">
              <MessageCircle className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
              <span className="shrink-0">{t('admin.defaultChatModel')}</span>
              <span className="font-medium truncate">
                {summaryModelDisplay(
                  t,
                  group.permissions.chatModelId,
                  catalog.chatOptions,
                  catalog.chatDefault,
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-4 pt-3 border-t border-cream-100">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-charcoal-500
                         rounded-lg hover:bg-cream-100 transition-colors"
            >
              <Edit3 className="w-3 h-3" />
              {t('common.edit')}
            </button>
            {!group.isSystem && onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500
                           rounded-lg hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
                {t('admin.deleteGroup')}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

/** 去重后的可选模型（token = 底层 modelId；与后端 allowedModels 的匹配口径一致） */
interface ModelInfo {
  modelId: string;      // 作为 allowedModels 存储的 token
  displayName: string;  // 展示名
  providerName: string; // 所属供应商（消歧展示）
}

/** 某个摘要用途下的一个可选模型（token = DB model id；与后端摘要模型字段口径一致） */
interface SummaryModelOption {
  id: string;           // DB model id —— 作为 realtime/finalSummaryModelId 存储的 token
  displayName: string;
  providerName: string;
  modelId: string;      // 供应商模型串（消歧展示）
}

/**
 * 编辑面板需要的全部模型目录（一次从 /api/admin/llm-providers 拉取后按用途拆分）。
 * chat 用于「可用模型」勾选；realtime/final 用于摘要模型下拉；xxxDefault 是该用途在
 * 「设置 > LLM」里被标记 isDefault 的全局默认模型（用于下拉里的「跟随全局默认（X）」展示）。
 */
interface ModelCatalog {
  chat: ModelInfo[];
  /** CHAT 用途的具体路由行（默认聊天模型下拉，存 DB id） */
  chatOptions: SummaryModelOption[];
  realtimeSummary: SummaryModelOption[];
  finalSummary: SummaryModelOption[];
  chatDefault?: SummaryModelOption;
  realtimeDefault?: SummaryModelOption;
  finalDefault?: SummaryModelOption;
}

const EMPTY_CATALOG: ModelCatalog = {
  chat: [],
  chatOptions: [],
  realtimeSummary: [],
  finalSummary: [],
};

/** 在某用途的选项列表里解析一个已保存的 model id 的展示名（用于卡片/下拉回显） */
function summaryModelDisplay(
  t: (key: string, vars?: Record<string, string | number>) => string,
  id: string | undefined,
  options: SummaryModelOption[],
  globalDefault?: SummaryModelOption,
): string {
  if (!id) {
    return globalDefault
      ? t('admin.followGlobalWith', { name: globalDefault.displayName })
      : t('admin.followGlobal');
  }
  const found = options.find((o) => o.id === id);
  if (found) return found.displayName;
  return t('admin.staleModel');
}

function ModelCheckboxList({
  models,
  selected,
  selectAll,
  onToggle,
  onToggleAll,
}: {
  models: ModelInfo[];
  selected: Set<string>;
  selectAll: boolean;
  onToggle: (modelId: string) => void;
  onToggleAll: () => void;
}) {
  const { t } = useI18n();

  if (models.length === 0) {
    return (
      <div className="text-xs text-charcoal-400 py-2">
        {t('admin.noModelsHint')}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-cream-200 bg-cream-50/50 p-3 max-h-56 overflow-y-auto">
      <label className="flex items-center gap-2 cursor-pointer pb-1.5 border-b border-cream-200">
        <input
          type="checkbox"
          checked={selectAll}
          onChange={onToggleAll}
          className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
        />
        <span className="text-sm font-medium text-charcoal-700">{t('admin.selectAllModels')}</span>
      </label>
      {models.map((m) => (
        <label key={m.modelId} className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selectAll || selected.has(m.modelId)}
            disabled={selectAll}
            onChange={() => onToggle(m.modelId)}
            className="rounded border-cream-300 text-rust-500 focus:ring-rust-200 disabled:opacity-50"
          />
          <span className="text-sm text-charcoal-600">{m.displayName}</span>
          <span className="text-[10px] text-charcoal-400">
            {m.providerName} · {m.modelId}
          </span>
        </label>
      ))}
    </div>
  );
}

const COLOR_OPTIONS = [
  { value: 'bg-purple-50 text-purple-600', dot: 'bg-purple-500' },
  { value: 'bg-blue-50 text-blue-600', dot: 'bg-blue-500' },
  { value: 'bg-green-50 text-green-600', dot: 'bg-green-500' },
  { value: 'bg-pink-50 text-pink-600', dot: 'bg-pink-500' },
  { value: 'bg-orange-50 text-orange-600', dot: 'bg-orange-500' },
  { value: 'bg-teal-50 text-teal-600', dot: 'bg-teal-500' },
];

/** 能力卡片顶部的「开/关」行（图标 + 标签 + 复选框），外层边框由所在卡片提供 */
function CapabilityToggle({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="flex items-center gap-2 text-sm text-charcoal-700">
        {icon}
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
      />
    </label>
  );
}

/**
 * 摘要模型下拉：value='' → 「跟随全局默认（X）」（X 为该用途在 设置>LLM 里 isDefault 的模型）；
 * 否则选某个具体模型（存 DB id）。已保存但选项里不存在（模型被删）时保留一个「已失效」项，
 * 避免静默回落成「跟随全局」误导管理员。
 */
function SummaryModelSelect({
  label,
  value,
  onChange,
  options,
  globalDefault,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SummaryModelOption[];
  globalDefault?: SummaryModelOption;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const hasCurrent = !value || options.some((o) => o.id === value);
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <span className="shrink-0 text-xs text-charcoal-500">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 px-2 py-1 text-sm border border-cream-200 rounded-md bg-white
                   focus:outline-none focus:ring-2 focus:ring-rust-200 disabled:opacity-50"
      >
        <option value="">
          {globalDefault
            ? t('admin.followGlobalWith', { name: globalDefault.displayName })
            : t('admin.followGlobal')}
        </option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName} · {o.providerName}
          </option>
        ))}
        {!hasCurrent && <option value={value}>{t('admin.staleModel')}</option>}
      </select>
    </div>
  );
}

/** 小节标题（配额 / 可用模型 / 能力开关） */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold text-charcoal-700 block">{children}</label>
  );
}

function PermissionsForm({
  minutesLimit,
  setMinutesLimit,
  storageLimit,
  setStorageLimit,
  concurrent,
  setConcurrent,
  models,
  catalog,
  selected,
  selectAll,
  onToggle,
  onToggleAll,
  thinkingEnabled,
  setThinkingEnabled,
  maxDepth,
  setMaxDepth,
  allowRealtime,
  setAllowRealtime,
  allowFinal,
  setAllowFinal,
  realtimeSummaryModelId,
  setRealtimeSummaryModelId,
  finalSummaryModelId,
  setFinalSummaryModelId,
  chatModelId,
  setChatModelId,
}: {
  minutesLimit: string;
  setMinutesLimit: (v: string) => void;
  storageLimit: string;
  setStorageLimit: (v: string) => void;
  concurrent: string;
  setConcurrent: (v: string) => void;
  models: ModelInfo[];
  catalog: ModelCatalog;
  selected: Set<string>;
  selectAll: boolean;
  onToggle: (modelId: string) => void;
  onToggleAll: () => void;
  thinkingEnabled: boolean;
  setThinkingEnabled: (v: boolean) => void;
  maxDepth: Exclude<ThinkingDepthCap, 'off'>;
  setMaxDepth: (v: Exclude<ThinkingDepthCap, 'off'>) => void;
  allowRealtime: boolean;
  setAllowRealtime: (v: boolean) => void;
  allowFinal: boolean;
  setAllowFinal: (v: boolean) => void;
  realtimeSummaryModelId: string;
  setRealtimeSummaryModelId: (v: string) => void;
  finalSummaryModelId: string;
  setFinalSummaryModelId: (v: string) => void;
  chatModelId: string;
  setChatModelId: (v: string) => void;
}) {
  const { t } = useI18n();
  const inputCls =
    'w-full px-3 py-2 text-sm border border-cream-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300';
  return (
    <>
      {/* ── 配额 ── */}
      <div className="space-y-3">
        <SectionLabel>{t('admin.sectionQuota')}</SectionLabel>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-charcoal-500 mb-1 block">{t('admin.transcriptionMinMonth')}</label>
            <input type="number" value={minutesLimit} onChange={(e) => setMinutesLimit(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-charcoal-500 mb-1 block">{t('admin.storageHours')}</label>
            <input type="number" step="0.5" min="0" value={storageLimit} onChange={(e) => setStorageLimit(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="text-xs text-charcoal-500 mb-1 block">{t('admin.maxConcurrent')}</label>
          <input type="number" min={1} value={concurrent} onChange={(e) => setConcurrent(e.target.value)} className={inputCls} />
          <p className="text-[11px] text-charcoal-400 mt-1">{t('admin.maxConcurrentHint')}</p>
        </div>
      </div>

      {/* ── 可用模型（仅作用于聊天选择器）── */}
      <div className="space-y-1.5 pt-1">
        <SectionLabel>{t('admin.allowedLlmModels')}</SectionLabel>
        <p className="text-[11px] text-charcoal-400">{t('admin.allowedModelsHint')}</p>
        <ModelCheckboxList
          models={models}
          selected={selected}
          selectAll={selectAll}
          onToggle={onToggle}
          onToggleAll={onToggleAll}
        />
        {/* 默认聊天模型：用户未显式选模型时该组用哪个（组绑定=管理员决策，可越过勾选集）*/}
        <div className="pt-1.5">
          <SummaryModelSelect
            label={t('admin.defaultChatModel')}
            value={chatModelId}
            onChange={setChatModelId}
            options={catalog.chatOptions}
            globalDefault={catalog.chatDefault}
            disabled={false}
          />
          <p className="text-[11px] text-charcoal-400 mt-1 pl-6">{t('admin.defaultChatModelHint')}</p>
        </div>
      </div>

      {/* ── 能力开关 + 摘要模型（每个能力与它的模型选择就近放一起）── */}
      <div className="space-y-2 pt-1">
        <SectionLabel>{t('admin.capabilities')}</SectionLabel>

        {/* 思考：开关 + 最大深度 */}
        <div className="rounded-lg border border-cream-200 px-3 py-2.5 space-y-2.5">
          <CapabilityToggle
            icon={<Brain className="w-3.5 h-3.5 text-charcoal-400" />}
            label={t('admin.allowThinking')}
            checked={thinkingEnabled}
            onChange={setThinkingEnabled}
          />
          <div className="flex items-center gap-2 pl-6">
            <span className="text-xs text-charcoal-500">{t('admin.maxThinkingDepth')}</span>
            <select
              value={maxDepth}
              disabled={!thinkingEnabled}
              onChange={(e) => setMaxDepth(e.target.value as Exclude<ThinkingDepthCap, 'off'>)}
              className="px-2 py-1 text-sm border border-cream-200 rounded-md bg-white
                         focus:outline-none focus:ring-2 focus:ring-rust-200 disabled:opacity-50"
            >
              {DEPTH_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {t(`admin.depth.${d}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 实时摘要：开关 + 摘要模型 */}
        <div className="rounded-lg border border-cream-200 px-3 py-2.5 space-y-2.5">
          <CapabilityToggle
            icon={<Sparkles className="w-3.5 h-3.5 text-charcoal-400" />}
            label={t('admin.allowRealtimeSummary')}
            checked={allowRealtime}
            onChange={setAllowRealtime}
          />
          <SummaryModelSelect
            label={t('admin.realtimeSummaryModel')}
            value={realtimeSummaryModelId}
            onChange={setRealtimeSummaryModelId}
            options={catalog.realtimeSummary}
            globalDefault={catalog.realtimeDefault}
            disabled={!allowRealtime}
          />
        </div>

        {/* 总摘要：开关 + 摘要模型 */}
        <div className="rounded-lg border border-cream-200 px-3 py-2.5 space-y-2.5">
          <CapabilityToggle
            icon={<FileText className="w-3.5 h-3.5 text-charcoal-400" />}
            label={t('admin.allowFinalSummary')}
            checked={allowFinal}
            onChange={setAllowFinal}
          />
          <SummaryModelSelect
            label={t('admin.finalSummaryModel')}
            value={finalSummaryModelId}
            onChange={setFinalSummaryModelId}
            options={catalog.finalSummary}
            globalDefault={catalog.finalDefault}
            disabled={!allowFinal}
          />
        </div>

        <p className="text-[11px] text-charcoal-400">{t('admin.summaryModelHint')}</p>
      </div>
    </>
  );
}

function usePermissionsForm(
  initPermissions: GroupPermissions,
  models: ModelInfo[],
) {
  const [minutesLimit, setMinutesLimit] = useState(String(initPermissions.transcriptionMinutesLimit));
  const [storageLimit, setStorageLimit] = useState(String(initPermissions.storageHoursLimit));
  const [concurrent, setConcurrent] = useState(String(initPermissions.maxConcurrentSessions));

  // 能力开关状态
  const [thinkingEnabled, setThinkingEnabled] = useState(initPermissions.maxThinkingDepth !== 'off');
  const [maxDepth, setMaxDepth] = useState<Exclude<ThinkingDepthCap, 'off'>>(
    initPermissions.maxThinkingDepth === 'off' ? 'medium' : initPermissions.maxThinkingDepth,
  );
  const [allowRealtime, setAllowRealtime] = useState(initPermissions.allowRealtimeSummary);
  const [allowFinal, setAllowFinal] = useState(initPermissions.allowFinalSummary);

  // 摘要/聊天模型（DB id；'' = 跟随全局默认）
  const [realtimeSummaryModelId, setRealtimeSummaryModelId] = useState(
    initPermissions.realtimeSummaryModelId ?? '',
  );
  const [finalSummaryModelId, setFinalSummaryModelId] = useState(
    initPermissions.finalSummaryModelId ?? '',
  );
  const [chatModelId, setChatModelId] = useState(initPermissions.chatModelId ?? '');

  const isAllInit = initPermissions.allowedModels === '*';
  const [selectAll, setSelectAll] = useState(isAllInit);
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (isAllInit) return new Set(models.map((m) => m.modelId));
    // 兼容旧数据：token 可能是具体 modelId，也可能是历史遗留的供应商名 → 两者命中都勾上，
    // 保存时统一写回具体 modelId（自然完成一次「供应商→具体模型」的迁移）。
    const tokens = new Set(
      initPermissions.allowedModels.split(',').map((s) => s.trim()).filter(Boolean),
    );
    return new Set(
      models
        .filter((m) => tokens.has(m.modelId) || tokens.has(m.providerName))
        .map((m) => m.modelId),
    );
  });

  // models 异步加载完成时，若处于全选模式则同步 selected
  useEffect(() => {
    if (selectAll && models.length > 0) {
      setSelected(new Set(models.map((m) => m.modelId)));
    }
  }, [models, selectAll]);

  const handleToggle = (modelId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const handleToggleAll = () => {
    if (selectAll) {
      setSelectAll(false);
      // 取消全选时预填为当前全部模型，让用户在全集基础上逐个取消；
      // 若清空成空集，buildPermissions 会塌缩成 'local'（原 Bug：全选→取消全选→保存丢成 local）。
      setSelected(new Set(models.map((m) => m.modelId)));
    } else {
      setSelectAll(true);
      setSelected(new Set(models.map((m) => m.modelId)));
    }
  };

  const buildPermissions = (): GroupPermissions => {
    const allowedModels = selectAll ? '*' : Array.from(selected).filter(Boolean).join(',') || 'local';
    return {
      transcriptionMinutesLimit: parseInt(minutesLimit) || 60,
      // storageHoursLimit 是 Float（后端已去 Math.floor 保留小数）；前端须用 parseFloat，
      // 否则 parseInt('2.5')→2 会在到达后端前就截断，使后端保留浮点的修复形同虚设。
      storageHoursLimit: Math.max(0, parseFloat(storageLimit) || 10),
      allowedModels,
      maxConcurrentSessions: parseInt(concurrent) || 1,
      maxThinkingDepth: thinkingEnabled ? maxDepth : 'off',
      allowRealtimeSummary: allowRealtime,
      allowFinalSummary: allowFinal,
      // 能力关掉时把对应摘要模型一并清空（跟随全局）——关了还留个具体模型 id 是无意义的死配置
      realtimeSummaryModelId: allowRealtime ? realtimeSummaryModelId : '',
      finalSummaryModelId: allowFinal ? finalSummaryModelId : '',
      chatModelId,
    };
  };

  return {
    minutesLimit, setMinutesLimit,
    storageLimit, setStorageLimit,
    concurrent, setConcurrent,
    thinkingEnabled, setThinkingEnabled,
    maxDepth, setMaxDepth,
    allowRealtime, setAllowRealtime,
    allowFinal, setAllowFinal,
    realtimeSummaryModelId, setRealtimeSummaryModelId,
    finalSummaryModelId, setFinalSummaryModelId,
    chatModelId, setChatModelId,
    selected, selectAll,
    handleToggle, handleToggleAll,
    buildPermissions,
  };
}

function GroupModal({
  group,
  onClose,
  onSave,
  saving,
  catalog,
  leaving,
}: {
  group: UserGroup;
  onClose: () => void;
  onSave: (data: { permissions: GroupPermissions; name?: string; description?: string; color?: string }) => void;
  saving: boolean;
  catalog: ModelCatalog;
  leaving: boolean;
}) {
  const { t } = useI18n();
  const models = catalog.chat;
  const [groupName, setGroupName] = useState(group.name);
  const [groupDesc, setGroupDesc] = useState(group.description);
  const [groupColor, setGroupColor] = useState(group.color);
  const pf = usePermissionsForm(group.permissions, models);

  const handleSave = () => {
    onSave({
      permissions: pf.buildPermissions(),
      ...(!group.isSystem ? { name: groupName, description: groupDesc, color: groupColor } : {}),
    });
  };

  return (
    <ModalPortal>
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm ${leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}>
      <div className={`bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto ${leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 sticky top-0 bg-white z-10">
          <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">
            {t('admin.editGroup')} — {group.name}
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center
                       text-charcoal-400 hover:bg-cream-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {!group.isSystem && (
            <>
              <div>
                <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.groupName')}</label>
                <input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                             focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.groupDescription')}</label>
                <input
                  value={groupDesc}
                  onChange={(e) => setGroupDesc(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                             focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.groupColor')}</label>
                <div className="flex items-center gap-2">
                  {COLOR_OPTIONS.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => setGroupColor(c.value)}
                      className={`w-7 h-7 rounded-full ${c.dot} transition-all ${
                        groupColor === c.value ? 'ring-2 ring-offset-2 ring-charcoal-400 scale-110' : 'opacity-60 hover:opacity-100'
                      }`}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
          <PermissionsForm
            {...pf}
            models={models}
            catalog={catalog}
            onToggle={pf.handleToggle}
            onToggleAll={pf.handleToggleAll}
          />
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-100 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-charcoal-500 rounded-lg hover:bg-cream-100 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm text-white bg-rust-500 rounded-lg hover:bg-rust-600
                       transition-colors shadow-sm disabled:opacity-50"
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

function CreateGroupModal({
  onClose,
  onCreate,
  saving,
  catalog,
  leaving,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; description: string; color: string; permissions: GroupPermissions }) => void;
  saving: boolean;
  catalog: ModelCatalog;
  leaving: boolean;
}) {
  const { t } = useI18n();
  const models = catalog.chat;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLOR_OPTIONS[0].value);
  // 新建自定义组默认「全部允许」（思考 high、两摘要开、摘要模型跟随全局），管理员按需收紧
  const defaultPermissions: GroupPermissions = {
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 10,
    allowedModels: 'local',
    maxConcurrentSessions: 1,
    maxThinkingDepth: 'high',
    allowRealtimeSummary: true,
    allowFinalSummary: true,
    realtimeSummaryModelId: '',
    finalSummaryModelId: '',
  };
  const pf = usePermissionsForm(defaultPermissions, models);

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      description: description.trim(),
      color,
      permissions: pf.buildPermissions(),
    });
  };

  return (
    <ModalPortal>
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm ${leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}>
      <div className={`bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto ${leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 sticky top-0 bg-white z-10">
          <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">{t('admin.createGroup')}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center
                       text-charcoal-400 hover:bg-cream-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.groupName')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
              placeholder={t('admin.groupName')}
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.groupDescription')}</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.groupColor')}</label>
            <div className="flex items-center gap-2">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setColor(c.value)}
                  className={`w-7 h-7 rounded-full ${c.dot} transition-all ${
                    color === c.value ? 'ring-2 ring-offset-2 ring-charcoal-400 scale-110' : 'opacity-60 hover:opacity-100'
                  }`}
                />
              ))}
            </div>
          </div>
          <PermissionsForm
            {...pf}
            models={models}
            catalog={catalog}
            onToggle={pf.handleToggle}
            onToggleAll={pf.handleToggleAll}
          />
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-100 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-charcoal-500 rounded-lg hover:bg-cream-100 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm text-white bg-rust-500 rounded-lg hover:bg-rust-600
                       transition-colors shadow-sm disabled:opacity-50"
          >
            {saving ? t('common.loading') : t('admin.createGroup')}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

export default function UserGroupsPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<UserGroup | undefined>(undefined);
  const [catalog, setCatalog] = useState<ModelCatalog>(EMPTY_CATALOG);

  // 从后端一次性加载模型目录并按用途拆分：
  //  - chat：CHAT 用途、按 modelId 去重（allowedModels 存的就是这些 modelId；仅作用于聊天选择器）
  //  - realtimeSummary / finalSummary：对应用途的具体模型（摘要模型下拉，存 DB id）
  //  - realtimeDefault / finalDefault：该用途在「设置 > LLM」里 isDefault 的全局默认（下拉「跟随全局默认（X）」展示）
  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/llm-providers', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();

      const seenChat = new Set<string>();
      const chat: ModelInfo[] = [];
      const chatOptions: SummaryModelOption[] = [];
      const realtimeSummary: SummaryModelOption[] = [];
      const finalSummary: SummaryModelOption[] = [];
      let chatDefault: SummaryModelOption | undefined;
      let realtimeDefault: SummaryModelOption | undefined;
      let finalDefault: SummaryModelOption | undefined;

      for (const p of (data.providers ?? []) as {
        name: string;
        models?: {
          id?: string;
          modelId?: string;
          displayName?: string;
          purpose?: string;
          isDefault?: boolean;
        }[];
      }[]) {
        for (const m of p.models ?? []) {
          const modelId = (m.modelId ?? '').trim();
          const id = (m.id ?? '').trim();
          const displayName = (m.displayName || modelId).trim();
          if (m.purpose === 'CHAT') {
            // 默认聊天模型以 DB id 为准（与摘要模型同口径）
            if (id) {
              const opt: SummaryModelOption = { id, displayName, providerName: p.name, modelId };
              chatOptions.push(opt);
              if (m.isDefault) chatDefault = opt;
            }
            // allowedModels 按 modelId 去重
            if (!modelId || seenChat.has(modelId)) continue;
            seenChat.add(modelId);
            chat.push({ modelId, displayName, providerName: p.name });
          } else if (m.purpose === 'REALTIME_SUMMARY' || m.purpose === 'FINAL_SUMMARY') {
            // 摘要模型以 DB id 为准（同一 modelId 在两个供应商下是两个不同的可选项）
            if (!id) continue;
            const opt: SummaryModelOption = { id, displayName, providerName: p.name, modelId };
            if (m.purpose === 'REALTIME_SUMMARY') {
              realtimeSummary.push(opt);
              if (m.isDefault) realtimeDefault = opt;
            } else {
              finalSummary.push(opt);
              if (m.isDefault) finalDefault = opt;
            }
          }
        }
      }

      setCatalog({ chat, chatOptions, realtimeSummary, finalSummary, chatDefault, realtimeDefault, finalDefault });
    } catch (err) {
      console.error('加载模型目录失败:', err);
    }
  }, [token]);

  // 从后端加载用户组数据
  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/groups', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        const enriched: UserGroup[] = (data.groups ?? []).map(
          (g: { id: string; name: string; description?: string; color?: string; permissions: UserGroup['permissions']; userCount: number; isSystem: boolean }) => ({
            ...g,
            description: g.description || getGroupDescription(t, g.id),
            color: g.color || GROUP_COLORS[g.id] || 'bg-purple-50 text-purple-600',
          }),
        );
        setGroups(enriched);
      }
    } catch (err) {
      console.error('加载用户组失败:', err);
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    fetchGroups();
    fetchCatalog();
  }, [fetchGroups, fetchCatalog]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<UserGroup | null>(null);

  // 两段式离场动画：保持挂载至离场动画播放结束再卸载。
  const editModal = useExitAnimation(showModal);
  const createModal = useExitAnimation(showCreateModal);
  const deleteModal = useExitAnimation(deleteConfirm !== null);

  // 离场期间 deleteConfirm 会被置空 / editingGroup 可能被清；
  // 快照最后一个非空值，离场动画播放期间继续渲染，避免读到 null 崩溃。
  const editSnapshotRef = useRef<UserGroup | undefined>(undefined);
  if (editingGroup) editSnapshotRef.current = editingGroup;
  const editGroupForRender = editingGroup ?? editSnapshotRef.current;

  const deleteSnapshotRef = useRef<UserGroup | null>(null);
  if (deleteConfirm) deleteSnapshotRef.current = deleteConfirm;
  const deleteGroupForRender = deleteConfirm ?? deleteSnapshotRef.current;

  const handleEdit = (group: UserGroup) => {
    setEditingGroup(group);
    setShowModal(true);
  };

  // 保存用户组权限到后端
  const handleSave = async (data: { permissions: GroupPermissions; name?: string; description?: string; color?: string }) => {
    if (!editingGroup) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/groups', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          groupId: editingGroup.id,
          permissions: data.permissions,
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.color !== undefined ? { color: data.color } : {}),
        }),
      });
      if (res.ok) {
        setError('');
        setGroups((prev) =>
          prev.map((g) =>
            g.id === editingGroup.id
              ? {
                  ...g,
                  permissions: data.permissions,
                  ...(data.name ? { name: data.name } : {}),
                  ...(data.description !== undefined ? { description: data.description } : {}),
                  ...(data.color ? { color: data.color } : {}),
                }
              : g,
          ),
        );
        setShowModal(false);
        toast.success(t('common.saveSuccess'));
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t('common.saveFailed'));
        toast.error(t('common.saveFailed'), body.error);
      }
    } catch (err) {
      console.error('保存用户组失败:', err);
      setError(t('common.saveFailed'));
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  // 新建自定义用户组
  const handleCreate = async (data: { name: string; description: string; color: string; permissions: GroupPermissions }) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        setError('');
        const result = await res.json();
        if (result.group) {
          setGroups((prev) => [...prev, { ...result.group, description: data.description, color: data.color }]);
        }
        setShowCreateModal(false);
        toast.success(t('common.createSuccess'));
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t('common.createFailed'));
        toast.error(t('common.createFailed'), body.error);
      }
    } catch (err) {
      console.error('创建用户组失败:', err);
      setError(t('common.createFailed'));
      toast.error(t('common.createFailed'), t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  // 删除自定义用户组
  const handleDelete = async (group: UserGroup) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/groups?groupId=${encodeURIComponent(group.id)}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        setError('');
        setGroups((prev) => prev.filter((g) => g.id !== group.id));
        setDeleteConfirm(null);
        toast.success(t('common.deleteSuccess'));
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t('common.deleteFailed'));
        toast.error(t('common.deleteFailed'), body.error);
      }
    } catch (err) {
      console.error('删除用户组失败:', err);
      setError(t('common.deleteFailed'));
      toast.error(t('common.deleteFailed'), t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl md:text-2xl font-serif font-bold text-charcoal-800 dark:text-cream-100">{t('nav.userGroups')}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-white bg-rust-500 rounded-lg
                       hover:bg-rust-600 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            {t('admin.createGroup')}
          </button>
          <button
            onClick={() => fetchGroups()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-charcoal-500 rounded-lg
                       hover:bg-cream-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg border border-red-100">
          <span>{error}</span>
          <button onClick={() => setError('')} className="ml-3 text-red-400 hover:text-red-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-charcoal-400 text-sm">
          {t('common.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              catalog={catalog}
              expanded={expandedId === group.id}
              onToggle={() => setExpandedId(expandedId === group.id ? null : group.id)}
              onEdit={() => handleEdit(group)}
              onDelete={!group.isSystem ? () => setDeleteConfirm(group) : undefined}
            />
          ))}
        </div>
      )}

      {editModal.mounted && editGroupForRender && (
        <GroupModal
          group={editGroupForRender}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
          saving={saving}
          catalog={catalog}
          leaving={editModal.leaving}
        />
      )}

      {createModal.mounted && (
        <CreateGroupModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
          saving={saving}
          catalog={catalog}
          leaving={createModal.leaving}
        />
      )}

      {deleteModal.mounted && deleteGroupForRender && (
        <ModalPortal>
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm ${deleteModal.leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}>
          <div className={`bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-sm mx-4 p-6 ${deleteModal.leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}>
            <div className="mb-4">
              <p className="text-sm text-charcoal-700">
                {t('admin.deleteGroupConfirm', { name: deleteGroupForRender.name })}
              </p>
              {deleteGroupForRender.userCount > 0 && (
                <p className="text-xs text-amber-600 mt-1.5">
                  {t('admin.deleteGroupAffected', { n: deleteGroupForRender.userCount })}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm text-charcoal-500 rounded-lg hover:bg-cream-100 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleDelete(deleteGroupForRender)}
                disabled={saving}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded-lg hover:bg-red-600
                           transition-colors shadow-sm disabled:opacity-50"
              >
                {saving ? t('common.loading') : t('admin.deleteGroup')}
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}
    </div>
  );
}
