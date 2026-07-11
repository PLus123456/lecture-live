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
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import { useExitAnimation } from '@/hooks/useExitAnimation';

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
  onEdit,
  onDelete,
  expanded,
  onToggle,
}: {
  group: UserGroup;
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

/** 一个「开/关」行内开关（用于实时摘要 / 总摘要 / 允许思考） */
function ToggleRow({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-cream-200 px-3 py-2.5">
      <span className="flex items-center gap-2 text-sm text-charcoal-700">
        {icon}
        <span>
          {label}
          {hint ? <span className="ml-2 text-[11px] text-charcoal-400">{hint}</span> : null}
        </span>
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

function PermissionsForm({
  minutesLimit,
  setMinutesLimit,
  storageLimit,
  setStorageLimit,
  concurrent,
  setConcurrent,
  models,
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
}: {
  minutesLimit: string;
  setMinutesLimit: (v: string) => void;
  storageLimit: string;
  setStorageLimit: (v: string) => void;
  concurrent: string;
  setConcurrent: (v: string) => void;
  models: ModelInfo[];
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
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.transcriptionMinMonth')}</label>
          <input
            type="number"
            value={minutesLimit}
            onChange={(e) => setMinutesLimit(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.storageHours')}</label>
          <input
            type="number"
            step="0.5"
            min="0"
            value={storageLimit}
            onChange={(e) => setStorageLimit(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
          />
        </div>
      </div>
      <div>
        <label className="text-sm font-medium text-charcoal-700 mb-1.5 block">{t('admin.allowedLlmModels')}</label>
        <ModelCheckboxList
          models={models}
          selected={selected}
          selectAll={selectAll}
          onToggle={onToggle}
          onToggleAll={onToggleAll}
        />
      </div>
      <div>
        <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.maxConcurrent')}</label>
        <input
          type="number"
          value={concurrent}
          onChange={(e) => setConcurrent(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
        />
      </div>

      {/* ── 能力开关 ── */}
      <div className="space-y-2 pt-1">
        <label className="text-sm font-medium text-charcoal-700 block">{t('admin.capabilities')}</label>

        {/* 思考：开关 + 最大深度 */}
        <div className="rounded-lg border border-cream-200 px-3 py-2.5 space-y-2.5">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="flex items-center gap-2 text-sm text-charcoal-700">
              <Brain className="w-3.5 h-3.5 text-charcoal-400" />
              {t('admin.allowThinking')}
            </span>
            <input
              type="checkbox"
              checked={thinkingEnabled}
              onChange={(e) => setThinkingEnabled(e.target.checked)}
              className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
            />
          </label>
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

        <ToggleRow
          icon={<Sparkles className="w-3.5 h-3.5 text-charcoal-400" />}
          label={t('admin.allowRealtimeSummary')}
          checked={allowRealtime}
          onChange={setAllowRealtime}
        />
        <ToggleRow
          icon={<FileText className="w-3.5 h-3.5 text-charcoal-400" />}
          label={t('admin.allowFinalSummary')}
          checked={allowFinal}
          onChange={setAllowFinal}
        />
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
  models,
  leaving,
}: {
  group: UserGroup;
  onClose: () => void;
  onSave: (data: { permissions: GroupPermissions; name?: string; description?: string; color?: string }) => void;
  saving: boolean;
  models: ModelInfo[];
  leaving: boolean;
}) {
  const { t } = useI18n();
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
  );
}

function CreateGroupModal({
  onClose,
  onCreate,
  saving,
  models,
  leaving,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; description: string; color: string; permissions: GroupPermissions }) => void;
  saving: boolean;
  models: ModelInfo[];
  leaving: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLOR_OPTIONS[0].value);
  // 新建自定义组默认「全部允许」（思考 high、两摘要开），管理员按需收紧
  const defaultPermissions: GroupPermissions = {
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 10,
    allowedModels: 'local',
    maxConcurrentSessions: 1,
    maxThinkingDepth: 'high',
    allowRealtimeSummary: true,
    allowFinalSummary: true,
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
  const [models, setModels] = useState<ModelInfo[]>([]);

  // 从后端加载可选的 LLM 模型（CHAT 用途，按底层 modelId 去重——同一模型配在多个供应商/用途下
  // 只出现一次，修复历史上「一个模型出现很多次」的问题）。allowedModels 存的就是这些 modelId。
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/llm-providers', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        const seen = new Set<string>();
        const list: ModelInfo[] = [];
        for (const p of (data.providers ?? []) as {
          name: string;
          models?: { modelId?: string; displayName?: string; purpose?: string }[];
        }[]) {
          for (const m of p.models ?? []) {
            const modelId = (m.modelId ?? '').trim();
            // 只列对话可选的 CHAT 模型（allowedModels 仅作用于聊天选择器）
            if (!modelId || m.purpose !== 'CHAT' || seen.has(modelId)) continue;
            seen.add(modelId);
            list.push({
              modelId,
              displayName: (m.displayName || modelId).trim(),
              providerName: p.name,
            });
          }
        }
        setModels(list);
      }
    } catch (err) {
      console.error('加载模型失败:', err);
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
    fetchModels();
  }, [fetchGroups, fetchModels]);

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
          models={models}
          leaving={editModal.leaving}
        />
      )}

      {createModal.mounted && (
        <CreateGroupModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
          saving={saving}
          models={models}
          leaving={createModal.leaving}
        />
      )}

      {deleteModal.mounted && deleteGroupForRender && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm ${deleteModal.leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}>
          <div className={`bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-sm mx-4 p-6 ${deleteModal.leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}>
            <p className="text-sm text-charcoal-700 mb-4">
              {t('admin.deleteGroupConfirm', { name: deleteGroupForRender.name })}
            </p>
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
      )}
    </div>
  );
}
