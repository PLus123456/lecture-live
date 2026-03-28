'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  RefreshCw,
  Filter,
  Trash2,
  X,
  Search,
  ChevronDown,
  Clock,
  HardDrive,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface UserItem {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  status: number;
  points: number;
  originalRole: 'ADMIN' | 'PRO' | 'FREE' | null;
  roleExpiresAt: string | null;
  avatarPath: string | null;
  createdAt: string;
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
  allowedModels: string;
}

function RoleBadge({ role }: { role: string }) {
  const { t } = useI18n();
  const styles: Record<string, string> = {
    ADMIN: 'bg-rust-50 text-rust-600 border-rust-200',
    PRO: 'bg-amber-50 text-amber-600 border-amber-200',
    FREE: 'bg-cream-200 text-charcoal-500 border-cream-300',
  };
  const labels: Record<string, string> = { ADMIN: t('roles.admin'), PRO: t('roles.pro'), FREE: t('roles.free') };

  return (
    <span className={`inline-block text-[10px] px-2 py-0.5 rounded border font-medium ${styles[role] || styles.FREE}`}>
      {labels[role] || role}
    </span>
  );
}

// ─── 配额进度条 ───
function QuotaBar({
  icon,
  label,
  used,
  limit,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  used: number;
  limit: number;
  unit: string;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const color = pct > 90 ? 'bg-red-400' : pct > 70 ? 'bg-amber-400' : 'bg-rust-400';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-charcoal-500">
        <span className="flex items-center gap-1">{icon}{label}</span>
        <span className="font-mono text-[10px]">
          {used.toLocaleString()} / {limit >= 999999 ? '∞' : limit.toLocaleString()} {unit}
        </span>
      </div>
      <div className="h-1.5 bg-cream-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── 用户详情/编辑弹窗 ───
function UserDetailModal({
  user,
  token,
  onClose,
  onUpdated,
}: {
  user: UserItem;
  token: string | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState(user.email);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const [points, setPoints] = useState(String(user.points));
  const [password, setPassword] = useState('');
  const [originalRole, setOriginalRole] = useState(user.originalRole ?? '');
  const [roleExpiresAt, setRoleExpiresAt] = useState(
    user.roleExpiresAt ? user.roleExpiresAt.slice(0, 16) : '' // ISO8601 截取到 datetime-local 格式
  );
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSave = async () => {
    setSubmitting(true);
    setError('');
    try {
      const body: Record<string, unknown> = { userId: user.id };

      if (email !== user.email) body.email = email;
      if (displayName !== user.displayName) body.displayName = displayName;
      if (role !== user.role) body.role = role;
      if (status !== user.status) body.status = status;
      if (Number(points) !== user.points) body.points = Number(points);
      if (password.length > 0) body.password = password;

      const newOriginalRole = originalRole || null;
      if (newOriginalRole !== (user.originalRole ?? null)) {
        body.originalRole = newOriginalRole;
      }

      const newExpiresAt = roleExpiresAt ? new Date(roleExpiresAt).toISOString() : null;
      const oldExpiresAt = user.roleExpiresAt;
      if (newExpiresAt !== oldExpiresAt) {
        body.roleExpiresAt = newExpiresAt;
      }

      // 如果没有实际改变的字段（除 userId），不发请求
      if (Object.keys(body).length <= 1) {
        onClose();
        return;
      }

      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || '保存失败');
        return;
      }
      onUpdated();
      onClose();
    } catch {
      setError('网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  // 头像首字母
  const initials = user.displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const inputClass =
    'w-full px-3 py-1.5 text-sm border border-cream-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200">
          <h3 className="text-base font-semibold text-charcoal-800">用户详情</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center
                       text-charcoal-400 hover:bg-cream-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mx-6 mt-4 text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</div>
        )}

        <div className="flex flex-col md:flex-row p-4 md:p-6 gap-4 md:gap-6">
          {/* ─── 左侧：头像 + ID + 配额（移动端水平紧凑） ─── */}
          <div className="w-full md:w-52 flex-shrink-0 space-y-4">
            {/* 头像 + ID + 配额 — 移动端横向排列 */}
            <div className="flex items-center gap-3 md:flex-col md:items-center">
              {user.avatarPath ? (
                <img
                  src={user.avatarPath}
                  alt={user.displayName}
                  className="w-14 h-14 md:w-20 md:h-20 rounded-full object-cover border-2 border-cream-200 flex-shrink-0"
                />
              ) : (
                <div className="w-14 h-14 md:w-20 md:h-20 rounded-full bg-gradient-to-br from-rust-400 to-rust-600 flex items-center justify-center border-2 border-cream-200 flex-shrink-0">
                  <span className="text-white text-lg md:text-xl font-bold">{initials}</span>
                </div>
              )}
              <div className="md:text-center">
                <div className="text-sm font-semibold text-charcoal-800">{user.displayName}</div>
                <RoleBadge role={user.role} />
              </div>
            </div>

            {/* ID */}
            <div className="bg-cream-50 rounded-lg p-3 space-y-1">
              <div className="text-[10px] text-charcoal-400 uppercase tracking-wider">用户 ID</div>
              <div className="text-xs font-mono text-charcoal-600 break-all select-all">{user.id}</div>
            </div>

            {/* 配额 */}
            <div className="bg-cream-50 rounded-lg p-3 space-y-3">
              <div className="text-[10px] text-charcoal-400 uppercase tracking-wider">配额使用</div>
              <QuotaBar
                icon={<Clock className="w-3 h-3" />}
                label="转录时间"
                used={user.transcriptionMinutesUsed}
                limit={user.transcriptionMinutesLimit}
                unit="min"
              />
              <QuotaBar
                icon={<HardDrive className="w-3 h-3" />}
                label="存储空间"
                used={user.storageHoursUsed}
                limit={user.storageHoursLimit}
                unit="h"
              />
            </div>
          </div>

          {/* ─── 右侧：编辑表单 ─── */}
          <div className="flex-1 space-y-3.5 min-w-0">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {/* 邮箱 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">邮箱</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
              </div>
              {/* 昵称 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">昵称</label>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {/* 用户状态 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">用户状态</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(Number(e.target.value))}
                  className={inputClass}
                >
                  <option value={1}>正常</option>
                  <option value={0}>禁用</option>
                </select>
              </div>
              {/* 用户组 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">用户组</label>
                <select value={role} onChange={(e) => setRole(e.target.value as UserItem['role'])} className={inputClass}>
                  <option value="FREE">Free</option>
                  <option value="PRO">Pro</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {/* 积分 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">积分</label>
                <input
                  type="number"
                  min={0}
                  value={points}
                  onChange={(e) => setPoints(e.target.value)}
                  className={inputClass}
                />
              </div>
              {/* 密码 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">
                  密码 <span className="text-charcoal-400 font-normal">(留空不修改)</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入新密码..."
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {/* 原始用户组 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">
                  原始用户组 <span className="text-charcoal-400 font-normal">(到期回退)</span>
                </label>
                <select
                  value={originalRole}
                  onChange={(e) => setOriginalRole(e.target.value)}
                  className={inputClass}
                >
                  <option value="">未设置</option>
                  <option value="FREE">Free</option>
                  <option value="PRO">Pro</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
              {/* 用户组过期时间 */}
              <div>
                <label className="text-xs font-medium text-charcoal-600 mb-1 block">
                  用户组过期 <span className="text-charcoal-400 font-normal">(留空=永久)</span>
                </label>
                <input
                  type="datetime-local"
                  value={roleExpiresAt}
                  onChange={(e) => setRoleExpiresAt(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            {/* 创建日期（只读） */}
            <div>
              <label className="text-xs font-medium text-charcoal-600 mb-1 block">创建日期</label>
              <div className="px-3 py-1.5 text-sm text-charcoal-500 bg-cream-50 rounded-lg border border-cream-200 font-mono">
                {new Date(user.createdAt).toLocaleString('zh-CN', {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </div>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-charcoal-500 rounded-lg hover:bg-cream-100 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={submitting}
            className="px-4 py-2 text-sm text-white bg-rust-500 rounded-lg hover:bg-rust-600
                       transition-colors shadow-sm disabled:opacity-50"
          >
            {submitting ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 创建用户弹窗 ───
function CreateUserModal({
  onClose,
  onCreated,
  token,
}: {
  onClose: () => void;
  onCreated: () => void;
  token: string | null;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('FREE');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!email || !displayName || !password) {
      setError('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ email, displayName, password, role }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create user');
        return;
      }
      onCreated();
      onClose();
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-cream-200 shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200">
          <h3 className="text-base font-semibold text-charcoal-800">{t('admin.newUser')}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center
                       text-charcoal-400 hover:bg-cream-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</div>
          )}
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('auth.displayName')} *</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
              placeholder="User display name"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('auth.email')} *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('auth.password')} *</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
              placeholder="Minimum 8 characters"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-charcoal-700 mb-1 block">{t('admin.userGroup')}</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300"
            >
              <option value="FREE">Free</option>
              <option value="PRO">Pro</option>
              <option value="ADMIN">Admin</option>
            </select>
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
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm text-white bg-rust-500 rounded-lg hover:bg-rust-600
                       transition-colors shadow-sm disabled:opacity-50"
          >
            {submitting ? t('common.loading') : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 主面板 ───
export default function UserManagementPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [detailUser, setDetailUser] = useState<UserItem | null>(null);
  const [showFilter, setShowFilter] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterGroup, setFilterGroup] = useState('');

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterText) params.set('filter', filterText);
      if (filterGroup) params.set('group', filterGroup);

      const res = await fetch(`/api/admin/users?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setLoading(false);
    }
  }, [token, filterText, filterGroup]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const toggleSelectAll = () => {
    if (selectedIds.size === users.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(users.map((u) => u.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleDelete = async (userIds: string[]) => {
    const filtered = userIds.filter((id) => id !== currentUser?.id);
    if (filtered.length === 0) return;

    if (!confirm(t('admin.deleteConfirm', { n: filtered.length }))) return;

    try {
      const res = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ userIds: filtered }),
      });
      if (res.ok) {
        setSelectedIds(new Set());
        fetchUsers();
      }
    } catch (err) {
      console.error('Failed to delete users:', err);
    }
  };

  const allSelected = users.length > 0 && selectedIds.size === users.length;
  const someSelected = selectedIds.size > 0;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-charcoal-800">{t('nav.users')}</h2>

      {/* Action bar: New, Refresh, Filter */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-rust-500 rounded-lg
                     hover:bg-rust-600 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          {t('admin.newUser')}
        </button>
        <button
          onClick={() => fetchUsers()}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-charcoal-600 bg-white rounded-lg
                     border border-cream-200 hover:bg-cream-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
        </button>
        <button
          onClick={() => setShowFilter(!showFilter)}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg border transition-colors
            ${showFilter
              ? 'text-rust-600 bg-rust-50 border-rust-200'
              : 'text-charcoal-600 bg-white border-cream-200 hover:bg-cream-50'
            }`}
        >
          <Filter className="w-4 h-4" />
          Filter
          <ChevronDown className={`w-3 h-3 transition-transform ${showFilter ? 'rotate-180' : ''}`} />
        </button>

        {someSelected && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-charcoal-400">{t('admin.nSelected', { n: selectedIds.size })}</span>
            <button
              onClick={() => handleDelete(Array.from(selectedIds))}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 bg-red-50 rounded-lg
                         border border-red-200 hover:bg-red-100 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              {t('admin.deleteSelected')}
            </button>
          </div>
        )}
      </div>

      {/* Filter panel */}
      {showFilter && (
        <div className="flex items-center gap-3 bg-cream-50 p-3 rounded-xl border border-cream-200">
          <div className="flex items-center gap-2 flex-1">
            <Search className="w-4 h-4 text-charcoal-400" />
            <input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchUsers()}
              placeholder={t('admin.searchByNameEmail')}
              className="flex-1 px-2 py-1.5 text-sm bg-white border border-cream-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-rust-200"
            />
          </div>
          <select
            value={filterGroup}
            onChange={(e) => setFilterGroup(e.target.value)}
            className="px-3 py-1.5 text-sm bg-white border border-cream-200 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-rust-200"
          >
            <option value="">{t('admin.allGroups')}</option>
            <option value="ADMIN">Admin</option>
            <option value="PRO">Pro</option>
            <option value="FREE">Free</option>
          </select>
          <button
            onClick={() => { setFilterText(''); setFilterGroup(''); }}
            className="text-xs text-charcoal-400 hover:text-charcoal-600 px-2"
          >
            Clear
          </button>
        </div>
      )}

      {/* User table */}
      <div className="bg-white rounded-xl border border-cream-200 overflow-hidden overflow-x-auto">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-cream-200 bg-cream-50/50">
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-cream-300 text-rust-500 focus:ring-rust-300"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
                {t('auth.displayName')}
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
                {t('auth.email')}
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
                {t('admin.userGroup')}
              </th>
              <th className="w-12 px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-charcoal-400">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-charcoal-300" />
                  {t('common.loading')}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-charcoal-400">
                  {t('admin.noUsersFound')}
                </td>
              </tr>
            ) : (
              users.map((user) => {
                const isSelected = selectedIds.has(user.id);
                const isSelf = user.id === currentUser?.id;
                return (
                  <tr
                    key={user.id}
                    onDoubleClick={() => setDetailUser(user)}
                    className={`
                      border-b border-cream-100 last:border-0 transition-colors cursor-pointer select-none
                      ${isSelected ? 'bg-rust-50/30' : 'hover:bg-cream-50'}
                      ${user.status === 0 ? 'opacity-50' : ''}
                    `}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(user.id)}
                        className="w-4 h-4 rounded border-cream-300 text-rust-500 focus:ring-rust-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rust-400 to-rust-600 flex items-center justify-center flex-shrink-0">
                          <span className="text-white text-xs font-bold">
                            {user.displayName.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                          </span>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-charcoal-800">
                            {user.displayName}
                            {isSelf && (
                              <span className="ml-1.5 text-[10px] text-charcoal-400">(you)</span>
                            )}
                            {user.status === 0 && (
                              <span className="ml-1.5 text-[10px] text-red-400">(禁用)</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-charcoal-500">
                      {user.email}
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="px-4 py-3">
                      {!isSelf && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete([user.id]); }}
                          className="w-7 h-7 rounded-md flex items-center justify-center
                                     text-charcoal-300 hover:text-red-400 hover:bg-red-50 transition-colors"
                          title="Delete user"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showCreateModal && (
        <CreateUserModal
          token={token}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => fetchUsers()}
        />
      )}

      {detailUser && (
        <UserDetailModal
          user={detailUser}
          token={token}
          onClose={() => setDetailUser(null)}
          onUpdated={() => fetchUsers()}
        />
      )}
    </div>
  );
}
