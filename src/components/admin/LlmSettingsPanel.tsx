'use client';

// LLM 设置面板 — 两段式：
//  ① 用途路由：5 个功能各自挂多个模型卡（每卡三级参数：思考 › 深度 › 温度，星标=该用途默认），
//     支持「统一 / 按会员组」两种范围（按组时 CHAT/实时摘要/总摘要 可为每组绑定默认模型）。
//  ② 模型库：按网关分组登记模型规格（上下文/输出/输入能力/维度），带连通性验证；参数不在这里配。
// 数据模型：LlmRegistryModel（规格真源）+ LlmModel 路由行（purpose × 模型的参数）。

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  MessageCircle,
  Zap,
  FileText,
  Tag,
  Search,
  Star,
  X,
  Plus,
  ChevronDown,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Info,
  Server,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import ModalPortal from '@/components/ModalPortal';
import ConfirmDialog from '@/components/ConfirmDialog';

/* ────────────────────────── 类型 ────────────────────────── */

type ModelPurpose =
  | 'CHAT'
  | 'REALTIME_SUMMARY'
  | 'FINAL_SUMMARY'
  | 'KEYWORD_EXTRACTION'
  | 'EMBEDDING';
type ThinkingMode = 'NONE' | 'AUTO' | 'FORCED' | 'DEPTH';
type ThinkingDepth = 'low' | 'medium' | 'high';
type RegistryKind = 'TEXT' | 'EMBEDDING';
type RegistryStatus = 'UNVERIFIED' | 'OK' | 'FAILED';

interface RegistryRouteRef {
  id: string;
  purpose: ModelPurpose;
  isDefault: boolean;
}

interface RegistryModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  kind: RegistryKind;
  supportsImage: boolean;
  maxTokens: number;
  contextWindow: number;
  embeddingDimensions: number | null;
  status: RegistryStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  routes: RegistryRouteRef[];
}

interface RouteRow {
  id: string;
  registryId: string | null;
  providerId: string;
  modelId: string;
  displayName: string;
  purpose: ModelPurpose;
  thinkingMode: ThinkingMode;
  thinkingDepth: ThinkingDepth;
  temperature: number;
  isDefault: boolean;
  sortOrder: number;
}

interface Gateway {
  id: string;
  name: string;
  apiBase: string;
  isAnthropic: boolean;
  hasApiKey: boolean;
  maskedApiKey: string;
  registryModels: RegistryModel[];
  routes: RouteRow[];
}

interface GroupBinding {
  key: string; // 'FREE' | 'PRO' | 'custom:<id>'
  name: string;
  isCustom: boolean;
  color?: string;
  chatModelId: string;
  realtimeSummaryModelId: string;
  finalSummaryModelId: string;
}

/* ────────────────────────── 常量 / 工具 ────────────────────────── */

const PURPOSES: ModelPurpose[] = [
  'CHAT',
  'REALTIME_SUMMARY',
  'FINAL_SUMMARY',
  'KEYWORD_EXTRACTION',
  'EMBEDDING',
];

/** 支持按用户组绑定默认模型的用途（关键词/嵌入恒为全局统一） */
const GROUP_BINDABLE = new Set<ModelPurpose>([
  'CHAT',
  'REALTIME_SUMMARY',
  'FINAL_SUMMARY',
]);

const GROUP_BINDING_FIELD: Record<string, keyof GroupBinding> = {
  CHAT: 'chatModelId',
  REALTIME_SUMMARY: 'realtimeSummaryModelId',
  FINAL_SUMMARY: 'finalSummaryModelId',
};

const PURPOSE_ICONS: Record<ModelPurpose, typeof MessageCircle> = {
  CHAT: MessageCircle,
  REALTIME_SUMMARY: Zap,
  FINAL_SUMMARY: FileText,
  KEYWORD_EXTRACTION: Tag,
  EMBEDDING: Search,
};

const THINKING_MODES: ThinkingMode[] = ['NONE', 'AUTO', 'FORCED', 'DEPTH'];
const THINKING_DEPTHS: ThinkingDepth[] = ['low', 'medium', 'high'];

/** token 数量的紧凑显示：1048576→1M、131072→128K */
function fmtTokens(v: number): string {
  if (v >= 1024 * 1024 && v % (1024 * 1024) === 0) return `${v / (1024 * 1024)}M`;
  if (v >= 1024) return `${Math.round(v / 1024)}K`;
  return String(v);
}

async function readError(res: Response): Promise<string | undefined> {
  const data = await res.json().catch(() => null);
  return data?.error;
}

/* ────────────────────────── 主组件 ────────────────────────── */

export default function LlmSettingsPanel() {
  const { t } = useI18n();
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [groups, setGroups] = useState<GroupBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<'uni' | 'tier'>('uni');
  const [expanded, setExpanded] = useState<Set<ModelPurpose>>(
    () => new Set<ModelPurpose>(['CHAT'])
  );

  // 弹窗状态
  const [gatewayModal, setGatewayModal] = useState<{
    open: boolean;
    gateway?: Gateway;
  }>({ open: false });
  const [modelModal, setModelModal] = useState<{
    open: boolean;
    providerId?: string;
    model?: RegistryModel;
  }>({ open: false });
  const [confirm, setConfirm] = useState<{
    open: boolean;
    title: string;
    message?: string;
    action?: () => Promise<void>;
  }>({ open: false, title: '' });
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());

  /* ── 数据加载 ── */

  const reload = useCallback(async () => {
    try {
      const [provRes, groupRes] = await Promise.all([
        fetch('/api/admin/llm-providers'),
        fetch('/api/admin/llm-group-models'),
      ]);
      if (provRes.ok) {
        const data = await provRes.json();
        const raw: Record<string, unknown>[] = data.providers ?? [];
        setGateways(
          raw.map((p) => ({
            id: p.id as string,
            name: (p.name ?? '') as string,
            apiBase: (p.apiBase ?? '') as string,
            isAnthropic: Boolean(p.isAnthropic),
            hasApiKey: Boolean(p.hasApiKey),
            maskedApiKey: (p.maskedApiKey ?? '') as string,
            registryModels: ((p.registryModels ?? []) as RegistryModel[]).map(
              (m) => ({ ...m, routes: m.routes ?? [] })
            ),
            routes: (p.models ?? []) as RouteRow[],
          }))
        );
      }
      if (groupRes.ok) {
        const data = await groupRes.json();
        setGroups((data.groups ?? []) as GroupBinding[]);
      }
    } catch (err) {
      console.error('加载 LLM 设置失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /* ── 派生数据 ── */

  /** 用途 → 路由行（带网关名） */
  const routesByPurpose = useMemo(() => {
    const map = new Map<ModelPurpose, (RouteRow & { providerName: string })[]>();
    PURPOSES.forEach((p) => map.set(p, []));
    gateways.forEach((g) => {
      g.routes.forEach((r) => {
        map.get(r.purpose)?.push({ ...r, providerName: g.name });
      });
    });
    PURPOSES.forEach((p) =>
      map.get(p)!.sort((a, b) => a.sortOrder - b.sortOrder)
    );
    return map;
  }, [gateways]);

  /** 全部模型库条目（带网关名） */
  const registryAll = useMemo(
    () =>
      gateways.flatMap((g) =>
        g.registryModels.map((m) => ({ ...m, providerName: g.name }))
      ),
    [gateways]
  );

  /** 某用途还能挂载哪些模型库条目（类型匹配 + 未挂载过） */
  const attachablesFor = useCallback(
    (purpose: ModelPurpose) =>
      registryAll.filter(
        (m) =>
          (purpose === 'EMBEDDING') === (m.kind === 'EMBEDDING') &&
          !m.routes.some((r) => r.purpose === purpose)
      ),
    [registryAll]
  );

  /* ── 变更操作（全部即时提交 + 全量重载） ── */

  const patchRoute = useCallback(
    async (routeId: string, data: Record<string, unknown>) => {
      const res = await fetch(`/api/admin/llm-routes/${routeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await reload();
      } else {
        toast.error(t('common.saveFailed'), await readError(res));
      }
    },
    [reload, t]
  );

  const attachModel = useCallback(
    async (registryId: string, purpose: ModelPurpose) => {
      const res = await fetch('/api/admin/llm-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registryId, purpose }),
      });
      if (res.ok) {
        await reload();
        toast.success(t('adminSettings.llmAttached'));
      } else {
        toast.error(t('common.saveFailed'), await readError(res));
      }
    },
    [reload, t]
  );

  const detachRoute = useCallback(
    async (routeId: string) => {
      const res = await fetch(`/api/admin/llm-routes/${routeId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await reload();
      } else {
        toast.error(t('common.deleteFailed'), await readError(res));
      }
    },
    [reload, t]
  );

  const setGroupBinding = useCallback(
    async (groupKey: string, purpose: ModelPurpose, modelId: string) => {
      const res = await fetch('/api/admin/llm-group-models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupKey, purpose, modelId }),
      });
      if (res.ok) {
        await reload();
        toast.success(t('common.saveSuccess'));
      } else {
        toast.error(t('common.saveFailed'), await readError(res));
      }
    },
    [reload, t]
  );

  const verifyModel = useCallback(
    async (providerId: string, registryId: string) => {
      setVerifyingIds((prev) => new Set(prev).add(registryId));
      try {
        const res = await fetch(
          `/api/admin/llm-providers/${providerId}/registry/${registryId}/verify`,
          { method: 'POST' }
        );
        if (res.ok) {
          const data = await res.json();
          await reload();
          if (data.ok) {
            toast.success(t('adminSettings.llmVerifyOk'));
          } else {
            toast.error(
              t('adminSettings.llmVerifyFailed'),
              data.registryModel?.lastError
            );
          }
        } else {
          toast.error(t('adminSettings.llmVerifyFailed'), await readError(res));
        }
      } finally {
        setVerifyingIds((prev) => {
          const next = new Set(prev);
          next.delete(registryId);
          return next;
        });
      }
    },
    [reload, t]
  );

  const askConfirm = useCallback(
    (title: string, message: string, action: () => Promise<void>) => {
      setConfirm({ open: true, title, message, action });
    },
    []
  );

  /* ── 渲染 ── */

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-charcoal-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ═══════════ ① 用途路由 ═══════════ */}
      <section
        data-testid="llm-routing-section"
        className="bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-2xl overflow-hidden"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-cream-100 dark:border-charcoal-700">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 grid place-items-center rounded-lg bg-rust-50 dark:bg-rust-800/30 border border-rust-100 dark:border-rust-700/40 text-rust-600 dark:text-rust-300 text-xs font-mono font-semibold shrink-0 mt-0.5">
              1
            </span>
            <div>
              <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">
                {t('adminSettings.llmRoutingTitle')}
              </h3>
              <p className="text-xs text-charcoal-400 dark:text-charcoal-400 mt-1 max-w-2xl">
                {t('adminSettings.llmRoutingDesc')}
              </p>
            </div>
          </div>
          {/* 统一 / 按会员组 */}
          <div
            className="inline-flex bg-cream-50 dark:bg-charcoal-750 border border-cream-200 dark:border-charcoal-600 rounded-lg p-0.5 gap-0.5"
            role="group"
            aria-label={t('adminSettings.llmScopeLabel')}
          >
            {(['uni', 'tier'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  scope === s
                    ? 'bg-white dark:bg-charcoal-700 text-charcoal-800 dark:text-cream-100 font-medium shadow-sm'
                    : 'text-charcoal-400 dark:text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-200'
                }`}
              >
                {s === 'tier' && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-rust-500 mr-1.5 align-middle" />
                )}
                {t(s === 'uni' ? 'adminSettings.llmScopeUnified' : 'adminSettings.llmScopeTier')}
              </button>
            ))}
          </div>
        </div>

        <div className="p-3.5 space-y-3">
          {PURPOSES.map((purpose) => (
            <PurposeBlock
              key={purpose}
              purpose={purpose}
              routes={routesByPurpose.get(purpose) ?? []}
              attachables={attachablesFor(purpose)}
              open={expanded.has(purpose)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(purpose)) {
                    next.delete(purpose);
                  } else {
                    next.add(purpose);
                  }
                  return next;
                })
              }
              scope={scope}
              groups={groups}
              onPatchRoute={patchRoute}
              onAttach={attachModel}
              onDetach={detachRoute}
              onSetGroupBinding={setGroupBinding}
            />
          ))}
        </div>
      </section>

      {/* ═══════════ ② 模型库 ═══════════ */}
      <section
        data-testid="llm-registry-section"
        className="bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 py-4 border-b border-cream-100 dark:border-charcoal-700">
          <span className="w-6 h-6 grid place-items-center rounded-lg bg-rust-50 dark:bg-rust-800/30 border border-rust-100 dark:border-rust-700/40 text-rust-600 dark:text-rust-300 text-xs font-mono font-semibold shrink-0 mt-0.5">
            2
          </span>
          <div>
            <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">
              {t('adminSettings.llmRegistryTitle')}
            </h3>
            <p className="text-xs text-charcoal-400 dark:text-charcoal-400 mt-1 max-w-2xl">
              {t('adminSettings.llmRegistryDesc')}
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-6">
          {gateways.map((gateway) => (
            <GatewayGroup
              key={gateway.id}
              gateway={gateway}
              verifyingIds={verifyingIds}
              onAddModel={() => setModelModal({ open: true, providerId: gateway.id })}
              onEditModel={(m) =>
                setModelModal({ open: true, providerId: gateway.id, model: m })
              }
              onDeleteModel={(m) =>
                askConfirm(
                  t('adminSettings.llmDeleteModelTitle'),
                  t('adminSettings.llmDeleteModelMessage', {
                    name: m.displayName,
                    n: m.routes.length,
                  }),
                  async () => {
                    const res = await fetch(
                      `/api/admin/llm-providers/${gateway.id}/registry/${m.id}`,
                      { method: 'DELETE' }
                    );
                    if (res.ok) {
                      await reload();
                      toast.success(t('common.deleteSuccess'));
                    } else {
                      toast.error(t('common.deleteFailed'), await readError(res));
                    }
                  }
                )
              }
              onVerifyModel={(m) => verifyModel(gateway.id, m.id)}
              onEditGateway={() => setGatewayModal({ open: true, gateway })}
              onDeleteGateway={() =>
                askConfirm(
                  t('adminSettings.llmDeleteGatewayTitle'),
                  t('adminSettings.llmDeleteGatewayMessage', { name: gateway.name }),
                  async () => {
                    const res = await fetch(`/api/admin/llm-providers/${gateway.id}`, {
                      method: 'DELETE',
                    });
                    if (res.ok) {
                      await reload();
                      toast.success(t('common.deleteSuccess'));
                    } else {
                      toast.error(t('common.deleteFailed'), await readError(res));
                    }
                  }
                )
              }
            />
          ))}

          {gateways.length === 0 && (
            <div className="text-center py-6 text-sm text-charcoal-400 dark:text-charcoal-500">
              {t('adminSettings.noProviders')}
            </div>
          )}

          {/* 新增网关 */}
          <button
            type="button"
            onClick={() => setGatewayModal({ open: true })}
            className="w-full flex items-center justify-center gap-2 py-3 text-sm text-rust-600 dark:text-rust-400 border-2 border-dashed border-cream-200 dark:border-charcoal-600 rounded-xl hover:bg-cream-50 dark:hover:bg-charcoal-750 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('adminSettings.llmAddGateway')}
          </button>
        </div>

        <p className="flex items-start gap-2 px-5 pb-4 text-[11px] text-charcoal-300 dark:text-charcoal-500">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          {t('adminSettings.llmFootnote')}
        </p>
      </section>

      {/* ═══════════ 弹窗 ═══════════ */}
      {gatewayModal.open && (
        <GatewayModal
          gateway={gatewayModal.gateway}
          onClose={() => setGatewayModal({ open: false })}
          onSaved={async () => {
            setGatewayModal({ open: false });
            await reload();
          }}
        />
      )}
      {modelModal.open && modelModal.providerId && (
        <RegistryModelModal
          providerId={modelModal.providerId}
          model={modelModal.model}
          onClose={() => setModelModal({ open: false })}
          onSaved={async () => {
            setModelModal({ open: false });
            await reload();
          }}
        />
      )}
      <ConfirmDialog
        open={confirm.open}
        title={confirm.title}
        message={confirm.message}
        danger
        loading={confirmBusy}
        onCancel={() => setConfirm((c) => ({ ...c, open: false }))}
        onConfirm={async () => {
          if (!confirm.action) return;
          setConfirmBusy(true);
          try {
            await confirm.action();
            setConfirm((c) => ({ ...c, open: false }));
          } finally {
            setConfirmBusy(false);
          }
        }}
      />
    </div>
  );
}

/* ────────────────────────── ① 用途块 ────────────────────────── */

function PurposeBlock({
  purpose,
  routes,
  attachables,
  open,
  onToggle,
  scope,
  groups,
  onPatchRoute,
  onAttach,
  onDetach,
  onSetGroupBinding,
}: {
  purpose: ModelPurpose;
  routes: (RouteRow & { providerName: string })[];
  attachables: (RegistryModel & { providerName: string })[];
  open: boolean;
  onToggle: () => void;
  scope: 'uni' | 'tier';
  groups: GroupBinding[];
  onPatchRoute: (routeId: string, data: Record<string, unknown>) => Promise<void>;
  onAttach: (registryId: string, purpose: ModelPurpose) => Promise<void>;
  onDetach: (routeId: string) => Promise<void>;
  onSetGroupBinding: (
    groupKey: string,
    purpose: ModelPurpose,
    modelId: string
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const Icon = PURPOSE_ICONS[purpose];
  const defaultRoute = routes.find((r) => r.isDefault);
  const isEmbedding = purpose === 'EMBEDDING';
  const tierMode = scope === 'tier';

  const labelKey: Record<ModelPurpose, string> = {
    CHAT: 'adminSettings.purposeChat',
    REALTIME_SUMMARY: 'adminSettings.purposeRealtimeSummary',
    FINAL_SUMMARY: 'adminSettings.purposeFinalSummary',
    KEYWORD_EXTRACTION: 'adminSettings.purposeKeywordExtraction',
    EMBEDDING: 'adminSettings.purposeEmbedding',
  };
  const subKey: Record<ModelPurpose, string> = {
    CHAT: 'adminSettings.llmPurposeSubChat',
    REALTIME_SUMMARY: 'adminSettings.llmPurposeSubRealtime',
    FINAL_SUMMARY: 'adminSettings.llmPurposeSubFinal',
    KEYWORD_EXTRACTION: 'adminSettings.llmPurposeSubKeyword',
    EMBEDDING: 'adminSettings.llmPurposeSubEmbedding',
  };

  return (
    <div
      data-testid="llm-purpose-block"
      data-purpose={purpose}
      className={`border rounded-xl overflow-hidden transition-colors ${
        open
          ? 'bg-white dark:bg-charcoal-800 border-rust-200 dark:border-rust-700/50 shadow-sm'
          : 'bg-cream-50/60 dark:bg-charcoal-750 border-cream-200 dark:border-charcoal-700'
      }`}
    >
      {/* 头部 */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3.5 px-4 py-3.5 text-left"
      >
        <span className="w-9 h-9 grid place-items-center rounded-lg bg-rust-50 dark:bg-rust-800/30 border border-rust-100 dark:border-rust-700/40 text-rust-600 dark:text-rust-300 shrink-0">
          <Icon className="w-[18px] h-[18px]" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-charcoal-800 dark:text-cream-100">
            {t(labelKey[purpose])}
          </span>
          <span className="block text-xs text-charcoal-400 dark:text-charcoal-400 mt-0.5">
            {t(subKey[purpose])}
          </span>
          {purpose === 'REALTIME_SUMMARY' && (
            <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-900/25 dark:text-amber-400 dark:border-amber-700/40">
              <Zap className="w-2.5 h-2.5" />
              {t('adminSettings.llmBadgeHighFreq')}
            </span>
          )}
          {purpose === 'FINAL_SUMMARY' && (
            <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-50 text-green-600 border border-green-200 dark:bg-green-900/25 dark:text-green-400 dark:border-green-700/40">
              {t('adminSettings.llmBadgeQuality')}
            </span>
          )}
        </span>
        <span className="flex items-center gap-3 shrink-0 text-xs text-charcoal-400 dark:text-charcoal-400">
          <span className="font-mono bg-cream-100 dark:bg-charcoal-700 border border-cream-200 dark:border-charcoal-600 rounded-md px-2 py-0.5 text-charcoal-600 dark:text-cream-200 font-semibold">
            {t('adminSettings.llmModelCount', { n: routes.length })}
          </span>
          {defaultRoute && (
            <span className="hidden sm:block max-w-[150px] truncate">
              {t('adminSettings.llmDefaultIs')}{' '}
              <b className="text-charcoal-600 dark:text-cream-200 font-semibold">
                {defaultRoute.displayName}
              </b>
            </span>
          )}
          <ChevronDown
            className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {/* 内容 */}
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-cream-100 dark:border-charcoal-700">
          {/* 高频提示 */}
          {purpose === 'REALTIME_SUMMARY' && (
            <div className="flex items-start gap-2 mt-3 px-3 py-2 rounded-lg text-xs bg-amber-50 border border-amber-200 text-charcoal-500 dark:bg-amber-900/20 dark:border-amber-700/40 dark:text-charcoal-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
              <span>{t('adminSettings.llmRealtimeHint')}</span>
            </div>
          )}

          {/* 按会员组：每组默认模型 */}
          {tierMode && GROUP_BINDABLE.has(purpose) && (
            <div className="flex flex-wrap gap-2.5 mt-3 p-3 rounded-lg bg-cream-50 dark:bg-charcoal-750 border border-dashed border-cream-300 dark:border-charcoal-600">
              {groups.map((g) => {
                const field = GROUP_BINDING_FIELD[purpose] as
                  | 'chatModelId'
                  | 'realtimeSummaryModelId'
                  | 'finalSummaryModelId';
                const value = g[field];
                const stale = Boolean(value) && !routes.some((r) => r.id === value);
                return (
                  <div key={g.key} className="flex items-center gap-2">
                    <span
                      className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-wide ${
                        g.isCustom
                          ? g.color ||
                            'bg-cream-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-300'
                          : g.key === 'PRO'
                            ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400'
                            : 'bg-cream-100 text-charcoal-500 dark:bg-charcoal-700 dark:text-charcoal-300'
                      }`}
                    >
                      {g.name}
                    </span>
                    <select
                      value={stale ? '' : value}
                      onChange={(e) => onSetGroupBinding(g.key, purpose, e.target.value)}
                      className="px-2 py-1.5 text-xs border border-cream-200 dark:border-charcoal-600 rounded-md bg-white dark:bg-charcoal-700 text-charcoal-700 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200"
                    >
                      <option value="">
                        {defaultRoute
                          ? t('adminSettings.llmFollowGlobalWith', {
                              name: defaultRoute.displayName,
                            })
                          : t('adminSettings.llmFollowGlobal')}
                      </option>
                      {routes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.displayName} · {r.providerName}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
          {tierMode && !GROUP_BINDABLE.has(purpose) && (
            <div className="mt-3 px-3 py-2 rounded-lg text-xs bg-cream-50 dark:bg-charcoal-750 border border-dashed border-cream-300 dark:border-charcoal-600 text-charcoal-400 dark:text-charcoal-400">
              {t('adminSettings.llmTierNotBindable')}
            </div>
          )}

          {/* 模型卡网格 */}
          <div className="grid gap-3 mt-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {routes.map((route) => (
              <RouteCard
                key={route.id}
                route={route}
                isEmbedding={isEmbedding}
                hideStar={tierMode && GROUP_BINDABLE.has(purpose)}
                onPatch={onPatchRoute}
                onDetach={onDetach}
              />
            ))}
            <AttachCard
              purpose={purpose}
              attachables={attachables}
              onAttach={onAttach}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 模型路由卡（三级级联：思考 › 深度 › 温度） ── */

function RouteCard({
  route,
  isEmbedding,
  hideStar,
  onPatch,
  onDetach,
}: {
  route: RouteRow & { providerName: string };
  isEmbedding: boolean;
  hideStar: boolean;
  onPatch: (routeId: string, data: Record<string, unknown>) => Promise<void>;
  onDetach: (routeId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const depthEnabled =
    route.thinkingMode === 'FORCED' || route.thinkingMode === 'DEPTH';

  const modeLabel: Record<ThinkingMode, string> = {
    NONE: t('adminSettings.thinkingModeNone'),
    AUTO: t('adminSettings.thinkingModeAuto'),
    FORCED: t('adminSettings.thinkingModeForced'),
    DEPTH: t('adminSettings.thinkingModeDepth'),
  };
  const depthLabel: Record<ThinkingDepth, string> = {
    low: t('adminSettings.thinkingLow'),
    medium: t('adminSettings.thinkingMedium'),
    high: t('adminSettings.thinkingHigh'),
  };

  return (
    <div
      data-testid="llm-route-card"
      data-route-id={route.id}
      className={`rounded-xl border p-3 flex flex-col gap-2.5 bg-white dark:bg-charcoal-800 ${
        route.isDefault
          ? 'border-rust-300 dark:border-rust-600 ring-1 ring-rust-200 dark:ring-rust-700/50'
          : 'border-cream-200 dark:border-charcoal-700'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {!hideStar && (
          <button
            type="button"
            aria-label={t('adminSettings.llmSetDefault')}
            title={t('adminSettings.llmSetDefault')}
            onClick={() => {
              if (!route.isDefault) onPatch(route.id, { isDefault: true });
            }}
            className={`w-8 h-8 grid place-items-center rounded-lg border shrink-0 transition-colors ${
              route.isDefault
                ? 'bg-rust-50 dark:bg-rust-800/30 border-rust-200 dark:border-rust-700/50 text-rust-500 dark:text-rust-400'
                : 'bg-white dark:bg-charcoal-750 border-cream-200 dark:border-charcoal-600 text-charcoal-300 dark:text-charcoal-500 hover:text-rust-400 hover:border-rust-200'
            }`}
          >
            <Star
              className="w-4 h-4"
              fill={route.isDefault ? 'currentColor' : 'none'}
            />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap text-[13px] font-semibold text-charcoal-800 dark:text-cream-100">
            <span className="truncate">{route.displayName}</span>
            {route.isDefault && (
              <span className="px-1.5 py-px rounded text-[9px] font-bold tracking-wide bg-rust-50 dark:bg-rust-800/30 text-rust-600 dark:text-rust-300 border border-rust-200 dark:border-rust-700/50">
                {t('adminSettings.isDefault')}
              </span>
            )}
          </div>
          <div className="text-[11px] font-mono text-charcoal-300 dark:text-charcoal-500 truncate mt-0.5">
            {route.modelId} · {route.providerName}
          </div>
        </div>
        <button
          type="button"
          aria-label={t('adminSettings.llmDetach')}
          title={t('adminSettings.llmDetach')}
          onClick={() => onDetach(route.id)}
          className="w-6 h-6 grid place-items-center rounded-md text-charcoal-300 dark:text-charcoal-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/25 shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {isEmbedding ? (
        <div className="text-[11px] italic text-charcoal-300 dark:text-charcoal-500 px-0.5">
          {t('adminSettings.llmEmbeddingNoParams')}
        </div>
      ) : (
        <div className="flex items-stretch gap-0 rounded-lg bg-cream-50 dark:bg-charcoal-750 border border-cream-200 dark:border-charcoal-600 p-1.5">
          {/* ① 思考 */}
          <div className="flex-[1.3] min-w-0 px-1">
            <div className="text-[9px] uppercase tracking-wider font-semibold text-charcoal-300 dark:text-charcoal-500 px-1 pb-0.5">
              <span className="font-mono text-rust-500 dark:text-rust-400">①</span>{' '}
              {t('adminSettings.llmCascadeThinking')}
            </div>
            <select
              value={route.thinkingMode}
              onChange={(e) => onPatch(route.id, { thinkingMode: e.target.value })}
              className="w-full text-xs px-1.5 py-1.5 rounded-md border border-cream-300 dark:border-charcoal-600 bg-white dark:bg-charcoal-700 text-charcoal-700 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200"
            >
              {THINKING_MODES.map((m) => (
                <option key={m} value={m}>
                  {modeLabel[m]}
                </option>
              ))}
            </select>
          </div>
          {/* ② 深度 */}
          <div
            className={`flex-1 min-w-0 px-1 border-l border-cream-300 dark:border-charcoal-600 ${
              depthEnabled ? '' : 'opacity-40'
            }`}
          >
            <div className="text-[9px] uppercase tracking-wider font-semibold text-charcoal-300 dark:text-charcoal-500 px-1 pb-0.5">
              <span className="font-mono text-rust-500 dark:text-rust-400">②</span>{' '}
              {t('adminSettings.llmCascadeDepth')}
            </div>
            <select
              value={route.thinkingDepth}
              disabled={!depthEnabled}
              onChange={(e) => onPatch(route.id, { thinkingDepth: e.target.value })}
              className="w-full text-xs px-1.5 py-1.5 rounded-md border border-cream-300 dark:border-charcoal-600 bg-white dark:bg-charcoal-700 text-charcoal-700 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200 disabled:cursor-not-allowed disabled:bg-cream-100 dark:disabled:bg-charcoal-750"
            >
              {!depthEnabled && <option value={route.thinkingDepth}>—</option>}
              {depthEnabled &&
                THINKING_DEPTHS.map((d) => (
                  <option key={d} value={d}>
                    {depthLabel[d]}
                  </option>
                ))}
            </select>
          </div>
          {/* ③ 温度 */}
          <div className="flex-[0.72] min-w-0 px-1 border-l border-cream-300 dark:border-charcoal-600">
            <div className="text-[9px] uppercase tracking-wider font-semibold text-charcoal-300 dark:text-charcoal-500 px-1 pb-0.5">
              <span className="font-mono text-rust-500 dark:text-rust-400">③</span>{' '}
              {t('adminSettings.llmCascadeTemp')}
            </div>
            <TemperatureInput
              key={`${route.id}-${route.temperature}`}
              value={route.temperature}
              onCommit={(v) => onPatch(route.id, { temperature: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** 温度输入：失焦 / 回车时提交（0–2，一位小数） */
function TemperatureInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      setText(String(value));
      return;
    }
    const rounded = Math.round(n * 10) / 10;
    if (rounded !== value) {
      onCommit(rounded);
    } else {
      setText(String(value));
    }
  };

  return (
    <input
      type="number"
      step={0.1}
      min={0}
      max={2}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="w-full min-w-[3.25rem] text-xs font-mono text-center px-1 py-1.5 rounded-md border border-cream-300 dark:border-charcoal-600 bg-white dark:bg-charcoal-700 text-charcoal-700 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

/* ── 添加模型卡 ── */

function AttachCard({
  purpose,
  attachables,
  onAttach,
}: {
  purpose: ModelPurpose;
  attachables: (RegistryModel & { providerName: string })[];
  onAttach: (registryId: string, purpose: ModelPurpose) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setSelected(attachables[0]?.id ?? '');
        }}
        className="min-h-[88px] rounded-xl border-2 border-dashed border-cream-200 dark:border-charcoal-600 text-charcoal-400 dark:text-charcoal-400 hover:text-rust-500 hover:border-rust-200 dark:hover:border-rust-700/50 transition-colors flex items-center justify-center gap-2 text-sm"
      >
        <Plus className="w-4 h-4" />
        {t('adminSettings.llmAttachModel')}
      </button>
    );
  }

  return (
    <div className="rounded-xl border-2 border-dashed border-cream-300 dark:border-charcoal-600 p-3 flex flex-col gap-2 justify-center">
      {attachables.length === 0 ? (
        <>
          <div className="text-xs text-charcoal-400 dark:text-charcoal-400 text-center">
            {t('adminSettings.llmNoAttachable')}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-200"
          >
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full text-xs px-2 py-2 rounded-lg border border-cream-300 dark:border-charcoal-600 bg-white dark:bg-charcoal-700 text-charcoal-700 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200"
          >
            {attachables.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} · {m.providerName}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !selected}
              onClick={async () => {
                setBusy(true);
                try {
                  await onAttach(selected, purpose);
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-rust-500 text-white hover:bg-rust-600 disabled:opacity-50"
            >
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('adminSettings.llmAttachConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-2 text-xs rounded-lg text-charcoal-400 hover:bg-cream-50 dark:hover:bg-charcoal-750"
            >
              {t('common.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ────────────────────────── ② 模型库 ────────────────────────── */

function GatewayGroup({
  gateway,
  verifyingIds,
  onAddModel,
  onEditModel,
  onDeleteModel,
  onVerifyModel,
  onEditGateway,
  onDeleteGateway,
}: {
  gateway: Gateway;
  verifyingIds: Set<string>;
  onAddModel: () => void;
  onEditModel: (m: RegistryModel) => void;
  onDeleteModel: (m: RegistryModel) => void;
  onVerifyModel: (m: RegistryModel) => void;
  onEditGateway: () => void;
  onDeleteGateway: () => void;
}) {
  const { t } = useI18n();
  const models = gateway.registryModels;
  const n = models.length;
  // 动态列：≤3 个铺满一行、正好 4 个排成 4 列、更多回到 3 列
  const xlCols =
    n <= 1
      ? 'xl:grid-cols-1'
      : n === 2
        ? 'xl:grid-cols-2'
        : n === 3
          ? 'xl:grid-cols-3'
          : n === 4
            ? 'xl:grid-cols-4'
            : 'xl:grid-cols-3';

  const allOk = n > 0 && models.every((m) => m.status === 'OK');
  const anyFailed = models.some((m) => m.status === 'FAILED');
  const statusDot = allOk
    ? 'bg-green-500'
    : anyFailed
      ? 'bg-red-500'
      : 'bg-amber-400';
  const statusText = allOk
    ? t('adminSettings.llmGatewayOnline')
    : anyFailed
      ? t('adminSettings.llmGatewayFailed')
      : t('adminSettings.llmGatewayUnverified');

  return (
    <div data-testid="llm-gateway-group" data-gateway-id={gateway.id} className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-sm font-semibold text-charcoal-800 dark:text-cream-100">
          {gateway.name}
        </span>
        <span className="font-mono text-[11px] text-charcoal-400 dark:text-charcoal-400 bg-cream-50 dark:bg-charcoal-750 border border-cream-200 dark:border-charcoal-600 rounded-md px-2 py-0.5 max-w-[260px] truncate">
          {gateway.apiBase.replace(/^https?:\/\//, '')}
        </span>
        {gateway.isAnthropic && (
          <span className="px-1.5 py-px rounded text-[9px] font-bold bg-cream-100 dark:bg-charcoal-700 text-charcoal-500 dark:text-charcoal-300 border border-cream-200 dark:border-charcoal-600">
            Anthropic
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-charcoal-400 dark:text-charcoal-400">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          {statusText} · {t('adminSettings.llmModelCount', { n })}
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAddModel}
            className="inline-flex items-center gap-1 h-7 px-2.5 text-xs rounded-lg border border-cream-200 dark:border-charcoal-600 text-charcoal-500 dark:text-charcoal-300 hover:text-rust-500 hover:border-rust-200 dark:hover:border-rust-700/50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('adminSettings.llmAddRegistryModel')}
          </button>
          <button
            type="button"
            onClick={onEditGateway}
            aria-label={t('adminSettings.llmEditGateway')}
            title={t('adminSettings.llmEditGateway')}
            className="w-7 h-7 grid place-items-center rounded-lg border border-cream-200 dark:border-charcoal-600 text-charcoal-400 dark:text-charcoal-400 hover:text-rust-500 hover:border-rust-200"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDeleteGateway}
            aria-label={t('adminSettings.deleteProvider')}
            title={t('adminSettings.deleteProvider')}
            className="w-7 h-7 grid place-items-center rounded-lg border border-cream-200 dark:border-charcoal-600 text-charcoal-400 dark:text-charcoal-400 hover:text-red-500 hover:border-red-200"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {n === 0 ? (
        <div className="text-xs text-charcoal-300 dark:text-charcoal-500 border border-dashed border-cream-200 dark:border-charcoal-600 rounded-lg px-3 py-4 text-center">
          {t('adminSettings.llmGatewayNoModels')}
        </div>
      ) : (
        <div className={`grid gap-3 grid-cols-1 sm:grid-cols-2 ${xlCols}`}>
          {models.map((m) => (
            <RegistryCard
              key={m.id}
              model={m}
              verifying={verifyingIds.has(m.id)}
              onEdit={() => onEditModel(m)}
              onDelete={() => onDeleteModel(m)}
              onVerify={() => onVerifyModel(m)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RegistryCard({
  model,
  verifying,
  onEdit,
  onDelete,
  onVerify,
}: {
  model: RegistryModel;
  verifying: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onVerify: () => void;
}) {
  const { t } = useI18n();
  const isEmbedding = model.kind === 'EMBEDDING';

  const purposeShort: Record<ModelPurpose, string> = {
    CHAT: t('adminSettings.purposeChat'),
    REALTIME_SUMMARY: t('adminSettings.purposeRealtimeSummary'),
    FINAL_SUMMARY: t('adminSettings.purposeFinalSummary'),
    KEYWORD_EXTRACTION: t('adminSettings.purposeKeywordExtraction'),
    EMBEDDING: t('adminSettings.purposeEmbedding'),
  };

  return (
    <div
      data-testid="llm-registry-card"
      data-registry-id={model.id}
      className="rounded-xl border border-cream-200 dark:border-charcoal-700 bg-cream-50/60 dark:bg-charcoal-750 hover:border-rust-200 dark:hover:border-rust-700/50 transition-colors p-3 flex flex-col gap-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-charcoal-800 dark:text-cream-100 truncate">
            {model.displayName}
          </div>
          <div className="text-[11px] font-mono text-charcoal-400 dark:text-charcoal-500 truncate mt-0.5">
            {model.modelId}
          </div>
        </div>
        {isEmbedding ? (
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rust-50 dark:bg-rust-800/30 text-rust-600 dark:text-rust-300 border border-rust-200 dark:border-rust-700/50">
            {t('adminSettings.llmPillEmbedding')}
          </span>
        ) : model.status === 'OK' ? (
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-50 text-green-600 border border-green-200 dark:bg-green-900/25 dark:text-green-400 dark:border-green-700/40">
            {t('adminSettings.llmPillOnline')}
          </span>
        ) : model.status === 'FAILED' ? (
          <span
            className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-600 border border-red-200 dark:bg-red-900/25 dark:text-red-400 dark:border-red-700/40"
            title={model.lastError ?? undefined}
          >
            {t('adminSettings.llmPillFailed')}
          </span>
        ) : (
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-900/25 dark:text-amber-400 dark:border-amber-700/40">
            {t('adminSettings.llmPillUnverified')}
          </span>
        )}
      </div>

      {/* 规格 */}
      <div className="grid grid-cols-3 gap-1.5">
        <SpecCell
          label={t('adminSettings.inputModality')}
          value={
            model.supportsImage
              ? t('adminSettings.llmSpecTextImage')
              : t('adminSettings.llmSpecText')
          }
          text
        />
        <SpecCell
          label={
            isEmbedding
              ? t('adminSettings.llmSpecMaxInput')
              : t('adminSettings.contextWindow')
          }
          value={fmtTokens(model.contextWindow)}
        />
        {isEmbedding ? (
          <SpecCell
            label={t('adminSettings.llmSpecDimensions')}
            value={model.embeddingDimensions ? String(model.embeddingDimensions) : '—'}
          />
        ) : (
          <SpecCell
            label={t('adminSettings.llmSpecOutput')}
            value={fmtTokens(model.maxTokens)}
          />
        )}
      </div>

      {/* 挂载信息 + 操作 */}
      <div className="flex items-center justify-between gap-2 mt-auto">
        <div className="text-[10px] text-charcoal-300 dark:text-charcoal-500 truncate">
          {model.routes.length > 0
            ? t('adminSettings.llmAttachedTo', {
                list: model.routes.map((r) => purposeShort[r.purpose]).join(' / '),
              })
            : t('adminSettings.llmNotAttached')}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onVerify}
            disabled={verifying}
            aria-label={t('adminSettings.llmVerify')}
            title={t('adminSettings.llmVerify')}
            className="w-6 h-6 grid place-items-center rounded-md text-charcoal-300 dark:text-charcoal-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/25 disabled:opacity-50"
          >
            {verifying ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('common.edit')}
            title={t('common.edit')}
            className="w-6 h-6 grid place-items-center rounded-md text-charcoal-300 dark:text-charcoal-500 hover:text-rust-500 hover:bg-rust-50 dark:hover:bg-rust-800/30"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('common.delete')}
            title={t('common.delete')}
            className="w-6 h-6 grid place-items-center rounded-md text-charcoal-300 dark:text-charcoal-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/25"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {model.status === 'FAILED' && model.lastError && (
        <div className="flex items-start gap-1.5 text-[10px] text-red-500 dark:text-red-400">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span className="break-all line-clamp-2">{model.lastError}</span>
        </div>
      )}
    </div>
  );
}

function SpecCell({
  label,
  value,
  text,
}: {
  label: string;
  value: string;
  text?: boolean;
}) {
  return (
    <div className="bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-lg px-2 py-1.5 min-w-0">
      <div className="text-[9px] uppercase tracking-wider font-semibold text-charcoal-300 dark:text-charcoal-500 whitespace-nowrap truncate">
        {label}
      </div>
      <div
        className={`mt-0.5 font-semibold text-charcoal-700 dark:text-cream-100 truncate ${
          text ? 'text-[11px]' : 'text-xs font-mono tabular-nums'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/* ────────────────────────── 弹窗：网关 ────────────────────────── */

function GatewayModal({
  gateway,
  onClose,
  onSaved,
}: {
  gateway?: Gateway;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const isNew = !gateway;
  const [name, setName] = useState(gateway?.name ?? '');
  const [apiBase, setApiBase] = useState(gateway?.apiBase ?? '');
  const [apiKey, setApiKey] = useState('');
  const [isAnthropic, setIsAnthropic] = useState(gateway?.isAnthropic ?? false);
  const [saving, setSaving] = useState(false);

  const inputCls =
    'w-full px-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg bg-white dark:bg-charcoal-700 text-charcoal-800 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300';

  const submit = async () => {
    if (!name.trim() || !apiBase.trim() || (isNew && !apiKey.trim())) {
      toast.error(t('adminSettings.llmGatewayMissingFields'));
      return;
    }
    setSaving(true);
    try {
      const url = isNew
        ? '/api/admin/llm-providers'
        : `/api/admin/llm-providers/${gateway!.id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          apiBase: apiBase.trim(),
          isAnthropic,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (res.ok) {
        toast.success(isNew ? t('common.createSuccess') : t('common.saveSuccess'));
        await onSaved();
      } else {
        toast.error(
          isNew ? t('common.createFailed') : t('common.saveFailed'),
          await readError(res)
        );
      }
    } catch {
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative w-full max-w-md bg-white dark:bg-charcoal-800 rounded-2xl shadow-xl border border-cream-200 dark:border-charcoal-700 p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 grid place-items-center rounded-lg bg-rust-50 dark:bg-rust-800/30 text-rust-500 dark:text-rust-300">
              <Server className="w-4 h-4" />
            </span>
            <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">
              {isNew
                ? t('adminSettings.llmAddGateway')
                : t('adminSettings.llmEditGateway')}
            </h3>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                {t('adminSettings.providerName')}
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('adminSettings.providerNamePlaceholder')}
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                {t('adminSettings.apiUrl')}
              </label>
              <input
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://api.example.com/v1"
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                {t('adminSettings.apiKey')}
                {!isNew && gateway?.hasApiKey && (
                  <span className="text-charcoal-300 dark:text-charcoal-500 ml-1.5">
                    {t('adminSettings.llmApiKeyKeepHint', {
                      masked: gateway.maskedApiKey,
                    })}
                  </span>
                )}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isNew ? 'sk-...' : '••••••••'}
                className={inputCls}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-charcoal-600 dark:text-cream-200 cursor-pointer">
              <input
                type="checkbox"
                checked={isAnthropic}
                onChange={(e) => setIsAnthropic(e.target.checked)}
                className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
              />
              {t('adminSettings.isAnthropicApi')}
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-charcoal-500 dark:text-charcoal-300 hover:bg-cream-50 dark:hover:bg-charcoal-750"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={submit}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-rust-500 text-white hover:bg-rust-600 disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

/* ────────────────────────── 弹窗：模型库条目 ────────────────────────── */

function RegistryModelModal({
  providerId,
  model,
  onClose,
  onSaved,
}: {
  providerId: string;
  model?: RegistryModel;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const isNew = !model;
  const [displayName, setDisplayName] = useState(model?.displayName ?? '');
  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [kind, setKind] = useState<RegistryKind>(model?.kind ?? 'TEXT');
  const [supportsImage, setSupportsImage] = useState(model?.supportsImage ?? false);
  const [contextWindow, setContextWindow] = useState(
    String(model?.contextWindow ?? 131072)
  );
  const [maxTokens, setMaxTokens] = useState(String(model?.maxTokens ?? 4096));
  const [dimensions, setDimensions] = useState(
    model?.embeddingDimensions ? String(model.embeddingDimensions) : ''
  );
  const [saving, setSaving] = useState(false);

  const inputCls =
    'w-full px-3 py-2 text-sm border border-cream-200 dark:border-charcoal-600 rounded-lg bg-white dark:bg-charcoal-700 text-charcoal-800 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-200 focus:border-rust-300';

  const submit = async () => {
    if (!displayName.trim() || !modelId.trim()) {
      toast.error(t('adminSettings.llmModelMissingFields'));
      return;
    }
    const ctx = Number(contextWindow);
    const out = Number(maxTokens);
    if (!Number.isFinite(out) || out < 1 || !Number.isFinite(ctx) || ctx < out) {
      toast.error(t('adminSettings.contextWindowTooLow'));
      return;
    }
    setSaving(true);
    try {
      const url = isNew
        ? `/api/admin/llm-providers/${providerId}/registry`
        : `/api/admin/llm-providers/${providerId}/registry/${model!.id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          modelId: modelId.trim(),
          kind,
          supportsImage: kind === 'TEXT' ? supportsImage : false,
          contextWindow: ctx,
          maxTokens: out,
          embeddingDimensions:
            kind === 'EMBEDDING' && dimensions.trim() ? Number(dimensions) : null,
        }),
      });
      if (res.ok) {
        toast.success(isNew ? t('common.createSuccess') : t('common.saveSuccess'));
        await onSaved();
      } else {
        toast.error(
          isNew ? t('common.createFailed') : t('common.saveFailed'),
          await readError(res)
        );
      }
    } catch {
      toast.error(t('common.saveFailed'), t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative w-full max-w-md bg-white dark:bg-charcoal-800 rounded-2xl shadow-xl border border-cream-200 dark:border-charcoal-700 p-5 space-y-4">
          <h3 className="text-base font-semibold text-charcoal-800 dark:text-cream-100">
            {isNew
              ? t('adminSettings.llmAddRegistryModelTitle')
              : t('adminSettings.llmEditRegistryModelTitle')}
          </h3>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                  {t('adminSettings.modelDisplayName')}
                </label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Doubao Pro"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                  {t('adminSettings.modelId')}
                </label>
                <input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="doubao-seed-2-0-pro"
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                {t('adminSettings.llmModelKind')}
              </label>
              <div className="flex gap-2">
                {(['TEXT', 'EMBEDDING'] as RegistryKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      kind === k
                        ? 'bg-rust-50 dark:bg-rust-800/30 border-rust-300 dark:border-rust-600 text-rust-600 dark:text-rust-300 font-medium'
                        : 'border-cream-200 dark:border-charcoal-600 text-charcoal-400 dark:text-charcoal-400 hover:border-rust-200'
                    }`}
                  >
                    {k === 'TEXT'
                      ? t('adminSettings.llmModelKindText')
                      : t('adminSettings.llmModelKindEmbedding')}
                  </button>
                ))}
              </div>
            </div>

            {kind === 'TEXT' && (
              <label className="flex items-center gap-2 text-sm text-charcoal-600 dark:text-cream-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={supportsImage}
                  onChange={(e) => setSupportsImage(e.target.checked)}
                  className="rounded border-cream-300 text-rust-500 focus:ring-rust-200"
                />
                {t('adminSettings.inputModalityTextImage')}
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                  {kind === 'EMBEDDING'
                    ? t('adminSettings.llmSpecMaxInput')
                    : t('adminSettings.contextWindow')}
                </label>
                <input
                  type="number"
                  value={contextWindow}
                  onChange={(e) => setContextWindow(e.target.value)}
                  className={inputCls}
                />
                <p className="text-[10px] text-charcoal-300 dark:text-charcoal-500 mt-1">
                  {t('adminSettings.llmContextHint')}
                </p>
              </div>
              {kind === 'EMBEDDING' ? (
                <div>
                  <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                    {t('adminSettings.llmSpecDimensions')}
                  </label>
                  <input
                    type="number"
                    value={dimensions}
                    onChange={(e) => setDimensions(e.target.value)}
                    placeholder="2048"
                    className={inputCls}
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs text-charcoal-500 dark:text-charcoal-300 mb-1 block">
                    {t('adminSettings.maxTokens')}
                  </label>
                  <input
                    type="number"
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(e.target.value)}
                    className={inputCls}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-charcoal-500 dark:text-charcoal-300 hover:bg-cream-50 dark:hover:bg-charcoal-750"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={submit}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-rust-500 text-white hover:bg-rust-600 disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
