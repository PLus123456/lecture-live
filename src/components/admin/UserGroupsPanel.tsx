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
  expanded,
  onToggle,
}: {
  group: UserGroup;
  onEdit: () => void;
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
              {group.isSystem && (
                <span className="text-[10px] px-1.5 py-0.5 bg-cream-100 text-charcoal-400 rounded font-medium">
                  {t('admin.builtIn')}
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
          </div>
        </div>
      )}
    </div>
  );
}

function GroupModal({
  group,
  onClose,
  onSave,
  saving,
}: {
  group: UserGroup;
  onClose: () => void;
  onSave: (data: { permissions: UserGroup['permissions'] }) => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const [minutesLimit, setMinutesLimit] = useState(
    String(group.permissions.transcriptionMinutesLimit),
  );
  const [storageLimit, setStorageLimit] = useState(
    String(group.permissions.storageHoursLimit),
  );
  const [models, setModels] = useState(group.permissions.allowedModels);
  const [concurrent, setConcurrent] = useState(
    String(group.permissions.maxConcurrentSessions),
  );

  const handleSave = () => {
    onSave({
      permissions: {
        transcriptionMinutesLimit: parseInt(minutesLimit) || 60,
        storageHoursLimit: parseInt(storageLimit) || 10,
        allowedModels: models,
        maxConcurrentSessions: parseInt(concurrent) || 1,
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200">
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
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.allowedLlmModels')}</label>
            <input
              value={models}
              onChange={(e) => setModels(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
              placeholder="local,gpt,deepseek or * for all"
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
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-100">
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

export default function UserGroupsPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<UserGroup | undefined>(undefined);

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
          (g: { id: string; name: string; permissions: UserGroup['permissions']; userCount: number; isSystem: boolean }) => ({
            ...g,
            description: getGroupDescription(t, g.id),
            color: GROUP_COLORS[g.id] ?? 'bg-purple-50 text-purple-600',
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
  }, [fetchGroups]);

  const handleEdit = (group: UserGroup) => {
    setEditingGroup(group);
    setShowModal(true);
  };

  // 保存用户组权限到后端
  const handleSave = async (data: { permissions: UserGroup['permissions'] }) => {
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
        }),
      });
      if (res.ok) {
        // 更新本地状态
        setGroups((prev) =>
          prev.map((g) =>
            g.id === editingGroup.id
              ? { ...g, permissions: data.permissions }
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-charcoal-800">{t('nav.userGroups')}</h2>
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
        />
      )}
    </div>
  );
}
