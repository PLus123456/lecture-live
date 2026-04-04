'use client';

import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  EllipsisVertical,
  FolderOpen,
  Folders,
  Info,
  Inbox,
  Loader2,
  Pencil,
  Plus,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import ActionSheet, { type ActionSheetItem } from '@/components/mobile/ActionSheet';
import { useIsMobile } from '@/hooks/useIsMobile';

/* ─── Types ─── */
interface FolderListItem {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  sessionCount: number;
  keywordCount: number;
  childCount: number;
  depth: number;
  path: string[];
}

interface UnarchivedSession {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  durationMs: number;
  courseName: string | null;
}

/* ─── Context menu type ─── */
interface ContextMenuState {
  x: number;
  y: number;
  folderId: string | null;
}

/* ─── Selection rectangle ─── */
interface SelectionRect {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

const UNARCHIVED_ID = '__unarchived__';

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/* Normalize selection rectangle to top-left + width/height */
function normalizeRect(rect: SelectionRect) {
  const x = Math.min(rect.startX, rect.currentX);
  const y = Math.min(rect.startY, rect.currentY);
  const w = Math.abs(rect.currentX - rect.startX);
  const h = Math.abs(rect.currentY - rect.startY);
  return { x, y, w, h };
}

/* Check if two rectangles overlap */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: DOMRect
) {
  return !(
    a.x + a.w < b.left ||
    a.x > b.right ||
    a.y + a.h < b.top ||
    a.y > b.bottom
  );
}

export default function FoldersPage() {
  const { token } = useAuth();
  const router = useRouter();
  const isMobile = useIsMobile();

  /* ─── Data state ─── */
  const [folders, setFolders] = useState<FolderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [unarchivedSessions, setUnarchivedSessions] = useState<UnarchivedSession[]>([]);
  const [loadingUnarchived, setLoadingUnarchived] = useState(true);

  /* ─── Selection state ─── */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  /* ─── New folder modal ─── */
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  /* ─── Context menu ─── */
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [mobileActionFolderId, setMobileActionFolderId] = useState<string | null>(null);

  /* ─── Rename ─── */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  /* ─── Properties modal ─── */
  const [propertiesFolder, setPropertiesFolder] = useState<FolderListItem | null>(null);

  /* ─── Clipboard ─── */
  const [clipboard, setClipboard] = useState<{ ids: string[]; mode: 'copy' | 'cut' } | null>(null);

  /* ─── Drag-select ─── */
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderItemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const isDraggingRef = useRef(false);
  const lastClickedIdRef = useRef<string | null>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [token]);

  /* ─── Data loading ─── */
  const loadFolders = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/folders', { headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to load folders');
      setFolders(Array.isArray(data) ? (data as FolderListItem[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load folders');
    } finally {
      setLoading(false);
    }
  }, [authHeaders, token]);

  const loadUnarchivedSessions = useCallback(async () => {
    if (!token) return;
    setLoadingUnarchived(true);
    try {
      const res = await fetch('/api/sessions?unarchived=true', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setUnarchivedSessions(Array.isArray(data) ? data : []);
      }
    } catch {
      // silent
    } finally {
      setLoadingUnarchived(false);
    }
  }, [authHeaders, token]);

  useEffect(() => {
    void loadFolders();
    void loadUnarchivedSessions();
  }, [loadFolders, loadUnarchivedSessions]);

  // 只有选中了非"未归档"的文件夹时才显示删除按钮
  const hasDeletableSelection = Array.from(selectedIds).some((id) => id !== UNARCHIVED_ID);
  const deletableIds = Array.from(selectedIds).filter((id) => id !== UNARCHIVED_ID);
  const singleDeletableId = deletableIds.length === 1 ? deletableIds[0] : null;

  const resetMessages = () => {
    setError(null);
    setSuccess(null);
  };

  /* ─── Root-level folders only ─── */
  const rootFolders = useMemo(
    () => folders.filter((f) => f.parentId === null),
    [folders]
  );

  /* ─── 获取当前有序 ID 列表（用于 Shift 范围选择）─── */
  const getOrderedIds = useCallback(() => {
    const ids: string[] = rootFolders.map((f) => f.id);
    if (unarchivedSessions.length > 0) ids.push(UNARCHIVED_ID);
    return ids;
  }, [rootFolders, unarchivedSessions]);

  /* ─── Selection operations ─── */
  const toggleSelect = (id: string, multi: boolean, shift?: boolean) => {
    if (shift && lastClickedIdRef.current) {
      // Shift+Click: 选中 lastClicked 到当前 id 之间的所有项
      const ordered = getOrderedIds();
      const fromIdx = ordered.indexOf(lastClickedIdRef.current);
      const toIdx = ordered.indexOf(id);
      if (fromIdx !== -1 && toIdx !== -1) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        setSelectedIds((prev) => {
          const next = new Set(multi ? prev : []);
          for (let i = start; i <= end; i++) next.add(ordered[i]);
          return next;
        });
        // shift 选不更新 lastClickedIdRef
        return;
      }
    }
    setSelectedIds((prev) => {
      if (multi) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      if (prev.has(id) && prev.size === 1) return new Set();
      return new Set([id]);
    });
    lastClickedIdRef.current = id;
  };

  const clearSelection = () => setSelectedIds(new Set());

  /* ─── Folder ref registration ─── */
  const setFolderRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      folderItemRefs.current.set(id, el);
    } else {
      folderItemRefs.current.delete(id);
    }
  }, []);

  /* ─── Create folder ─── */
  const handleCreateFolder = async () => {
    if (!token) return;
    resetMessages();
    setSaving(true);
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: newFolderName, parentId: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create folder');
      setNewFolderName('');
      setShowCreateModal(false);
      setSuccess('Folder created');
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create folder');
    } finally {
      setSaving(false);
    }
  };

  /* ─── Rename ─── */
  const startRename = (id: string) => {
    const f = folders.find((f) => f.id === id);
    if (!f) return;
    setRenamingId(id);
    setRenameValue(f.name);
    setCtxMenu(null);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  const commitRename = async () => {
    if (!renamingId || !token) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    resetMessages();
    setSaving(true);
    try {
      const res = await fetch(`/api/folders/${renamingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setSuccess('Renamed successfully');
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    } finally {
      setSaving(false);
      setRenamingId(null);
    }
  };

  /* ─── Batch delete ─── */
  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0 || !token) return;
    const ids = Array.from(selectedIds).filter((id) => id !== UNARCHIVED_ID);
    if (ids.length === 0) return;

    const confirmed = window.confirm(
      `Delete ${ids.length} folder${ids.length > 1 ? 's' : ''}? (Only empty folders can be deleted)`
    );
    if (!confirmed) return;

    resetMessages();
    setSaving(true);
    try {
      const res = await fetch('/api/folders/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      const msg = data.blocked?.length
        ? `Deleted ${data.deleted}, ${data.blocked.length} non-empty folder(s) skipped: ${data.blocked.join(', ')}`
        : `Deleted ${data.deleted} folder${data.deleted > 1 ? 's' : ''}`;
      setSuccess(msg);
      clearSelection();
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setSaving(false);
    }
  };

  /* ─── Single delete ─── */
  const handleDeleteSingle = async (id: string) => {
    if (!token) return;
    const f = folders.find((f) => f.id === id);
    const confirmed = window.confirm(
      `Delete "${f?.name ?? id}"? (Must be empty)`
    );
    if (!confirmed) return;
    resetMessages();
    setSaving(true);
    try {
      const res = await fetch(`/api/folders/${id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setSuccess('Folder deleted');
      clearSelection();
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setSaving(false);
    }
  };

  const handleRenameFolderMobile = useCallback(async (id: string) => {
    if (!token) return;
    const folder = folders.find((item) => item.id === id);
    const nextName = window.prompt('Rename folder', folder?.name || '');
    const trimmed = nextName?.trim();
    if (!trimmed) {
      return;
    }

    resetMessages();
    setSaving(true);
    try {
      const res = await fetch(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setSuccess('Renamed successfully');
      await loadFolders();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Rename failed');
    } finally {
      setSaving(false);
    }
  }, [authHeaders, folders, loadFolders, token]);

  /* ─── Clipboard operations ─── */
  const handleCopy = (ids: string[]) => {
    setClipboard({ ids: ids.filter((id) => id !== UNARCHIVED_ID), mode: 'copy' });
    setCtxMenu(null);
    setSuccess('Copied');
  };

  const handleCut = (ids: string[]) => {
    setClipboard({ ids: ids.filter((id) => id !== UNARCHIVED_ID), mode: 'cut' });
    setCtxMenu(null);
    setSuccess('Cut');
  };

  const handlePaste = async (targetParentId: string | null) => {
    if (!clipboard || clipboard.ids.length === 0 || !token) return;
    setCtxMenu(null);
    resetMessages();
    setSaving(true);
    try {
      for (const id of clipboard.ids) {
        const res = await fetch(`/api/folders/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ parentId: targetParentId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Failed to move ${id}`);
        }
      }
      setSuccess(`Moved ${clipboard.ids.length} folder${clipboard.ids.length > 1 ? 's' : ''}`);
      if (clipboard.mode === 'cut') setClipboard(null);
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Paste failed');
    } finally {
      setSaving(false);
    }
  };

  /* ─── Share folder (copy link) ─── */
  const handleShareFolder = () => {
    const id = singleDeletableId;
    if (!id) return;
    const url = `${window.location.origin}/folders/${id}`;
    navigator.clipboard.writeText(url).then(() => setSuccess('Folder link copied!'));
  };

  /* ─── "..." 按钮触发右键菜单 ─── */
  const handleMoreFolderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const id = singleDeletableId;
    if (!id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({ x: rect.left, y: rect.bottom + 4, folderId: id });
  };

  // Close context menu
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu]);

  // Esc to close menu and cancel rename
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCtxMenu(null);
        setRenamingId(null);
        setShowCreateModal(false);
        clearSelection();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  /* ─── Global right-click intercept ─── */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && containerRef.current.contains(e.target as Node)) {
        const folderEl = (e.target as HTMLElement).closest('[data-folder-id]');
        if (folderEl) {
          const id = folderEl.getAttribute('data-folder-id');
          if (id) {
            e.preventDefault();
            if (!selectedIds.has(id)) {
              setSelectedIds(new Set([id]));
            }
            setCtxMenu({ x: e.clientX, y: e.clientY, folderId: id });
            return;
          }
        }
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, folderId: null });
      }
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, [selectedIds]);

  /* ─── Drag-select logic (with auto-scroll) ─── */
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-folder-id]') || target.closest('button') || target.closest('input')) return;
    if (e.button !== 0) return;

    const container = containerRef.current;
    if (!container) return;

    isDraggingRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const EDGE = 40; // 距边缘多少像素开始滚动
    const SPEED = 8; // 每帧滚动像素

    const doAutoScroll = (clientY: number) => {
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      if (clientY < bounds.top + EDGE) {
        container.scrollTop -= SPEED;
      } else if (clientY > bounds.bottom - EDGE) {
        container.scrollTop += SPEED;
      }
    };

    let latestY = startY;

    const scrollLoop = () => {
      if (!isDraggingRef.current) return;
      doAutoScroll(latestY);
      scrollTimerRef.current = requestAnimationFrame(scrollLoop);
    };

    const onMouseMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!isDraggingRef.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

      if (!isDraggingRef.current) {
        isDraggingRef.current = true;
        scrollTimerRef.current = requestAnimationFrame(scrollLoop);
      }

      latestY = me.clientY;

      const rect: SelectionRect = {
        startX,
        startY,
        currentX: me.clientX,
        currentY: me.clientY,
      };
      setSelectionRect(rect);

      const norm = normalizeRect(rect);
      const newSelected = new Set<string>();
      folderItemRefs.current.forEach((el, id) => {
        const r = el.getBoundingClientRect();
        if (rectsOverlap(norm, r)) {
          newSelected.add(id);
        }
      });
      setSelectedIds(newSelected);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (scrollTimerRef.current) { cancelAnimationFrame(scrollTimerRef.current); scrollTimerRef.current = null; }
      setSelectionRect(null);

      if (!isDraggingRef.current) {
        clearSelection();
      }
      isDraggingRef.current = false;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  /* ─── Context menu items ─── */
  const ctxMenuItems = useMemo(() => {
    if (!ctxMenu) return [];

    const items: { label: string; icon: React.ReactNode; action: () => void; danger?: boolean; disabled?: boolean }[] = [];

    if (ctxMenu.folderId && ctxMenu.folderId !== UNARCHIVED_ID) {
      const targetIds = selectedIds.size > 1 && selectedIds.has(ctxMenu.folderId)
        ? Array.from(selectedIds).filter((id) => id !== UNARCHIVED_ID)
        : [ctxMenu.folderId];

      items.push({
        label: 'Open Folder',
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        action: () => {
          router.push(`/folders/${ctxMenu.folderId}`);
          setCtxMenu(null);
        },
      });
      items.push({
        label: 'Rename',
        icon: <Pencil className="h-3.5 w-3.5" />,
        action: () => startRename(ctxMenu.folderId!),
        disabled: targetIds.length > 1,
      });
      items.push({
        label: 'Copy',
        icon: <Copy className="h-3.5 w-3.5" />,
        action: () => handleCopy(targetIds),
      });
      items.push({
        label: 'Cut',
        icon: <Clipboard className="h-3.5 w-3.5" />,
        action: () => handleCut(targetIds),
      });
      if (clipboard && clipboard.ids.length > 0) {
        items.push({
          label: `Paste into folder (${clipboard.ids.length})`,
          icon: <ClipboardPaste className="h-3.5 w-3.5" />,
          action: () => void handlePaste(ctxMenu.folderId),
        });
      }
      items.push({
        label: 'Share',
        icon: <Share2 className="h-3.5 w-3.5" />,
        action: () => {
          if (ctxMenu.folderId) {
            const url = `${window.location.origin}/folders/${ctxMenu.folderId}`;
            navigator.clipboard.writeText(url).then(() => setSuccess('Folder link copied!'));
          }
          setCtxMenu(null);
        },
        disabled: targetIds.length > 1,
      });
      // 属性（仅单选时可用）
      items.push({
        label: 'Properties',
        icon: <Info className="h-3.5 w-3.5" />,
        action: () => {
          const f = folders.find((f) => f.id === ctxMenu.folderId);
          if (f) setPropertiesFolder(f);
          setCtxMenu(null);
        },
        disabled: targetIds.length > 1,
      });
      items.push({
        label: targetIds.length > 1 ? `Delete ${targetIds.length} items` : 'Delete',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        action: () => {
          setCtxMenu(null);
          if (targetIds.length === 1) {
            void handleDeleteSingle(targetIds[0]);
          } else {
            void handleDeleteSelected();
          }
        },
        danger: true,
      });
    } else {
      items.push({
        label: 'New Folder',
        icon: <Plus className="h-3.5 w-3.5" />,
        action: () => {
          setCtxMenu(null);
          setShowCreateModal(true);
        },
      });
      if (clipboard && clipboard.ids.length > 0) {
        items.push({
          label: `Paste to root (${clipboard.ids.length})`,
          icon: <ClipboardPaste className="h-3.5 w-3.5" />,
          action: () => void handlePaste(null),
        });
      }
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, selectedIds, clipboard, folders]);

  const mobileActionItems: ActionSheetItem[] =
    !mobileActionFolderId || mobileActionFolderId === UNARCHIVED_ID
      ? [
          {
            key: 'open-unarchived',
            label: 'Open unarchived recordings',
            icon: <Inbox className="h-4 w-4" />,
            onSelect: () => router.push('/folders/unarchived'),
          },
        ]
      : [
          {
            key: 'open',
            label: 'Open folder',
            icon: <FolderOpen className="h-4 w-4" />,
            onSelect: () => router.push(`/folders/${mobileActionFolderId}`),
          },
          {
            key: 'rename',
            label: 'Rename',
            icon: <Pencil className="h-4 w-4" />,
            onSelect: () => void handleRenameFolderMobile(mobileActionFolderId),
          },
          {
            key: 'share',
            label: 'Copy folder link',
            icon: <Share2 className="h-4 w-4" />,
            onSelect: () => {
              const url = `${window.location.origin}/folders/${mobileActionFolderId}`;
              void navigator.clipboard.writeText(url).then(() => setSuccess('Folder link copied!'));
            },
          },
          {
            key: 'properties',
            label: 'Properties',
            icon: <Info className="h-4 w-4" />,
            onSelect: () => {
              const folder = folders.find((item) => item.id === mobileActionFolderId);
              if (folder) {
                setPropertiesFolder(folder);
              }
            },
          },
          {
            key: 'delete',
            label: 'Delete',
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onSelect: () => void handleDeleteSingle(mobileActionFolderId),
          },
        ];

  const startLongPress = (folderId: string) => {
    if (!isMobile) return;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = setTimeout(() => {
      setMobileActionFolderId(folderId);
    }, 450);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-cream-50 pb-28">
        <header className="sticky top-0 z-20 border-b border-cream-200 bg-white/95 px-4 py-4 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="font-serif text-xl font-bold text-charcoal-800">Folders</h1>
              <p className="text-xs text-charcoal-400">
                {folders.length} folder{folders.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 rounded-full bg-rust-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-rust-500/20"
            >
              <Plus className="h-4 w-4" />
              New
            </button>
          </div>
        </header>

        {(error || success) ? (
          <div
            className={`mx-4 mt-4 flex items-center justify-between rounded-2xl border px-4 py-3 text-sm ${
              error
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            <span>{error || success}</span>
            <button onClick={resetMessages}>
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        <div className="space-y-3 px-4 py-4">
          {rootFolders.length === 0 && unarchivedSessions.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-cream-300 bg-white px-6 py-16 text-center animate-fade-in-up">
              <FolderOpen className="mx-auto mb-3 h-10 w-10 text-charcoal-200 animate-breathe" />
              <p className="text-sm font-medium text-charcoal-500">No folders yet</p>
              <p className="mt-1 text-xs text-charcoal-400">
                Create your first folder to organize recordings by course or topic.
              </p>
            </div>
          ) : (
            <>
              {rootFolders.map((folder, index) => (
                <button
                  key={folder.id}
                  onClick={() => {
                    cancelLongPress();
                    router.push(`/folders/${folder.id}`);
                  }}
                  onTouchStart={() => startLongPress(folder.id)}
                  onTouchEnd={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  className="flex w-full items-center justify-between rounded-2xl border border-cream-200 bg-white px-4 py-4 text-left shadow-sm animate-list-item-in card-hover-lift"
                  style={{ animationDelay: `${Math.min(index * 0.06, 0.5)}s` }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-5 w-5 text-rust-500" />
                      <span className="truncate text-base font-semibold text-charcoal-800">
                        {folder.name}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-charcoal-400">
                      {folder.sessionCount} recordings · {folder.childCount} subfolders · {folder.keywordCount} keywords
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-charcoal-300" />
                </button>
              ))}

              {unarchivedSessions.length > 0 ? (
                <button
                  onClick={() => router.push('/folders/unarchived')}
                  onTouchStart={() => startLongPress(UNARCHIVED_ID)}
                  onTouchEnd={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  className="flex w-full items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-left transition-all duration-200 animate-list-item-in card-hover-lift"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Inbox className="h-5 w-5 text-amber-600" />
                      <span className="truncate text-base font-semibold text-charcoal-800">
                        Unarchived Recordings
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-charcoal-500">
                      {unarchivedSessions.length} recordings not assigned to a folder
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-charcoal-300" />
                </button>
              ) : null}
            </>
          )}
        </div>

        <ActionSheet
          open={mobileActionFolderId !== null}
          onClose={() => setMobileActionFolderId(null)}
          title="Folder actions"
          items={mobileActionItems}
        />

        {propertiesFolder && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-backdrop-enter"
            onClick={() => setPropertiesFolder(null)}
          >
            <div
              className="mx-4 w-full max-w-sm rounded-2xl border border-cream-200 bg-white p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center gap-2">
                <FolderOpen className="h-5 w-5 text-rust-500" />
                <h2 className="font-serif text-base font-bold text-charcoal-800">
                  Folder Properties
                </h2>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between border-b border-cream-100 pb-2">
                  <span className="text-charcoal-400">Name</span>
                  <span className="font-medium text-charcoal-800">{propertiesFolder.name}</span>
                </div>
                <div className="flex justify-between border-b border-cream-100 pb-2">
                  <span className="text-charcoal-400">Recordings</span>
                  <span className="font-medium text-charcoal-800">{propertiesFolder.sessionCount}</span>
                </div>
                <div className="flex justify-between border-b border-cream-100 pb-2">
                  <span className="text-charcoal-400">Keywords</span>
                  <span className="font-medium text-charcoal-800">{propertiesFolder.keywordCount}</span>
                </div>
                <div className="flex justify-between border-b border-cream-100 pb-2">
                  <span className="text-charcoal-400">Subfolders</span>
                  <span className="font-medium text-charcoal-800">{propertiesFolder.childCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-charcoal-400">Created</span>
                  <span className="font-medium text-charcoal-800">{formatDate(propertiesFolder.createdAt)}</span>
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => setPropertiesFolder(null)}
                  className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 transition-colors hover:bg-cream-100"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {showCreateModal && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-backdrop-enter"
            onClick={() => setShowCreateModal(false)}
          >
            <div
              className="mx-4 w-full max-w-sm rounded-2xl border border-cream-200 bg-white p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="mb-4 font-serif text-base font-bold text-charcoal-800">
                New Folder
              </h2>
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newFolderName.trim()) void handleCreateFolder();
                  if (e.key === 'Escape') setShowCreateModal(false);
                }}
                placeholder="Folder name..."
                autoFocus
                className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm text-charcoal-700 outline-none transition-colors focus:border-rust-300 focus:ring-1 focus:ring-rust-200"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 transition-colors hover:bg-cream-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleCreateFolder()}
                  disabled={saving || !newFolderName.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rust-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rust-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  Create
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden select-none">
      {/* ── Header ── */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-cream-200 bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <Folders className="h-5 w-5 text-rust-500" />
          <h1 className="font-serif text-lg font-bold text-charcoal-800">Folders</h1>
          <span className="text-xs text-charcoal-400">
            {folders.length} folder{folders.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* 选中文件夹时显示的操作按钮 */}
          {hasDeletableSelection && (
            <>
              <FolderExpandBtn icon={<Pencil className="w-3.5 h-3.5" />} label="Rename" title="Rename" variant="default"
                onClick={() => { if (singleDeletableId) startRename(singleDeletableId); }} disabled={!singleDeletableId} />
              <FolderExpandBtn icon={<Share2 className="w-3.5 h-3.5" />} label="Share" title="Share link" variant="default"
                onClick={handleShareFolder} disabled={!singleDeletableId} />
              <FolderExpandBtn icon={<EllipsisVertical className="w-3.5 h-3.5" />} label="" title="More" variant="default"
                onClick={handleMoreFolderClick} disabled={!singleDeletableId} noExpand />
              <FolderExpandBtn icon={<Trash2 className="w-3.5 h-3.5" />} label={`Delete (${deletableIds.length})`} title="Delete" variant="danger"
                onClick={() => void handleDeleteSelected()} disabled={saving} />
            </>
          )}

          <FolderExpandBtn icon={<Plus className="w-3.5 h-3.5" />} label="New Folder" title="New Folder" variant="primary"
            onClick={() => setShowCreateModal(true)} />
        </div>
      </header>

      {/* ── Messages ── */}
      {(error || success) && (
        <div
          className={`flex flex-shrink-0 items-center justify-between border-b px-6 py-2 text-sm ${
            error
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          <span>{error || success}</span>
          <button
            onClick={resetMessages}
            className="ml-2 rounded p-0.5 opacity-60 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Main content area ── */}
      <div
        ref={containerRef}
        className="relative flex-1 overflow-y-auto px-6 py-4"
        onMouseDown={handleMouseDown}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-charcoal-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : rootFolders.length === 0 && unarchivedSessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center animate-fade-in-up">
            <FolderOpen className="mb-3 h-12 w-12 text-charcoal-200 animate-breathe" />
            <p className="text-sm text-charcoal-500">No folders yet</p>
            <p className="mt-1 text-xs text-charcoal-300">
              Create your first folder to organize recordings by course or topic.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* ── Folder list ── */}
            {rootFolders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                isSelected={selectedIds.has(folder.id)}
                isRenaming={renamingId === folder.id}
                renameValue={renameValue}
                onRenameChange={setRenameValue}
                onRenameCommit={() => void commitRename()}
                onRenameCancel={() => setRenamingId(null)}
                renameInputRef={renameInputRef}
                isCut={clipboard?.mode === 'cut' && clipboard.ids.includes(folder.id)}
                onIconClick={(e) => {
                  e.stopPropagation();
                  toggleSelect(folder.id, e.metaKey || e.ctrlKey, e.shiftKey);
                }}
                onBodyClick={() => router.push(`/folders/${folder.id}`)}
                setRef={(el) => setFolderRef(folder.id, el)}
              />
            ))}

            {/* ── Unarchived recordings ── */}
            {!loadingUnarchived && unarchivedSessions.length > 0 && (
              <div
                data-folder-id={UNARCHIVED_ID}
                ref={(el) => setFolderRef(UNARCHIVED_ID, el)}
                className="flex items-center gap-2 transition-all animate-list-item-in"
              >
                <div
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('[data-role="icon-btn"]')) return;
                    e.stopPropagation();
                    router.push('/folders/unarchived');
                  }}
                  className={`flex flex-1 cursor-pointer items-center justify-between rounded-xl border px-4 py-2.5 transition-all duration-200 card-hover-lift ${
                    selectedIds.has(UNARCHIVED_ID)
                      ? 'border-amber-300 bg-amber-50/70'
                      : 'border-cream-200 bg-white hover:border-cream-300 hover:bg-cream-50/70'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      data-role="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(UNARCHIVED_ID, e.metaKey || e.ctrlKey, e.shiftKey);
                      }}
                      className="flex-shrink-0 rounded-lg p-0.5 transition-colors hover:bg-amber-100"
                    >
                      <Inbox
                        className={`h-4 w-4 ${
                          selectedIds.has(UNARCHIVED_ID) ? 'text-amber-600' : 'text-amber-400'
                        }`}
                      />
                    </button>
                    <span className="truncate text-sm font-medium text-charcoal-800">
                      Unarchived Recordings
                    </span>
                    <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      {unarchivedSessions.length}
                    </span>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-charcoal-300" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Selection rectangle ── */}
        {selectionRect && (() => {
          const r = normalizeRect(selectionRect);
          return (
            <div
              className="pointer-events-none fixed z-50 border border-rust-400/50 bg-rust-100/20"
              style={{
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
              }}
            />
          );
        })()}
      </div>

      {/* ── Context menu ── */}
      {ctxMenu && (
        <ContextMenu
          ref={ctxMenuRef}
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
        />
      )}

      {/* ── Properties Modal ── */}
      {propertiesFolder && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-backdrop-enter"
          onClick={() => setPropertiesFolder(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-cream-200 bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-rust-500" />
              <h2 className="font-serif text-base font-bold text-charcoal-800">
                Folder Properties
              </h2>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between border-b border-cream-100 pb-2">
                <span className="text-charcoal-400">Name</span>
                <span className="font-medium text-charcoal-800">{propertiesFolder.name}</span>
              </div>
              <div className="flex justify-between border-b border-cream-100 pb-2">
                <span className="text-charcoal-400">Recordings</span>
                <span className="font-medium text-charcoal-800">{propertiesFolder.sessionCount}</span>
              </div>
              <div className="flex justify-between border-b border-cream-100 pb-2">
                <span className="text-charcoal-400">Keywords</span>
                <span className="font-medium text-charcoal-800">{propertiesFolder.keywordCount}</span>
              </div>
              <div className="flex justify-between border-b border-cream-100 pb-2">
                <span className="text-charcoal-400">Subfolders</span>
                <span className="font-medium text-charcoal-800">{propertiesFolder.childCount}</span>
              </div>
              <div className="flex justify-between border-b border-cream-100 pb-2">
                <span className="text-charcoal-400">Depth</span>
                <span className="font-medium text-charcoal-800">{propertiesFolder.depth}</span>
              </div>
              <div className="flex justify-between border-b border-cream-100 pb-2">
                <span className="text-charcoal-400">Path</span>
                <span className="font-medium text-charcoal-800 text-right max-w-[200px] truncate">
                  {propertiesFolder.path.join(' / ') || '/'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-charcoal-400">Created</span>
                <span className="font-medium text-charcoal-800">{formatDate(propertiesFolder.createdAt)}</span>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setPropertiesFolder(null)}
                className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 transition-colors hover:bg-cream-100"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Folder Modal ── */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-backdrop-enter"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-cream-200 bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 font-serif text-base font-bold text-charcoal-800">
              New Folder
            </h2>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newFolderName.trim()) void handleCreateFolder();
                if (e.key === 'Escape') setShowCreateModal(false);
              }}
              placeholder="Folder name..."
              autoFocus
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm text-charcoal-700 outline-none transition-colors focus:border-rust-300 focus:ring-1 focus:ring-rust-200"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 transition-colors hover:bg-cream-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCreateFolder()}
                disabled={saving || !newFolderName.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rust-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rust-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   Sub-component: Folder row
   ═══════════════════════════════════════════ */
function FolderRow({
  folder,
  isSelected,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  renameInputRef,
  isCut,
  onIconClick,
  onBodyClick,
  setRef,
}: {
  folder: FolderListItem;
  isSelected: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  renameInputRef: React.MutableRefObject<HTMLInputElement | null>;
  isCut: boolean;
  onIconClick: (e: React.MouseEvent) => void;
  onBodyClick: () => void;
  setRef: (el: HTMLElement | null) => void;
}) {
  return (
    <div
      data-folder-id={folder.id}
      ref={setRef}
      className={`flex items-center gap-2 transition-all animate-list-item-in ${isCut ? 'opacity-50' : ''}`}
    >
      <div
        onClick={(e) => {
          // Clicking anywhere on the row body opens the folder,
          // unless clicking on the icon or rename input
          const target = e.target as HTMLElement;
          if (target.closest('[data-role="icon-btn"]') || target.closest('input')) return;
          e.stopPropagation();
          onBodyClick();
        }}
        className={`flex flex-1 cursor-pointer items-center justify-between rounded-xl border px-4 py-2.5 transition-all duration-200 card-hover-lift ${
          isSelected
            ? 'border-rust-300 bg-rust-50/70'
            : 'border-cream-200 bg-white hover:border-cream-300 hover:bg-cream-50/70'
        }`}
      >
        {/* Left: icon + name */}
        <div className="flex min-w-0 items-center gap-2">
          {/* Icon — click to select */}
          <button
            data-role="icon-btn"
            onClick={onIconClick}
            className="flex-shrink-0 rounded-lg p-0.5 transition-colors hover:bg-rust-100"
          >
            <FolderOpen
              className={`h-4 w-4 ${isSelected ? 'text-rust-500' : 'text-charcoal-300'}`}
            />
          </button>

          {/* Name (rename mode or normal) */}
          {isRenaming ? (
            <input
              ref={(el) => { renameInputRef.current = el; }}
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameCommit();
                if (e.key === 'Escape') onRenameCancel();
              }}
              onBlur={onRenameCommit}
              onClick={(e) => e.stopPropagation()}
              className="min-w-[120px] rounded border border-rust-300 px-2 py-0.5 text-sm text-charcoal-800 outline-none focus:ring-1 focus:ring-rust-200"
            />
          ) : (
            <span className="truncate text-sm font-medium text-charcoal-800">
              {folder.name}
            </span>
          )}

          <span className="flex-shrink-0 text-xs text-charcoal-400">
            {folder.sessionCount}s / {folder.keywordCount}kw
          </span>
          {folder.childCount > 0 && (
            <span className="flex-shrink-0 text-xs text-charcoal-300">
              +{folder.childCount} sub
            </span>
          )}
        </div>

        {/* Right: chevron */}
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-charcoal-300" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   Sub-component: Expand button (同录音页风格)
   ═══════════════════════════════════════════ */
function FolderExpandBtn({ icon, label, onClick, disabled, variant = 'default', title, noExpand }: {
  icon: React.ReactNode; label: string; onClick?: (e: React.MouseEvent) => void; disabled?: boolean;
  variant?: 'primary' | 'danger' | 'default'; title?: string; noExpand?: boolean;
}) {
  const variants = {
    primary: 'bg-rust-500 text-white hover:bg-rust-600 shadow-sm shadow-rust-500/20',
    danger: 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100',
    default: 'border border-cream-300 text-charcoal-600 hover:bg-cream-50',
  };
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`expand-btn flex items-center h-9 rounded-lg transition-all duration-200 overflow-hidden ${variants[variant]} disabled:opacity-30 disabled:cursor-not-allowed`}>
      <span className="flex-shrink-0 w-9 h-9 flex items-center justify-center">{icon}</span>
      {!noExpand && label && <span className="expand-label text-xs font-medium">{label}</span>}
    </button>
  );
}

/* ═══════════════════════════════════════════
   Sub-component: Context menu (boundary-aware)
   ═══════════════════════════════════════════ */
interface CtxMenuItem {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

const ContextMenu = forwardRef<HTMLDivElement, { x: number; y: number; items: CtxMenuItem[] }>(
  function ContextMenu({ x, y, items }, ref) {
    const innerRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    useLayoutEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      let left = x;
      let top = y;

      if (left + rect.width > vw - pad) left = vw - rect.width - pad;
      if (left < pad) left = pad;
      if (top + rect.height > vh - pad) top = vh - rect.height - pad;
      if (top < pad) top = pad;

      setPos({ left, top });
    }, [x, y]);

    return (
      <div
        ref={(el) => {
          (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="animate-ctx-menu-in fixed z-[60] min-w-[180px] rounded-xl border border-cream-200 bg-white py-1.5 shadow-xl"
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
          <button
            key={i}
            onClick={() => item.action()}
            disabled={item.disabled}
            className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              item.danger
                ? 'text-red-600 hover:bg-red-50'
                : 'text-charcoal-700 hover:bg-cream-100'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    );
  }
);
