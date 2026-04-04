'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Edit3,
  Users,
  Clock,
  HardDrive,
  Cpu,
  ChevronDown,
  ChevronUp,
  X,
  RefreshCw,
  Plus,
  Trash2,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface UserGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  permissions: {
    transcriptionMinutesLimit: number;
    storageHoursLimit: number;
    allowedModels: string;
    maxConcurrentSessions: number;
  };
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
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-charcoal-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-charcoal-400" />
          )}
        </div>
      </div>

      {expanded && (
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
      )}
    </div>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  modelCount: number;
}

function ProviderCheckboxList({
  providers,
  selected,
  selectAll,
  onToggle,
  onToggleAll,
}: {
  providers: ProviderInfo[];
  selected: Set<string>;
  selectAll: boolean;
  onToggle: (name: string) => void;
  onToggleAll: () => void;
}) {
  const { t } = useI18n();

  if (providers.length === 0) {
    return (
      <div className="text-xs text-charcoal-400 py-2">
        {t('admin.noProvidersHint')}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-cream-200 bg-cream-50/50 p-3 max-h-48 overflow-y-auto">
      <label className="flex items-center gap-2 cursor-pointer pb-1.5 border-b border-cream-200">
        <input
          type="checkbox"
          checked={selectAll}
          onChange={onToggleAll}
          className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
        />
        <span className="text-sm font-medium text-charcoal-700">{t('admin.selectAllProviders')}</span>
      </label>
      {providers.map((p) => (
        <label key={p.id} className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selectAll || selected.has(p.name)}
            disabled={selectAll}
            onChange={() => onToggle(p.name)}
            className="rounded border-cream-300 text-rust-500 focus:ring-rust-200 disabled:opacity-50"
          />
          <span className="text-sm text-charcoal-600">{p.name}</span>
          <span className="text-[10px] text-charcoal-400">({p.modelCount} models)</span>
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

function PermissionsForm({
  minutesLimit,
  setMinutesLimit,
  storageLimit,
  setStorageLimit,
  concurrent,
  setConcurrent,
  providers,
  selected,
  selectAll,
  onToggle,
  onToggleAll,
}: {
  minutesLimit: string;
  setMinutesLimit: (v: string) => void;
  storageLimit: string;
  setStorageLimit: (v: string) => void;
  concurrent: string;
  setConcurrent: (v: string) => void;
  providers: ProviderInfo[];
  selected: Set<string>;
  selectAll: boolean;
  onToggle: (name: string) => void;
  onToggleAll: () => void;
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
            value={storageLimit}
            onChange={(e) => setStorageLimit(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
          />
        </div>
      </div>
      <div>
        <label className="text-sm font-medium text-charcoal-700 mb-1.5 block">{t('admin.allowedLlmModels')}</label>
        <ProviderCheckboxList
          providers={providers}
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
    </>
  );
}

function usePermissionsForm(
  initPermissions: UserGroup['permissions'],
  providers: ProviderInfo[],
) {
  const [minutesLimit, setMinutesLimit] = useState(String(initPermissions.transcriptionMinutesLimit));
  const [storageLimit, setStorageLimit] = useState(String(initPermissions.storageHoursLimit));
  const [concurrent, setConcurrent] = useState(String(initPermissions.maxConcurrentSessions));

  const isAllInit = initPermissions.allowedModels === '*';
  const [selectAll, setSelectAll] = useState(isAllInit);
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (isAllInit) return new Set(providers.map((p) => p.name));
    return new Set(initPermissions.allowedModels.split(',').map((s) => s.trim()).filter(Boolean));
  });

  const handleToggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleToggleAll = () => {
    if (selectAll) {
      setSelectAll(false);
      setSelected(new Set());
    } else {
      setSelectAll(true);
      setSelected(new Set(providers.map((p) => p.name)));
    }
  };

  const buildPermissions = (): UserGroup['permissions'] => {
    const allowedModels = selectAll ? '*' : Array.from(selected).filter(Boolean).join(',') || 'local';
    return {
      transcriptionMinutesLimit: parseInt(minutesLimit) || 60,
      storageHoursLimit: parseInt(storageLimit) || 10,
      allowedModels,
      maxConcurrentSessions: parseInt(concurrent) || 1,
    };
  };

  return {
    minutesLimit, setMinutesLimit,
    storageLimit, setStorageLimit,
    concurrent, setConcurrent,
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
  providers,
}: {
  group: UserGroup;
  onClose: () => void;
  onSave: (data: { permissions: UserGroup['permissions']; name?: string; description?: string; color?: string }) => void;
  saving: boolean;
  providers: ProviderInfo[];
}) {
  const { t } = useI18n();
  const [groupName, setGroupName] = useState(group.name);
  const [groupDesc, setGroupDesc] = useState(group.description);
  const [groupColor, setGroupColor] = useState(group.color);
  const pf = usePermissionsForm(group.permissions, providers);

  const handleSave = () => {
    onSave({
      permissions: pf.buildPermissions(),
      ...(!group.isSystem ? { name: groupName, description: groupDesc, color: groupColor } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 sticky top-0 bg-white z-10">
          <h3 className="text-base font-semibold text-charcoal-800">
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
            providers={providers}
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
  providers,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; description: string; color: string; permissions: UserGroup['permissions'] }) => void;
  saving: boolean;
  providers: ProviderInfo[];
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLOR_OPTIONS[0].value);
  const defaultPermissions = {
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 10,
    allowedModels: 'local',
    maxConcurrentSessions: 1,
  };
  const pf = usePermissionsForm(defaultPermissions, providers);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 sticky top-0 bg-white z-10">
          <h3 className="text-base font-semibold text-charcoal-800">{t('admin.createGroup')}</h3>
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
            providers={providers}
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<UserGroup | undefined>(undefined);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  // 从后端加载 LLM 供应商列表
  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/llm-providers', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        const list: ProviderInfo[] = (data.providers ?? []).map(
          (p: { id: string; name: string; models?: unknown[] }) => ({
            id: p.id,
            name: p.name,
            modelCount: Array.isArray(p.models) ? p.models.length : 0,
          }),
        );
        setProviders(list);
      }
    } catch (err) {
      console.error('加载供应商失败:', err);
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
    fetchProviders();
  }, [fetchGroups, fetchProviders]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<UserGroup | null>(null);

  const handleEdit = (group: UserGroup) => {
    setEditingGroup(group);
    setShowModal(true);
  };

  // 保存用户组权限到后端
  const handleSave = async (data: { permissions: UserGroup['permissions']; name?: string; description?: string; color?: string }) => {
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
      }
    } catch (err) {
      console.error('保存用户组失败:', err);
    } finally {
      setSaving(false);
    }
  };

  // 新建自定义用户组
  const handleCreate = async (data: { name: string; description: string; color: string; permissions: UserGroup['permissions'] }) => {
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
        const result = await res.json();
        if (result.group) {
          setGroups((prev) => [...prev, { ...result.group, description: data.description, color: data.color }]);
        }
        setShowCreateModal(false);
      }
    } catch (err) {
      console.error('创建用户组失败:', err);
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
        setGroups((prev) => prev.filter((g) => g.id !== group.id));
        setDeleteConfirm(null);
      }
    } catch (err) {
      console.error('删除用户组失败:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-charcoal-800">{t('nav.userGroups')}</h2>
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

      {showModal && editingGroup && (
        <GroupModal
          group={editingGroup}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
          saving={saving}
          providers={providers}
        />
      )}

      {showCreateModal && (
        <CreateGroupModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
          saving={saving}
          providers={providers}
        />
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-sm mx-4 p-6">
            <p className="text-sm text-charcoal-700 mb-4">
              {t('admin.deleteGroupConfirm', { name: deleteConfirm.name })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm text-charcoal-500 rounded-lg hover:bg-cream-100 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
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
