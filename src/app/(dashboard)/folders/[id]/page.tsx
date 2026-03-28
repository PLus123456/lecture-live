'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  Download,
  EllipsisVertical,
  FolderInput,
  FolderOpen,
  Info,
  Loader2,
  Mic,
  Pencil,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import FolderKeywordManager from '@/components/folder/FolderKeywordManager';
import NewSessionModal from '@/components/NewSessionModal';
import ExportModal from '@/components/ExportModal';
import ActionSheet, { type ActionSheetItem } from '@/components/mobile/ActionSheet';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useI18n } from '@/lib/i18n';

interface FolderDetail {
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

interface SessionItem {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  durationMs: number;
  courseName: string | null;
}

interface ContextMenuState {
  x: number;
  y: number;
  sessionId: string | null;
}

interface SelectionRect {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDurationShort(ms: number) {
  if (ms <= 0) return '--';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function normalizeRect(rect: SelectionRect) {
  const x = Math.min(rect.startX, rect.currentX);
  const y = Math.min(rect.startY, rect.currentY);
  const w = Math.abs(rect.currentX - rect.startX);
  const h = Math.abs(rect.currentY - rect.startY);
  return { x, y, w, h };
}

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

export default function FolderDetailPage() {
  const { token } = useAuth();
  const router = useRouter();
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const params = useParams();
  const folderId = params.id as string;

  const [folder, setFolder] = useState<FolderDetail | null>(null);
  const [allFolders, setAllFolders] = useState<FolderDetail[]>([]);
  const [childFolders, setChildFolders] = useState<FolderDetail[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /* ─── Modals ─── */
  const [showNewSession, setShowNewSession] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportSessionId, setExportSessionId] = useState<string | undefined>();
  const [exportSessionTitle, setExportSessionTitle] = useState('');
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [showProperties, setShowProperties] = useState(false);
  const [propertiesSession, setPropertiesSession] = useState<SessionItem | null>(null);

  /* ─── Session selection ─── */
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const hasSessionSelection = selectedSessionIds.size > 0;
  const singleSelectedId = selectedSessionIds.size === 1 ? Array.from(selectedSessionIds)[0] : null;

  /* ─── Context menu ─── */
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [mobileActionSessionId, setMobileActionSessionId] = useState<string | null>(null);

  /* ─── Drag-select ─── */
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionItemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const isDraggingRef = useRef(false);
  const lastClickedIdRef = useRef<string | null>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const toggleSessionSelect = (id: string, multi: boolean, shift?: boolean) => {
    if (shift && lastClickedIdRef.current) {
      const ordered = sessions.map((s) => s.id);
      const fromIdx = ordered.indexOf(lastClickedIdRef.current);
      const toIdx = ordered.indexOf(id);
      if (fromIdx !== -1 && toIdx !== -1) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        setSelectedSessionIds((prev) => {
          const next = new Set(multi ? prev : []);
          for (let i = start; i <= end; i++) next.add(ordered[i]);
          return next;
        });
        return;
      }
    }
    setSelectedSessionIds((prev) => {
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

  const selectAllSessions = () => setSelectedSessionIds(new Set(sessions.map((s) => s.id)));
  const clearSessionSelection = () => setSelectedSessionIds(new Set());

  const resetMessages = () => { setError(null); setSuccess(null); };

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [token]);

  const setSessionRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) sessionItemRefs.current.set(id, el);
    else sessionItemRefs.current.delete(id);
  }, []);

  const loadData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [folderRes, foldersRes, sessionsRes] = await Promise.all([
        fetch(`/api/folders/${folderId}`, { headers: authHeaders }),
        fetch('/api/folders', { headers: authHeaders }),
        fetch(`/api/sessions?folderId=${folderId}`, { headers: authHeaders }),
      ]);
      if (folderRes.ok) setFolder(await folderRes.json());
      if (foldersRes.ok) {
        const all: FolderDetail[] = await foldersRes.json();
        setAllFolders(all);
        setChildFolders(all.filter((f) => f.parentId === folderId));
      }
      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        setSessions(Array.isArray(data) ? data : []);
      }
    } catch { /* silent */ } finally { setLoading(false); }
  }, [token, folderId, authHeaders]);

  useEffect(() => { void loadData(); }, [loadData]);

  /* ─── Delete ─── */
  const handleDeleteSessions = async () => {
    if (selectedSessionIds.size === 0 || !token) return;
    const ids = Array.from(selectedSessionIds);
    if (!window.confirm(t('foldersPage.deleteConfirmMany', { count: ids.length }))) return;
    resetMessages(); setSaving(true);
    try {
      let c = 0;
      for (const id of ids) { const r = await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: authHeaders }); if (r.ok) c++; }
      setSuccess(t('foldersPage.deletedCount', { count: c }));
      clearSessionSelection(); await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : t('foldersPage.deleteFailed')); }
    finally { setSaving(false); }
  };

  const handleDeleteSingle = async (id: string) => {
    if (!token) return;
    const s = sessions.find((s) => s.id === id);
    if (!window.confirm(t('foldersPage.deleteConfirmSingle', { title: s?.title || t('foldersPage.untitledSession') }))) return;
    resetMessages(); setSaving(true);
    try {
      const r = await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: authHeaders });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || t('foldersPage.deleteFailed')); }
      setSuccess(t('foldersPage.recordingDeleted')); clearSessionSelection(); await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : t('foldersPage.deleteFailed')); }
    finally { setSaving(false); }
  };

  /* ─── Rename session ─── */
  const openRenameModal = () => {
    if (!singleSelectedId) return;
    const s = sessions.find((s) => s.id === singleSelectedId);
    setRenameValue(s?.title || '');
    setShowRenameModal(true);
  };

  const handleRenameSession = async () => {
    if (!singleSelectedId || !token || !renameValue.trim()) return;
    resetMessages(); setSaving(true);
    try {
      const r = await fetch(`/api/sessions/${singleSelectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ title: renameValue.trim() }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || t('foldersPage.renameFailed')); }
      setSuccess(t('foldersPage.renamed')); setShowRenameModal(false); await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : t('foldersPage.renameFailed')); }
    finally { setSaving(false); }
  };

  /* ─── Export / Download ─── */
  const openExport = (sessionId?: string) => {
    const id = sessionId || singleSelectedId;
    if (!id) return;
    const s = sessions.find((s) => s.id === id);
    setExportSessionId(id);
    setExportSessionTitle(s?.title || t('foldersPage.recordingLabel'));
    setShowExport(true);
  };

  /* ─── Move sessions ─── */
  const handleMoveSessionsTo = async (targetFolderId: string | null) => {
    if (selectedSessionIds.size === 0 || !token) return;
    resetMessages(); setSaving(true);
    try {
      for (const id of Array.from(selectedSessionIds)) {
        const r = await fetch(`/api/sessions/${id}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ folderId: targetFolderId }),
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || t('foldersPage.moveFailed')); }
      }
      setSuccess(t('foldersPage.movedCount', { count: selectedSessionIds.size }));
      setShowMoveModal(false); clearSessionSelection(); await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : t('foldersPage.moveFailed')); }
    finally { setSaving(false); }
  };

  /* ─── Share ─── */
  const handleShare = async (sessionId?: string) => {
    const id = sessionId || singleSelectedId;
    if (!id || !token) return;
    resetMessages(); setSaving(true);
    try {
      const r = await fetch('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ sessionId: id, isLive: false, expiresInHours: 72 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || t('foldersPage.shareFailed'));
      const url = `${window.location.origin}/session/${id}/view/${data.token}`;
      await navigator.clipboard.writeText(url);
      setSuccess(t('foldersPage.shareCopied'));
    } catch (e) { setError(e instanceof Error ? e.message : t('foldersPage.shareFailed')); }
    finally { setSaving(false); }
  };

  /* ─── Show properties ─── */
  const openProperties = (sessionId?: string) => {
    const id = sessionId || singleSelectedId;
    if (!id) return;
    const s = sessions.find((s) => s.id === id);
    if (s) { setPropertiesSession(s); setShowProperties(true); }
  };

  /* ─── Show context menu at "..." button ─── */
  const handleMoreClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!singleSelectedId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({ x: rect.left, y: rect.bottom + 4, sessionId: singleSelectedId });
  };

  /* ─── Context menu close ─── */
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('click', close); document.removeEventListener('scroll', close, true); };
  }, [ctxMenu]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setCtxMenu(null); clearSessionSelection(); setShowNewSession(false); setShowMoveModal(false); setShowRenameModal(false); setShowProperties(false); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  /* ─── Global right-click ─── */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && containerRef.current.contains(e.target as Node)) {
        const sessionEl = (e.target as HTMLElement).closest('[data-session-id]');
        if (sessionEl) {
          const id = sessionEl.getAttribute('data-session-id');
          if (id) {
            e.preventDefault();
            if (!selectedSessionIds.has(id)) setSelectedSessionIds(new Set([id]));
            setCtxMenu({ x: e.clientX, y: e.clientY, sessionId: id });
            return;
          }
        }
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, sessionId: null });
      }
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, [selectedSessionIds]);

  /* ─── Drag-select (with auto-scroll) ─── */
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-session-id]') || target.closest('button') || target.closest('input')) return;
    if (e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    isDraggingRef.current = false;
    const startX = e.clientX; const startY = e.clientY;
    const EDGE = 40; const SPEED = 8;
    let latestY = startY;

    const doAutoScroll = (cy: number) => {
      if (!container) return;
      const b = container.getBoundingClientRect();
      if (cy < b.top + EDGE) container.scrollTop -= SPEED;
      else if (cy > b.bottom - EDGE) container.scrollTop += SPEED;
    };

    const scrollLoop = () => {
      if (!isDraggingRef.current) return;
      doAutoScroll(latestY);
      scrollTimerRef.current = requestAnimationFrame(scrollLoop);
    };

    const onMouseMove = (me: MouseEvent) => {
      const dx = me.clientX - startX; const dy = me.clientY - startY;
      if (!isDraggingRef.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (!isDraggingRef.current) { isDraggingRef.current = true; scrollTimerRef.current = requestAnimationFrame(scrollLoop); }
      latestY = me.clientY;
      const rect: SelectionRect = { startX, startY, currentX: me.clientX, currentY: me.clientY };
      setSelectionRect(rect);
      const norm = normalizeRect(rect);
      const newSelected = new Set<string>();
      sessionItemRefs.current.forEach((el, id) => { if (rectsOverlap(norm, el.getBoundingClientRect())) newSelected.add(id); });
      setSelectedSessionIds(newSelected);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (scrollTimerRef.current) { cancelAnimationFrame(scrollTimerRef.current); scrollTimerRef.current = null; }
      setSelectionRect(null);
      if (!isDraggingRef.current) clearSessionSelection();
      isDraggingRef.current = false;
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  /* ─── Context menu items ─── */
  const ctxMenuItems = useMemo(() => {
    if (!ctxMenu) return [];
    const items: CtxMenuItem[] = [];

    if (ctxMenu.sessionId) {
      const targetIds = selectedSessionIds.size > 1 && selectedSessionIds.has(ctxMenu.sessionId)
        ? Array.from(selectedSessionIds) : [ctxMenu.sessionId];
      const isSingle = targetIds.length === 1;

      items.push({
        label: t('foldersPage.openRecording'),
        icon: <Mic className="h-3.5 w-3.5" />,
        action: () => {
          const s = sessions.find((s) => s.id === ctxMenu.sessionId);
          router.push(s?.status === 'COMPLETED' || s?.status === 'ARCHIVED' ? `/session/${ctxMenu.sessionId}/playback` : `/session/${ctxMenu.sessionId}`);
          setCtxMenu(null);
        },
      });
      items.push({
        label: t('common.download'),
        icon: <Download className="h-3.5 w-3.5" />,
        action: () => { setCtxMenu(null); openExport(ctxMenu.sessionId!); },
        disabled: !isSingle,
      });
      items.push({
        label: t('foldersPage.moveToFolder'),
        icon: <FolderInput className="h-3.5 w-3.5" />,
        action: () => { setCtxMenu(null); setShowMoveModal(true); },
      });
      items.push({
        label: t('common.edit'),
        icon: <Pencil className="h-3.5 w-3.5" />,
        action: () => {
          setCtxMenu(null);
          const s = sessions.find((s) => s.id === ctxMenu.sessionId);
          setRenameValue(s?.title || '');
          setSelectedSessionIds(new Set([ctxMenu.sessionId!]));
          setShowRenameModal(true);
        },
        disabled: !isSingle,
      });
      items.push({
        label: t('session.share.share'),
        icon: <Share2 className="h-3.5 w-3.5" />,
        action: () => { setCtxMenu(null); void handleShare(ctxMenu.sessionId!); },
        disabled: !isSingle,
      });
      items.push({
        label: t('foldersPage.properties'),
        icon: <Info className="h-3.5 w-3.5" />,
        action: () => { setCtxMenu(null); openProperties(ctxMenu.sessionId!); },
        disabled: !isSingle,
      });
      items.push({
        label: targetIds.length > 1 ? t('foldersPage.deleteItems', { count: targetIds.length }) : t('common.delete'),
        icon: <Trash2 className="h-3.5 w-3.5" />,
        action: () => { setCtxMenu(null); if (isSingle) void handleDeleteSingle(targetIds[0]); else void handleDeleteSessions(); },
        danger: true,
      });
    } else {
      items.push({
        label: t('session.newSession.title'),
        icon: <Mic className="h-3.5 w-3.5" />,
        action: () => { setCtxMenu(null); setShowNewSession(true); },
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, selectedSessionIds, sessions]);

  const mobileActionItems: ActionSheetItem[] = !mobileActionSessionId
    ? []
    : [
        {
          key: 'open',
          label: t('foldersPage.openRecording'),
          icon: <Mic className="h-4 w-4" />,
          onSelect: () => {
            const session = sessions.find((item) => item.id === mobileActionSessionId);
            router.push(
              session?.status === 'COMPLETED' || session?.status === 'ARCHIVED'
                ? `/session/${mobileActionSessionId}/playback`
                : `/session/${mobileActionSessionId}`
            );
          },
        },
        {
          key: 'export',
          label: t('common.download'),
          icon: <Download className="h-4 w-4" />,
          onSelect: () => openExport(mobileActionSessionId),
        },
        {
          key: 'move',
          label: t('foldersPage.moveToFolder'),
          icon: <FolderInput className="h-4 w-4" />,
          onSelect: () => {
            setSelectedSessionIds(new Set([mobileActionSessionId]));
            setShowMoveModal(true);
          },
        },
        {
          key: 'rename',
          label: t('common.edit'),
          icon: <Pencil className="h-4 w-4" />,
          onSelect: () => {
            const session = sessions.find((item) => item.id === mobileActionSessionId);
            setSelectedSessionIds(new Set([mobileActionSessionId]));
            setRenameValue(session?.title || '');
            setShowRenameModal(true);
          },
        },
        {
          key: 'share',
          label: t('foldersPage.shareLink'),
          icon: <Share2 className="h-4 w-4" />,
          onSelect: () => void handleShare(mobileActionSessionId),
        },
        {
          key: 'properties',
          label: t('foldersPage.properties'),
          icon: <Info className="h-4 w-4" />,
          onSelect: () => openProperties(mobileActionSessionId),
        },
        {
          key: 'delete',
          label: t('common.delete'),
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onSelect: () => void handleDeleteSingle(mobileActionSessionId),
        },
      ];

  if (loading) return <div className="flex h-screen items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-charcoal-400" /></div>;
  if (!folder) return (
    <div className="flex h-screen flex-col items-center justify-center gap-3">
      <p className="text-sm text-charcoal-500">{t('foldersPage.folderNotFound')}</p>
      <button onClick={() => router.push('/folders')} className="text-sm text-rust-500 hover:underline">{t('foldersPage.backToFolders')}</button>
    </div>
  );

  if (isMobile) {
    return (
      <div className="min-h-screen bg-cream-50 pb-28">
        <header className="sticky top-0 z-20 border-b border-cream-200 bg-white/95 px-4 py-4 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => folder.parentId ? router.push(`/folders/${folder.parentId}`) : router.push('/folders')}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
                aria-label={t('foldersPage.back')}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-lg font-bold text-charcoal-800">{folder.name}</h1>
                <p className="text-xs text-charcoal-400">
                  {t('foldersPage.folderSummary', {
                    recordings: folder.sessionCount,
                    subfolders: folder.childCount,
                  })}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowNewSession(true)}
              className="inline-flex items-center gap-2 rounded-full bg-rust-500 px-4 py-2 text-sm font-semibold text-white"
            >
              <Mic className="h-4 w-4" />
              {t('common.create')}
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

        <div className="space-y-4 px-4 py-4">
          {childFolders.length > 0 ? (
            <section className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-charcoal-400">
                {t('foldersPage.subfolders')}
              </div>
              {childFolders.map((child) => (
                <button
                  key={child.id}
                  onClick={() => router.push(`/folders/${child.id}`)}
                  className="flex w-full items-center justify-between rounded-2xl border border-cream-200 bg-white px-4 py-4 text-left shadow-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-5 w-5 text-rust-500" />
                      <span className="truncate text-base font-semibold text-charcoal-800">{child.name}</span>
                    </div>
                    <p className="mt-1 text-xs text-charcoal-400">
                      {t('foldersPage.subfoldersAndKeywords', {
                        recordings: child.sessionCount,
                        keywords: child.keywordCount,
                      })}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-charcoal-300" />
                </button>
              ))}
            </section>
          ) : null}

          <section className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-charcoal-400">
              {t('foldersPage.recordings')}
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-cream-300 bg-white px-6 py-14 text-center">
                <Mic className="mx-auto mb-3 h-10 w-10 text-charcoal-200" />
                <p className="text-sm font-medium text-charcoal-500">{t('foldersPage.noFolderItems')}</p>
                <p className="mt-1 text-xs text-charcoal-400">{t('foldersPage.noFolderItemsDesc')}</p>
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className="rounded-2xl border border-cream-200 bg-white px-4 py-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      onClick={() => {
                        router.push(
                          session.status === 'COMPLETED' || session.status === 'ARCHIVED'
                            ? `/session/${session.id}/playback`
                            : `/session/${session.id}`
                        );
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-base font-semibold text-charcoal-800">
                        {session.title || t('foldersPage.untitledSession')}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-charcoal-400">
                        {session.durationMs > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDurationShort(session.durationMs)}
                          </span>
                        ) : null}
                        <span>{formatDate(session.createdAt)}</span>
                        <span className={`rounded-full px-2 py-0.5 font-medium ${
                          session.status === 'COMPLETED'
                            ? 'bg-emerald-100 text-emerald-700'
                            : session.status === 'RECORDING'
                              ? 'bg-red-100 text-red-600'
                              : 'bg-cream-100 text-charcoal-600'
                        }`}>
                          {session.status}
                        </span>
                      </div>
                    </button>
                    <button
                      onClick={() => setMobileActionSessionId(session.id)}
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-500"
                      aria-label={t('foldersPage.recordingActions')}
                    >
                      <EllipsisVertical className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="rounded-3xl border border-cream-200 bg-white p-4 shadow-sm">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-charcoal-400">
              {t('foldersPage.keywords')}
            </div>
            <FolderKeywordManager folderId={folder.id} folderName={folder.name} token={token} onMutated={loadData} />
          </section>
        </div>

        <ActionSheet
          open={mobileActionSessionId !== null}
          onClose={() => setMobileActionSessionId(null)}
          title={t('foldersPage.recordingActions')}
          items={mobileActionItems}
        />

        {showNewSession && <NewSessionModal onClose={() => setShowNewSession(false)} defaultFolderId={folderId} />}
        {showExport && <ExportModal isOpen sessionId={exportSessionId} sessionTitle={exportSessionTitle} onClose={() => setShowExport(false)} />}

        {showRenameModal && (
          <ModalOverlay onClose={() => setShowRenameModal(false)}>
            <h2 className="mb-4 font-serif text-base font-bold text-charcoal-800">{t('foldersPage.renameRecording')}</h2>
            <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && renameValue.trim()) void handleRenameSession(); if (e.key === 'Escape') setShowRenameModal(false); }}
              autoFocus className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm text-charcoal-700 outline-none focus:border-rust-300 focus:ring-1 focus:ring-rust-200" />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowRenameModal(false)} className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 hover:bg-cream-100">{t('common.cancel')}</button>
              <button onClick={() => void handleRenameSession()} disabled={saving || !renameValue.trim()} className="rounded-lg bg-rust-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-rust-600 disabled:opacity-60">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save')}
              </button>
            </div>
          </ModalOverlay>
        )}

        {showMoveModal && (
          <ModalOverlay onClose={() => setShowMoveModal(false)}>
            <h2 className="mb-4 font-serif text-base font-bold text-charcoal-800">{t('foldersPage.moveToFolderDialog')}</h2>
            <div className="max-h-60 space-y-1 overflow-y-auto">
              <button onClick={() => void handleMoveSessionsTo(null)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-charcoal-700 hover:bg-cream-100">
                <Mic className="h-4 w-4 text-amber-500" /> {t('foldersPage.unarchivedFolder')}
              </button>
              {allFolders.filter((f) => f.id !== folderId).map((f) => (
                <button key={f.id} onClick={() => void handleMoveSessionsTo(f.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-charcoal-700 hover:bg-cream-100">
                  <FolderOpen className="h-4 w-4 text-charcoal-300" />
                  <span style={{ paddingLeft: f.depth * 12 }}>{f.name}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setShowMoveModal(false)} className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 hover:bg-cream-100">{t('common.cancel')}</button>
            </div>
          </ModalOverlay>
        )}

        {showProperties && propertiesSession && (
          <ModalOverlay onClose={() => setShowProperties(false)}>
            <div className="mb-4 flex items-center gap-2">
              <Mic className="h-5 w-5 text-rust-500" />
              <h2 className="font-serif text-base font-bold text-charcoal-800">{t('foldersPage.recordingProperties')}</h2>
            </div>
            <div className="space-y-3 text-sm">
              <PropRow label={t('settings.name')} value={propertiesSession.title || t('foldersPage.untitledSession')} />
              <PropRow label={t('foldersPage.status')} value={propertiesSession.status} />
              <PropRow label={t('foldersPage.duration')} value={formatDurationShort(propertiesSession.durationMs)} />
              <PropRow label={t('foldersPage.course')} value={propertiesSession.courseName || '—'} />
              <PropRow label={t('foldersPage.folderLabel')} value={folder.name} />
              <PropRow label={t('foldersPage.created')} value={formatDate(propertiesSession.createdAt)} last />
            </div>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setShowProperties(false)} className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 hover:bg-cream-100">{t('common.close')}</button>
            </div>
          </ModalOverlay>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden select-none">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-cream-200 bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => folder.parentId ? router.push(`/folders/${folder.parentId}`) : router.push('/folders')}
            className="rounded-lg p-1.5 text-charcoal-400 transition-colors hover:bg-cream-100 hover:text-charcoal-600"
            title={t('foldersPage.back')}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <FolderOpen className="h-5 w-5 text-rust-500" />
          <h1 className="font-serif text-lg font-bold text-charcoal-800">{folder.name}</h1>
          <nav className="ml-2 flex items-center gap-1 text-xs text-charcoal-400">
            <button onClick={() => router.push('/folders')} className="hover:text-rust-500 hover:underline">{t('nav.folders')}</button>
            {folder.path.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3" />
                <span className={i === folder.path.length - 1 ? 'text-charcoal-600 font-medium' : ''}>{seg}</span>
              </span>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          {/* 选中录音时显示的操作按钮 */}
          {hasSessionSelection && (
            <>
              <ExpandBtn icon={<Download className="w-3.5 h-3.5" />} label={t('common.download')} title={t('common.download')} variant="default" onClick={() => openExport()} disabled={!singleSelectedId} />
              <ExpandBtn icon={<FolderInput className="w-3.5 h-3.5" />} label={t('foldersPage.moveToFolder')} title={t('foldersPage.moveToFolder')} variant="default" onClick={() => setShowMoveModal(true)} />
              <ExpandBtn icon={<Pencil className="w-3.5 h-3.5" />} label={t('common.edit')} title={t('common.edit')} variant="default" onClick={openRenameModal} disabled={!singleSelectedId} />
              <ExpandBtn icon={<Share2 className="w-3.5 h-3.5" />} label={t('session.share.share')} title={t('session.share.share')} variant="default" onClick={() => void handleShare()} disabled={!singleSelectedId} />
              <ExpandBtn icon={<EllipsisVertical className="w-3.5 h-3.5" />} label="" title={t('common.actions')} variant="default" onClick={handleMoreClick} disabled={!singleSelectedId} noExpand />
              <ExpandBtn icon={<Trash2 className="w-3.5 h-3.5" />} label={`${t('common.delete')} (${selectedSessionIds.size})`} title={t('common.delete')} variant="danger" onClick={() => void handleDeleteSessions()} disabled={saving} />
            </>
          )}
          <ExpandBtn icon={<Mic className="w-3.5 h-3.5" />} label={t('session.newSession.title')} title={t('session.newSession.title')} variant="primary" onClick={() => setShowNewSession(true)} />
        </div>
      </header>

      {/* Messages */}
      {(error || success) && (
        <div className={`flex flex-shrink-0 items-center justify-between border-b px-6 py-2 text-sm ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          <span>{error || success}</span>
          <button onClick={resetMessages} className="ml-2 rounded p-0.5 opacity-60 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Stats bar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-cream-100 bg-cream-50/50 px-6 py-2">
        <div className="flex items-center gap-4 text-xs text-charcoal-500">
          <span>{t('foldersPage.recordingsCount', { count: folder.sessionCount })}</span>
          <span>{t('foldersPage.subfoldersCount', { count: folder.childCount })}</span>
          <span>{t('foldersPage.keywordsCount', { count: folder.keywordCount })}</span>
          <span>{t('foldersPage.createdOn', { date: formatDate(folder.createdAt) })}</span>
        </div>
        {sessions.length > 0 && (
          <div className="flex items-center gap-2">
            {hasSessionSelection ? (
              <>
                <span className="text-xs text-charcoal-500">{t('foldersPage.selected', { count: selectedSessionIds.size })}</span>
                <button onClick={clearSessionSelection} className="rounded-lg px-2 py-1 text-xs text-charcoal-500 transition-colors hover:bg-cream-200">{t('foldersPage.clear')}</button>
              </>
            ) : (
              <button onClick={selectAllSessions} className="rounded-lg px-2 py-1 text-xs text-charcoal-500 transition-colors hover:bg-cream-200">{t('foldersPage.selectAll')}</button>
            )}
          </div>
        )}
      </div>

      {/* Main: left-right layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Subfolders + Recordings */}
        <div ref={containerRef} className="relative flex-1 overflow-y-auto px-6 py-4" onMouseDown={handleMouseDown}>
          {childFolders.length === 0 && sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <FolderOpen className="mb-3 h-10 w-10 text-charcoal-200" />
              <p className="text-sm text-charcoal-500">{t('foldersPage.noFolderItems')}</p>
              <button onClick={() => setShowNewSession(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-rust-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rust-600">
                <Mic className="h-3.5 w-3.5" /> {t('session.newSession.startRecording')}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {childFolders.length > 0 && (
                <div className="space-y-1.5">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wider text-charcoal-400">{t('foldersPage.subfolders')}</div>
                  {childFolders.map((child) => (
                    <button key={child.id} onClick={() => router.push(`/folders/${child.id}`)} className="flex w-full items-center justify-between rounded-xl border border-cream-200 bg-white px-4 py-2.5 text-left transition-colors hover:border-cream-300 hover:bg-cream-50/70">
                      <div className="flex items-center gap-2">
                        <FolderOpen className="h-4 w-4 text-charcoal-300" />
                        <span className="text-sm font-medium text-charcoal-800">{child.name}</span>
                        <span className="text-xs text-charcoal-400">
                          {t('foldersPage.subfoldersAndKeywords', {
                            recordings: child.sessionCount,
                            keywords: child.keywordCount,
                          })}
                        </span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-charcoal-300" />
                    </button>
                  ))}
                </div>
              )}

              {sessions.length > 0 && (
                <div className="space-y-1.5">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wider text-charcoal-400">{t('foldersPage.recordings')}</div>
                  {sessions.map((session) => {
                    const isSelected = selectedSessionIds.has(session.id);
                    return (
                      <div
                        key={session.id} data-session-id={session.id} ref={(el) => setSessionRef(session.id, el)}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest('[data-role="icon-btn"]')) return;
                          router.push(session.status === 'COMPLETED' || session.status === 'ARCHIVED' ? `/session/${session.id}/playback` : `/session/${session.id}`);
                        }}
                        className={`flex w-full cursor-pointer items-center justify-between rounded-xl border px-4 py-2.5 transition-colors ${isSelected ? 'border-rust-300 bg-rust-50/70' : 'border-cream-200 bg-white hover:border-cream-300 hover:bg-cream-50/70'}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <button data-role="icon-btn" onClick={(e) => { e.stopPropagation(); toggleSessionSelect(session.id, e.metaKey || e.ctrlKey, e.shiftKey); }} className="flex-shrink-0 rounded-lg p-0.5 transition-colors hover:bg-rust-100">
                            <Mic className={`h-4 w-4 ${isSelected ? 'text-rust-500' : 'text-charcoal-300'}`} />
                          </button>
                          <span className="truncate text-sm font-medium text-charcoal-800">{session.title || t('foldersPage.untitledSession')}</span>
                          {session.courseName && <span className="flex-shrink-0 rounded-md bg-cream-100 px-1.5 py-0.5 text-[11px] text-charcoal-500">{session.courseName}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-charcoal-400">
                          {session.durationMs > 0 && <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatDurationShort(session.durationMs)}</span>}
                          <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${session.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700' : session.status === 'RECORDING' ? 'bg-red-100 text-red-600' : 'bg-cream-200 text-charcoal-600'}`}>{session.status}</span>
                          <span>{formatDate(session.createdAt)}</span>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {selectionRect && (() => { const r = normalizeRect(selectionRect); return <div className="pointer-events-none fixed z-50 border border-rust-400/50 bg-rust-100/20" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />; })()}
        </div>

        {/* Right: Keywords */}
        <div className="w-80 flex-shrink-0 overflow-y-auto border-l border-cream-200 bg-cream-50/30 p-4">
          <FolderKeywordManager folderId={folder.id} folderName={folder.name} token={token} onMutated={loadData} />
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && <SessionContextMenu ref={ctxMenuRef} x={ctxMenu.x} y={ctxMenu.y} items={ctxMenuItems} />}

      {/* ── Modals ── */}
      {showNewSession && <NewSessionModal onClose={() => setShowNewSession(false)} defaultFolderId={folderId} />}
      {showExport && <ExportModal isOpen sessionId={exportSessionId} sessionTitle={exportSessionTitle} onClose={() => setShowExport(false)} />}

      {/* Rename modal */}
      {showRenameModal && (
        <ModalOverlay onClose={() => setShowRenameModal(false)}>
          <h2 className="mb-4 font-serif text-base font-bold text-charcoal-800">{t('foldersPage.renameRecording')}</h2>
          <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && renameValue.trim()) void handleRenameSession(); if (e.key === 'Escape') setShowRenameModal(false); }}
            autoFocus className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm text-charcoal-700 outline-none focus:border-rust-300 focus:ring-1 focus:ring-rust-200" />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setShowRenameModal(false)} className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 hover:bg-cream-100">{t('common.cancel')}</button>
            <button onClick={() => void handleRenameSession()} disabled={saving || !renameValue.trim()} className="rounded-lg bg-rust-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-rust-600 disabled:opacity-60">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save')}
            </button>
          </div>
        </ModalOverlay>
      )}

      {/* Move modal */}
      {showMoveModal && (
        <ModalOverlay onClose={() => setShowMoveModal(false)}>
          <h2 className="mb-4 font-serif text-base font-bold text-charcoal-800">{t('foldersPage.moveToFolderDialog')}</h2>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            <button onClick={() => void handleMoveSessionsTo(null)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-charcoal-700 hover:bg-cream-100">
              <Mic className="h-4 w-4 text-amber-500" /> {t('foldersPage.unarchivedFolder')}
            </button>
            {allFolders.filter((f) => f.id !== folderId).map((f) => (
              <button key={f.id} onClick={() => void handleMoveSessionsTo(f.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-charcoal-700 hover:bg-cream-100">
                <FolderOpen className="h-4 w-4 text-charcoal-300" />
                <span style={{ paddingLeft: f.depth * 12 }}>{f.name}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button onClick={() => setShowMoveModal(false)} className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 hover:bg-cream-100">{t('common.cancel')}</button>
          </div>
        </ModalOverlay>
      )}

      {/* Properties modal */}
      {showProperties && propertiesSession && (
        <ModalOverlay onClose={() => setShowProperties(false)}>
          <div className="mb-4 flex items-center gap-2">
            <Mic className="h-5 w-5 text-rust-500" />
            <h2 className="font-serif text-base font-bold text-charcoal-800">{t('foldersPage.recordingProperties')}</h2>
          </div>
          <div className="space-y-3 text-sm">
            <PropRow label={t('settings.name')} value={propertiesSession.title || t('foldersPage.untitledSession')} />
            <PropRow label={t('foldersPage.status')} value={propertiesSession.status} />
            <PropRow label={t('foldersPage.duration')} value={formatDurationShort(propertiesSession.durationMs)} />
            <PropRow label={t('foldersPage.course')} value={propertiesSession.courseName || '—'} />
            <PropRow label={t('foldersPage.folderLabel')} value={folder.name} />
            <PropRow label={t('foldersPage.created')} value={formatDate(propertiesSession.createdAt)} last />
          </div>
          <div className="mt-5 flex justify-end">
            <button onClick={() => setShowProperties(false)} className="rounded-lg border border-cream-300 px-4 py-1.5 text-sm text-charcoal-500 hover:bg-cream-100">{t('common.close')}</button>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}

/* ═══ Expand button (same style as recording page) ═══ */
function ExpandBtn({ icon, label, onClick, disabled, variant = 'default', title, noExpand }: {
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

/* ═══ Modal overlay ═══ */
function ModalOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-cream-200 bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/* ═══ Property row ═══ */
function PropRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={`flex justify-between ${last ? '' : 'border-b border-cream-100 pb-2'}`}>
      <span className="text-charcoal-400">{label}</span>
      <span className="font-medium text-charcoal-800 text-right max-w-[200px] truncate">{value}</span>
    </div>
  );
}

/* ═══ Context menu ═══ */
interface CtxMenuItem { label: string; icon: React.ReactNode; action: () => void; danger?: boolean; disabled?: boolean; }

const SessionContextMenu = forwardRef<HTMLDivElement, { x: number; y: number; items: CtxMenuItem[] }>(
  function SessionContextMenu({ x, y, items }, ref) {
    const innerRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });
    useLayoutEffect(() => {
      const el = innerRef.current; if (!el) return;
      const rect = el.getBoundingClientRect(); const vw = window.innerWidth; const vh = window.innerHeight; const pad = 8;
      let left = x; let top = y;
      if (left + rect.width > vw - pad) left = vw - rect.width - pad;
      if (left < pad) left = pad;
      if (top + rect.height > vh - pad) top = vh - rect.height - pad;
      if (top < pad) top = pad;
      setPos({ left, top });
    }, [x, y]);
    return (
      <div ref={(el) => { (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = el; if (typeof ref === 'function') ref(el); else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
        className="animate-ctx-menu-in fixed z-[60] min-w-[180px] rounded-xl border border-cream-200 bg-white py-1.5 shadow-xl" style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
        {items.map((item, i) => (
          <button key={i} onClick={() => item.action()} disabled={item.disabled}
            className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${item.danger ? 'text-red-600 hover:bg-red-50' : 'text-charcoal-700 hover:bg-cream-100'}`}>
            {item.icon}{item.label}
          </button>
        ))}
      </div>
    );
  }
);
