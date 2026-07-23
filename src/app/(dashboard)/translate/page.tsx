'use client';

// 翻译页：文本（Google Translate 式双栏，SSE 流式）+ 文档（PDF 上传→报价→进度→下载）。
// 版式对齐 interpret 全屏工具页（浅色、cream/charcoal/rust）；数据接 /api/translate/*。

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import {
  Languages,
  ArrowLeftRight,
  Copy,
  Check,
  Loader2,
  Type,
  FileOutput,
  UploadCloud,
  FileText,
  Download,
  Eye,
  RotateCcw,
  Trash2,
  X,
  ChevronDown,
} from 'lucide-react';
import LanguageSelect from '@/components/LanguageSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';

/* ────────────────────────── 类型 ────────────────────────── */

interface TranslateModelOption {
  id: string;
  displayName: string;
  modelId: string;
}

interface TranslateConfig {
  textEnabled: boolean;
  docEnabled: boolean;
  textBillingMode: 'free' | 'per_char';
  textDailyFreeLimit: number;
  textPriceCentsPerKchar: number;
  docPriceCentsPerPage: number;
  docMaxPages: number;
  docMaxMb: number;
}

interface DocTask {
  id: string;
  fileName: string;
  fileBytes: number;
  pageCount: number;
  status: string;
  progress: number;
  sourceLang: string;
  targetLang: string;
  estimatedCents: number;
  chargedCents: number;
  refunded: boolean;
  hasMono: boolean;
  hasDual: boolean;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* ────────────────────────── 工具 ────────────────────────── */

function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 解析 SSE 文本流（event:/data: 帧），逐事件回调 */
async function consumeSse(
  res: Response,
  onEvent: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        try {
          onEvent(event, JSON.parse(data));
        } catch {
          // 跳过坏帧
        }
      }
    }
  }
}

/* ────────────────────────── 页面 ────────────────────────── */

export default function TranslatePage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'text' | 'doc'>('text');

  // ?tab=doc 直达文档 tab（避免 useSearchParams 的 Suspense 边界要求，挂载后读一次）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'doc') {
      setTab('doc');
    }
  }, []);

  const [models, setModels] = useState<TranslateModelOption[]>([]);
  const [modelId, setModelId] = useState('');
  const [config, setConfig] = useState<TranslateConfig | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/translate/models');
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        setModelId(typeof data.defaultModel === 'string' ? data.defaultModel : '');
        setConfig(data.config ?? null);
      } catch {
        // 静默：页面按默认配置渲染
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      {/* 页头 + tab 切换 */}
      <div className="sticky top-0 z-20 border-b border-cream-200 bg-white/95 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 md:px-6 pt-5 pb-0">
          <div className="flex items-center gap-2.5">
            <Languages className="w-6 h-6 text-rust-500" />
            <h1 className="font-serif text-xl md:text-2xl font-bold text-charcoal-800">
              {t('translate.title')}
            </h1>
          </div>
          <div className="flex gap-1 mt-3">
            {(
              [
                { id: 'text', label: t('translate.tabText'), icon: Type },
                { id: 'doc', label: t('translate.tabDoc'), icon: FileOutput },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                  tab === id
                    ? 'text-rust-600 bg-cream-50'
                    : 'text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-50/60'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
                <span
                  className={`absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-rust-500 transition-transform duration-300 ${
                    tab === id ? 'scale-x-100' : 'scale-x-0'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div key={tab} className="flex-1 max-w-5xl w-full mx-auto px-4 md:px-6 py-6 animate-fade-in max-md:pb-28">
        {tab === 'text' ? (
          <TextTranslateTab models={models} modelId={modelId} setModelId={setModelId} config={config} />
        ) : (
          <DocTranslateTab config={config} />
        )}
      </div>
    </div>
  );
}

/* ────────────────────────── 文本翻译 ────────────────────────── */

function TextTranslateTab({
  models,
  modelId,
  setModelId,
  config,
}: {
  models: TranslateModelOption[];
  modelId: string;
  setModelId: (v: string) => void;
  config: TranslateConfig | null;
}) {
  const { t } = useI18n();
  const [sourceLang, setSourceLang] = useState(''); // '' = auto
  const [targetLang, setTargetLang] = useState('zh');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [translating, setTranslating] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const disabled = config ? !config.textEnabled : false;

  const runTranslate = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      if (!text.trim()) {
        setOutput('');
        setTranslating(false);
        return;
      }
      const seq = ++seqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setTranslating(true);
      setOutput('');
      let acc = '';
      try {
        const res = await fetch('/api/translate/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            sourceLang: sourceLang || 'auto',
            targetLang,
            modelId: modelId || undefined,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          if (seq === seqRef.current) {
            if (data?.code === 'daily_limit_reached') {
              toast.error(t('translate.dailyLimitReached'));
            } else if (data?.code === 'insufficient_balance') {
              toast.error(t('translate.insufficientBalance'));
            } else {
              toast.error(data?.error ?? t('common.networkError'));
            }
          }
          return;
        }
        await consumeSse(res, (event, data) => {
          if (seq !== seqRef.current) return;
          if (event === 'text' && typeof data.delta === 'string') {
            acc += data.delta;
            setOutput(acc);
          } else if (event === 'error' && typeof data.message === 'string') {
            toast.error(data.message);
          }
        });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          if (seq === seqRef.current) toast.error(t('common.networkError'));
        }
      } finally {
        if (seq === seqRef.current) setTranslating(false);
      }
    },
    [sourceLang, targetLang, modelId, t]
  );

  // 输入防抖自动翻译（800ms）
  const handleInput = (value: string) => {
    setInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runTranslate(value), 800);
  };

  // 语言/模型变化时对已有输入重翻
  useEffect(() => {
    if (input.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runTranslate(input), 200);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLang, targetLang, modelId]);

  // 卸载时终止在途请求
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSwap = () => {
    if (!sourceLang) return; // auto 无法交换
    const nextSource = targetLang;
    const nextTarget = sourceLang;
    setSourceLang(nextSource);
    setTargetLang(nextTarget);
    setInput(output);
    setOutput('');
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  if (disabled) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-charcoal-400">
        <Type className="w-10 h-10 animate-breathe" />
        <p className="text-sm">{t('translate.textDisabled')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 语言栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <LanguageSelect
          value={sourceLang}
          onChange={setSourceLang}
          allowNone
          noneLabel={t('translate.autoDetect')}
          excludeCodes={[targetLang]}
          className="w-44"
        />
        <button
          onClick={handleSwap}
          disabled={!sourceLang}
          title={t('translate.swap')}
          className="p-2 rounded-lg text-charcoal-500 hover:bg-cream-100 hover:text-charcoal-700
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowLeftRight className="w-4 h-4" />
        </button>
        <LanguageSelect
          value={targetLang}
          onChange={setTargetLang}
          excludeCodes={sourceLang ? [sourceLang] : []}
          className="w-44"
        />
        {models.length > 0 && (
          <div className="relative ml-auto">
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 text-sm border border-cream-200 rounded-lg bg-white
                         text-charcoal-700 focus:outline-none focus:ring-2 focus:ring-rust-200"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-charcoal-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        )}
      </div>

      {/* 双栏 */}
      <div className="grid md:grid-cols-2 gap-3">
        <div className="relative bg-white rounded-xl border border-cream-200 focus-within:border-rust-300 focus-within:ring-2 focus-within:ring-rust-100 transition-shadow">
          <textarea
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                runTranslate(input);
              }
            }}
            maxLength={10000}
            placeholder={t('translate.inputPlaceholder')}
            className="w-full h-64 md:h-80 p-4 text-base text-charcoal-800 bg-transparent resize-none
                       focus:outline-none placeholder:text-charcoal-300"
          />
          <div className="absolute bottom-2.5 left-4 right-3 flex items-center justify-between">
            <span className="text-[11px] text-charcoal-300 tabular-nums">
              {input.length} / 10000
            </span>
            {input && (
              <button
                onClick={() => {
                  setInput('');
                  setOutput('');
                  abortRef.current?.abort();
                }}
                className="p-1 text-charcoal-300 hover:text-charcoal-500 rounded"
                title={t('common.clear')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="relative bg-cream-50 rounded-xl border border-cream-200">
          <div className="w-full h-64 md:h-80 p-4 text-base text-charcoal-800 overflow-y-auto whitespace-pre-wrap break-words">
            {output ||
              (translating ? (
                <span className="inline-flex items-center gap-2 text-charcoal-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('translate.translating')}
                </span>
              ) : (
                <span className="text-charcoal-300">{t('translate.outputPlaceholder')}</span>
              ))}
          </div>
          {output && (
            <button
              onClick={handleCopy}
              className="absolute bottom-2.5 right-3 flex items-center gap-1 px-2 py-1 text-xs text-charcoal-500
                         hover:text-charcoal-700 hover:bg-cream-100 rounded-md transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          )}
        </div>
      </div>

      {/* 计费提示 */}
      {config && (
        <p className="text-[11px] text-charcoal-400">
          {config.textBillingMode === 'per_char'
            ? t('translate.perCharHint', {
                price: yuan(config.textPriceCentsPerKchar),
              })
            : config.textDailyFreeLimit > 0
              ? t('translate.freeDailyHint', { n: config.textDailyFreeLimit })
              : t('translate.freeUnlimitedHint')}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────── 文档翻译 ────────────────────────── */

const ACTIVE_STATUSES = new Set(['PENDING', 'TRANSLATING']);

function DocTranslateTab({ config }: { config: TranslateConfig | null }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<DocTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('zh');
  const [quote, setQuote] = useState<{ task: DocTask; balance: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocTask | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const disabled = config ? !config.docEnabled : false;

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/translate/documents');
      if (res.ok) {
        const data = await res.json();
        setTasks(Array.isArray(data.tasks) ? data.tasks : []);
      }
    } catch {
      // 静默
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 在途任务轮询（5s）：单任务 GET 顺带踢服务端调度 tick
  const activeIds = useMemo(
    () => tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).map((task) => task.id),
    [tasks]
  );
  useEffect(() => {
    if (activeIds.length === 0) return;
    const timer = setInterval(async () => {
      const updates = await Promise.all(
        activeIds.map(async (id) => {
          try {
            const res = await fetch(`/api/translate/documents/${id}`);
            if (!res.ok) return null;
            const data = await res.json();
            return data.task as DocTask;
          } catch {
            return null;
          }
        })
      );
      setTasks((prev) =>
        prev.map((task) => updates.find((u) => u?.id === task.id) ?? task)
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [activeIds]);

  const handleFile = async (file: File) => {
    if (!file) return;
    if (config && file.size > config.docMaxMb * 1024 * 1024) {
      toast.error(t('translate.fileTooLarge', { mb: config.docMaxMb }));
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('sourceLang', sourceLang);
      form.append('targetLang', targetLang);
      const res = await fetch('/api/translate/documents', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? t('common.networkError'));
        return;
      }
      if (data?.task) {
        setQuote({ task: data.task, balance: data.walletBalanceCents ?? 0 });
        await reload();
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleConfirm = async () => {
    if (!quote) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/translate/documents/${quote.task.id}/confirm`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.code === 'insufficient_balance') {
          toast.error(t('translate.insufficientBalance'));
        } else {
          toast.error(data?.error ?? t('common.networkError'));
        }
        return;
      }
      toast.success(t('translate.taskStarted'));
      setQuote(null);
      await reload();
    } finally {
      setConfirming(false);
    }
  };

  const handleCancelQuote = async () => {
    if (!quote) return;
    await fetch(`/api/translate/documents/${quote.task.id}`, { method: 'DELETE' }).catch(
      () => undefined
    );
    setQuote(null);
    await reload();
  };

  const handleRetry = async (task: DocTask) => {
    const res = await fetch(`/api/translate/documents/${task.id}/retry`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (data?.code === 'insufficient_balance') {
        toast.error(t('translate.insufficientBalance'));
      } else {
        toast.error(data?.error ?? t('common.networkError'));
      }
      return;
    }
    toast.success(t('translate.taskStarted'));
    await reload();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/translate/documents/${deleteTarget.id}`, {
      method: 'DELETE',
    }).catch(() => null);
    if (!res?.ok) {
      toast.error(t('common.networkError'));
    } else {
      const data = await res.json().catch(() => null);
      if (data?.canceled) toast.success(t('translate.taskCanceled'));
    }
    setDeleteTarget(null);
    await reload();
  };

  if (disabled) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-charcoal-400">
        <FileOutput className="w-10 h-10 animate-breathe" />
        <p className="text-sm">{t('translate.docDisabled')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 语言选择 + 上传卡 */}
      <div className="flex items-center gap-2 flex-wrap">
        <LanguageSelect value={sourceLang} onChange={setSourceLang} excludeCodes={[targetLang]} className="w-44" />
        <ArrowLeftRight className="w-4 h-4 text-charcoal-300" />
        <LanguageSelect value={targetLang} onChange={setTargetLang} excludeCodes={[sourceLang]} className="w-44" />
        {config && (
          <span className="ml-auto text-[11px] text-charcoal-400">
            {t('translate.docPricingHint', {
              price: yuan(config.docPriceCentsPerPage),
              pages: config.docMaxPages,
              mb: config.docMaxMb,
            })}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        disabled={uploading}
        className={`w-full flex flex-col items-center justify-center gap-2.5 py-10 rounded-xl border-2 border-dashed
                    transition-colors ${
                      dragOver
                        ? 'border-rust-400 bg-rust-50'
                        : 'border-cream-300 bg-cream-50/50 hover:border-rust-300 hover:bg-cream-50'
                    } disabled:opacity-60`}
      >
        {uploading ? (
          <Loader2 className="w-8 h-8 text-rust-400 animate-spin" />
        ) : (
          <UploadCloud className="w-8 h-8 text-rust-400" />
        )}
        <span className="text-sm font-medium text-charcoal-600">
          {uploading ? t('translate.uploading') : t('translate.dropHint')}
        </span>
        <span className="text-xs text-charcoal-400">{t('translate.pdfOnly')}</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {/* 任务列表 */}
      {loading ? (
        <div className="text-sm text-charcoal-400 py-6 text-center">{t('common.loading')}</div>
      ) : tasks.length === 0 ? (
        <div className="text-sm text-charcoal-400 py-6 text-center">{t('translate.noTasks')}</div>
      ) : (
        <ul className="space-y-2.5">
          {tasks
            .filter((task) => task.status !== 'QUOTED')
            .map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onRetry={() => handleRetry(task)}
                onDelete={() => setDeleteTarget(task)}
              />
            ))}
        </ul>
      )}

      {/* 报价确认弹窗 */}
      <ConfirmDialog
        open={quote !== null}
        title={t('translate.quoteTitle')}
        message={
          quote
            ? t('translate.quoteMessage', {
                file: quote.task.fileName,
                pages: quote.task.pageCount,
                price: yuan(quote.task.estimatedCents),
                balance: yuan(quote.balance),
              })
            : ''
        }
        confirmText={confirming ? t('common.loading') : t('translate.confirmStart')}
        loading={confirming}
        danger={false}
        onConfirm={handleConfirm}
        onCancel={handleCancelQuote}
      />

      {/* 删除/取消确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget && ACTIVE_STATUSES.has(deleteTarget.status)
            ? t('translate.cancelTitle')
            : t('translate.deleteTitle')
        }
        message={
          deleteTarget
            ? ACTIVE_STATUSES.has(deleteTarget.status)
              ? t('translate.cancelMessage', { file: deleteTarget.fileName })
              : t('translate.deleteMessage', { file: deleteTarget.fileName })
            : ''
        }
        confirmText={t('common.confirm')}
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

    </div>
  );
}

/** 任务行：状态徽章 + 进度条 + 操作（下载/预览/重试/删除） */
function TaskRow({
  task,
  onRetry,
  onDelete,
}: {
  task: DocTask;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const active = ACTIVE_STATUSES.has(task.status);

  const badge = () => {
    switch (task.status) {
      case 'COMPLETED':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-50 text-green-700">{t('translate.statusCompleted')}</span>;
      case 'FAILED':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-rust-50 text-rust-600">{t('translate.statusFailed')}</span>;
      case 'CANCELED':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-cream-100 text-charcoal-500">{t('translate.statusCanceled')}</span>;
      case 'TRANSLATING':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-600">{t('translate.statusTranslating')}</span>;
      default:
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-cream-100 text-charcoal-500">{t('translate.statusPending')}</span>;
    }
  };

  return (
    <li className="bg-white rounded-xl border border-cream-200 p-4 space-y-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <FileText className="w-4 h-4 text-charcoal-400 flex-shrink-0" />
        <span className="text-sm font-medium text-charcoal-700 truncate" title={task.fileName}>
          {task.fileName}
        </span>
        {badge()}
        <span className="ml-auto text-[11px] text-charcoal-400 tabular-nums flex-shrink-0">
          {task.pageCount} {t('translate.pages')} · {fmtBytes(task.fileBytes)}
          {task.chargedCents > 0 && !task.refunded && ` · ${yuan(task.chargedCents)}`}
          {task.refunded && ` · ${t('translate.refunded')}`}
        </span>
      </div>

      {active && (
        <div className="space-y-1">
          <div className="h-1 rounded-full bg-cream-100 overflow-hidden">
            <div
              className="h-full bg-rust-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.max(2, task.progress)}%` }}
            />
          </div>
          <div className="text-[11px] text-charcoal-400 tabular-nums">{task.progress}%</div>
        </div>
      )}

      {task.status === 'FAILED' && task.errorMessage && (
        <p className="text-xs text-rust-500">{task.errorMessage}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {task.status === 'COMPLETED' && (
          <>
            {task.hasMono && (
              <a
                href={`/api/translate/documents/${task.id}/download?variant=mono`}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-rust-500 rounded-lg hover:bg-rust-600 transition-colors"
              >
                <Download className="w-3 h-3" />
                {t('translate.downloadMono')}
              </a>
            )}
            {task.hasDual && (
              <>
                <a
                  href={`/api/translate/documents/${task.id}/download?variant=dual`}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-charcoal-700 bg-cream-100 rounded-lg hover:bg-cream-200 transition-colors"
                >
                  <Download className="w-3 h-3" />
                  {t('translate.downloadDual')}
                </a>
                <a
                  href={`/api/translate/documents/${task.id}/download?variant=dual&inline=1`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-charcoal-600 rounded-lg hover:bg-cream-100 transition-colors"
                >
                  <Eye className="w-3 h-3" />
                  {t('translate.preview')}
                </a>
              </>
            )}
          </>
        )}
        {(task.status === 'FAILED' || task.status === 'CANCELED') && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-charcoal-700 bg-cream-100 rounded-lg hover:bg-cream-200 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            {t('translate.retry')}
          </button>
        )}
        <button
          onClick={onDelete}
          className="ml-auto flex items-center gap-1 px-2.5 py-1.5 text-xs text-charcoal-400 rounded-lg hover:bg-cream-100 hover:text-rust-500 transition-colors"
        >
          {active ? <X className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
          {active ? t('common.cancel') : t('common.delete')}
        </button>
      </div>
    </li>
  );
}
