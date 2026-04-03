'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import {
  Database, UserCog, Brain, Radio,
  CheckCircle2, ChevronRight, ChevronLeft,
  Loader2, AlertCircle, Eye, EyeOff, Plus, Trash2,
} from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

interface SetupStatus {
  setupComplete: boolean;
  steps: {
    database: boolean;
    admin: boolean;
    llm: boolean;
    soniox: boolean;
  };
  error?: string;
}

interface LlmModelForm {
  modelId: string;
  displayName: string;
  purpose: string;
  isDefault: boolean;
  maxTokens: number;
  temperature: number;
}

interface LlmProviderForm {
  name: string;
  apiKey: string;
  apiBase: string;
  isAnthropic: boolean;
  models: LlmModelForm[];
}

interface SonioxRegionForm {
  apiKey: string;
  wsUrl: string;
  restUrl: string;
}

const STEPS = [
  { id: 'database', label: '数据库连接', icon: Database },
  { id: 'admin', label: '管理员账号', icon: UserCog },
  { id: 'llm', label: 'LLM 配置', icon: Brain },
  { id: 'soniox', label: '语音识别 API', icon: Radio },
] as const;

const DEFAULT_SONIOX_ENDPOINTS: Record<string, { wsUrl: string; restUrl: string }> = {
  us: { wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket', restUrl: 'https://api.soniox.com' },
  eu: { wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket', restUrl: 'https://api.eu.soniox.com' },
  jp: { wsUrl: 'wss://stt-rt.jp.soniox.com/transcribe-websocket', restUrl: 'https://api.jp.soniox.com' },
};

const EMPTY_STATUS: SetupStatus = {
  setupComplete: false,
  steps: {
    database: false,
    admin: false,
    llm: false,
    soniox: false,
  },
};

function normalizeSetupStatus(data: unknown): SetupStatus {
  if (!data || typeof data !== 'object') {
    return EMPTY_STATUS;
  }

  const candidate = data as Partial<SetupStatus>;
  const steps =
    candidate.steps && typeof candidate.steps === 'object'
      ? candidate.steps
      : EMPTY_STATUS.steps;

  return {
    setupComplete: candidate.setupComplete === true,
    steps: {
      database: steps.database === true,
      admin: steps.admin === true,
      llm: steps.llm === true,
      soniox: steps.soniox === true,
    },
    error: typeof candidate.error === 'string' ? candidate.error : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  主组件                                                             */
/* ------------------------------------------------------------------ */

export default function SetupPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [currentStep, setCurrentStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stepLoading, setStepLoading] = useState(false);

  // Admin 表单
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // LLM 表单
  const [llmProviders, setLlmProviders] = useState<LlmProviderForm[]>([{
    name: '',
    apiKey: '',
    apiBase: '',
    isAnthropic: false,
    models: [{
      modelId: '',
      displayName: '',
      purpose: 'CHAT',
      isDefault: true,
      maxTokens: 4096,
      temperature: 0.3,
    }],
  }]);

  // Soniox 表单
  const [sonioxRegions, setSonioxRegions] = useState<Record<string, SonioxRegionForm>>({
    us: { apiKey: '', ...DEFAULT_SONIOX_ENDPOINTS.us },
    eu: { apiKey: '', ...DEFAULT_SONIOX_ENDPOINTS.eu },
    jp: { apiKey: '', ...DEFAULT_SONIOX_ENDPOINTS.jp },
  });
  const [sonioxDefaultRegion, setSonioxDefaultRegion] = useState('us');

  // 检查设置状态
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/setup');
      const rawData = await res.json().catch(() => null);
      const data = normalizeSetupStatus(rawData);
      setStatus(data);

      if (!res.ok) {
        setError(data.error || '无法检查设置状态');
        return;
      }

      setError(data.error || '');

      // 如果已完成设置，跳转到首页
      if (data.setupComplete) {
        router.replace('/home');
        return;
      }

      // 自动跳转到第一个未完成的步骤
      const stepKeys = ['database', 'admin', 'llm', 'soniox'] as const;
      for (let i = 0; i < stepKeys.length; i++) {
        if (!data.steps[stepKeys[i]]) {
          setCurrentStep(i);
          break;
        }
      }
    } catch {
      setStatus(EMPTY_STATUS);
      setError('无法连接到服务器');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // 执行步骤
  const executeStep = async (stepData: Record<string, unknown>) => {
    setError('');
    setStepLoading(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(stepData),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '操作失败');
        return false;
      }
      if (
        stepData.step === 'admin' &&
        data.user &&
        typeof data.user === 'object' &&
        typeof data.token === 'string'
      ) {
        const user = data.user as {
          id: string;
          email: string;
          displayName: string;
          role: 'ADMIN' | 'PRO' | 'FREE';
        };
        setAuth(
          {
            ...user,
            createdAt: new Date().toISOString(),
          },
          data.token
        );
      }
      // 刷新状态
      await fetchStatus();
      return true;
    } catch {
      setError('请求失败，请检查网络连接');
      return false;
    } finally {
      setStepLoading(false);
    }
  };

  // Step 1: 数据库连接测试
  const handleDatabaseCheck = async () => {
    const success = await executeStep({ step: 'database' });
    if (success) setCurrentStep(1);
  };

  // Step 2: 创建管理员
  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    const success = await executeStep({
      step: 'admin',
      email: adminEmail,
      password: adminPassword,
      displayName: adminDisplayName,
    });
    if (success) setCurrentStep(2);
  };

  // Step 3: LLM 配置
  const handleConfigureLlm = async () => {
    // 过滤掉空的 provider
    const validProviders = llmProviders.filter(p => p.name && p.apiKey && p.apiBase);
    if (validProviders.length === 0) {
      setError('请至少配置一个 LLM 供应商');
      return;
    }
    const success = await executeStep({
      step: 'llm',
      providers: validProviders,
    });
    if (success) setCurrentStep(3);
  };

  // Step 4: Soniox 配置
  const handleConfigureSoniox = async () => {
    // 过滤掉没填 API Key 的区域
    const validRegions: Record<string, SonioxRegionForm> = {};
    for (const [region, config] of Object.entries(sonioxRegions)) {
      if (config.apiKey) {
        validRegions[region] = config;
      }
    }
    if (Object.keys(validRegions).length === 0) {
      setError('请至少配置一个区域的 API Key');
      return;
    }
    const success = await executeStep({
      step: 'soniox',
      regions: validRegions,
      defaultRegion: sonioxDefaultRegion,
    });
    if (success) {
      // 完成设置
      await executeStep({ step: 'complete' });
      router.replace('/home');
    }
  };

  // 跳过 Soniox（如果已有环境变量配置）
  const handleSkipSoniox = async () => {
    await executeStep({ step: 'complete' });
    router.replace('/home');
  };

  /* ------------------------------------------------------------------ */
  /*  LLM 表单操作                                                      */
  /* ------------------------------------------------------------------ */

  const addProvider = () => {
    setLlmProviders(prev => [...prev, {
      name: '',
      apiKey: '',
      apiBase: '',
      isAnthropic: false,
      models: [{
        modelId: '',
        displayName: '',
        purpose: 'CHAT',
        isDefault: true,
        maxTokens: 4096,
        temperature: 0.3,
      }],
    }]);
  };

  const removeProvider = (index: number) => {
    setLlmProviders(prev => prev.filter((_, i) => i !== index));
  };

  const updateProvider = (index: number, field: string, value: unknown) => {
    setLlmProviders(prev => prev.map((p, i) =>
      i === index ? { ...p, [field]: value } : p
    ));
  };

  const addModel = (providerIndex: number) => {
    setLlmProviders(prev => prev.map((p, i) =>
      i === providerIndex ? {
        ...p,
        models: [...p.models, {
          modelId: '',
          displayName: '',
          purpose: 'CHAT',
          isDefault: false,
          maxTokens: 4096,
          temperature: 0.3,
        }],
      } : p
    ));
  };

  const removeModel = (providerIndex: number, modelIndex: number) => {
    setLlmProviders(prev => prev.map((p, i) =>
      i === providerIndex ? {
        ...p,
        models: p.models.filter((_, j) => j !== modelIndex),
      } : p
    ));
  };

  const updateModel = (providerIndex: number, modelIndex: number, field: string, value: unknown) => {
    setLlmProviders(prev => prev.map((p, i) =>
      i === providerIndex ? {
        ...p,
        models: p.models.map((m, j) =>
          j === modelIndex ? { ...m, [field]: value } : m
        ),
      } : p
    ));
  };

  /* ------------------------------------------------------------------ */
  /*  渲染                                                               */
  /* ------------------------------------------------------------------ */

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-cream-50">
        <div className="flex items-center gap-2 text-charcoal-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">正在检查设置状态…</span>
        </div>
      </div>
    );
  }

  const isStepDone = (stepId: string) =>
    status?.steps?.[stepId as keyof SetupStatus['steps']] ?? false;

  return (
    <div className="min-h-[100dvh] bg-cream-50 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="mx-auto mb-4">
            <SiteLogo size="w-14 h-14" iconSize="w-7 h-7" className="rounded-2xl shadow-lg" />
          </div>
          <h1 className="font-serif text-3xl font-bold text-charcoal-800">
            LectureLive
          </h1>
          <p className="text-charcoal-400 mt-2">初始部署设置</p>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-1 mb-8">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            const done = isStepDone(step.id);
            const active = i === currentStep;
            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => {
                    // 允许点击已完成或当前步骤
                    if (done || i <= currentStep) setCurrentStep(i);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all
                    ${active
                      ? 'bg-rust-500 text-white shadow-sm'
                      : done
                        ? 'bg-green-100 text-green-700'
                        : 'bg-cream-100 text-charcoal-400'
                    }`}
                >
                  {done ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <Icon className="w-3.5 h-3.5" />
                  )}
                  <span className="hidden sm:inline">{step.label}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <ChevronRight className="w-4 h-4 text-charcoal-300 mx-0.5" />
                )}
              </div>
            );
          })}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <span className="text-sm text-red-600">{error}</span>
          </div>
        )}

        {/* 步骤内容 */}
        <div className="bg-white rounded-xl shadow-sm border border-cream-200 p-6">

          {/* ======== Step 0: 数据库连接 ======== */}
          {currentStep === 0 && (
            <div>
              <h2 className="text-lg font-semibold text-charcoal-800 mb-2 flex items-center gap-2">
                <Database className="w-5 h-5 text-rust-500" />
                数据库连接
              </h2>
              <p className="text-sm text-charcoal-500 mb-6">
                点击下方按钮测试数据库连接。请确保 MySQL 服务正在运行，且 <code className="px-1.5 py-0.5 bg-cream-100 rounded text-xs">DATABASE_URL</code> 环境变量已正确配置。
              </p>

              {isStepDone('database') ? (
                <div className="flex items-center gap-2 text-green-600 mb-4">
                  <CheckCircle2 className="w-5 h-5" />
                  <span className="text-sm font-medium">数据库连接正常</span>
                </div>
              ) : null}

              <div className="flex gap-3">
                <button
                  onClick={handleDatabaseCheck}
                  disabled={stepLoading}
                  className="px-4 py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                             hover:bg-rust-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {stepLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  测试连接
                </button>
                {isStepDone('database') && (
                  <button
                    onClick={() => setCurrentStep(1)}
                    className="px-4 py-2.5 bg-charcoal-100 text-charcoal-700 rounded-lg text-sm font-medium
                               hover:bg-charcoal-200 transition-colors flex items-center gap-1"
                  >
                    下一步 <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ======== Step 1: 管理员账号 ======== */}
          {currentStep === 1 && (
            <div>
              <h2 className="text-lg font-semibold text-charcoal-800 mb-2 flex items-center gap-2">
                <UserCog className="w-5 h-5 text-rust-500" />
                创建管理员账号
              </h2>
              <p className="text-sm text-charcoal-500 mb-6">
                创建一个拥有最高权限的管理员账号，用于管理系统设置和用户。
              </p>

              {isStepDone('admin') ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-sm font-medium">管理员账号已创建</span>
                  </div>
                  <button
                    onClick={() => setCurrentStep(2)}
                    className="px-4 py-2.5 bg-charcoal-100 text-charcoal-700 rounded-lg text-sm font-medium
                               hover:bg-charcoal-200 transition-colors flex items-center gap-1"
                  >
                    下一步 <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <form onSubmit={handleCreateAdmin} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-charcoal-600 mb-1">
                      显示名称
                    </label>
                    <input
                      type="text"
                      value={adminDisplayName}
                      onChange={e => setAdminDisplayName(e.target.value)}
                      placeholder="Admin"
                      required
                      className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                                 focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-charcoal-600 mb-1">
                      邮箱
                    </label>
                    <input
                      type="email"
                      value={adminEmail}
                      onChange={e => setAdminEmail(e.target.value)}
                      placeholder="admin@example.com"
                      required
                      className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                                 focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-charcoal-600 mb-1">
                      密码（至少 8 个字符）
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={adminPassword}
                        onChange={e => setAdminPassword(e.target.value)}
                        required
                        minLength={8}
                        className="w-full px-3 py-2 pr-10 rounded-lg border border-cream-300 text-sm
                                   focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(v => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-charcoal-400 hover:text-charcoal-600"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setCurrentStep(0)}
                      className="px-4 py-2.5 bg-cream-100 text-charcoal-600 rounded-lg text-sm font-medium
                                 hover:bg-cream-200 transition-colors flex items-center gap-1"
                    >
                      <ChevronLeft className="w-4 h-4" /> 上一步
                    </button>
                    <button
                      type="submit"
                      disabled={stepLoading}
                      className="flex-1 px-4 py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                                 hover:bg-rust-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                    >
                      {stepLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      创建管理员
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* ======== Step 2: LLM 配置 ======== */}
          {currentStep === 2 && (
            <div>
              <h2 className="text-lg font-semibold text-charcoal-800 mb-2 flex items-center gap-2">
                <Brain className="w-5 h-5 text-rust-500" />
                LLM 供应商配置
              </h2>
              <p className="text-sm text-charcoal-500 mb-6">
                配置 AI 大语言模型供应商。API Key 会加密后存储在数据库中。
                支持 OpenAI 兼容 API 和 Anthropic 原生 API。
              </p>

              {isStepDone('llm') ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-sm font-medium">LLM 供应商已配置</span>
                  </div>
                  <button
                    onClick={() => setCurrentStep(3)}
                    className="px-4 py-2.5 bg-charcoal-100 text-charcoal-700 rounded-lg text-sm font-medium
                               hover:bg-charcoal-200 transition-colors flex items-center gap-1"
                  >
                    下一步 <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {llmProviders.map((provider, pi) => (
                    <div key={pi} className="border border-cream-200 rounded-lg p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-charcoal-700">
                          供应商 {pi + 1}
                        </span>
                        {llmProviders.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeProvider(pi)}
                            className="text-red-400 hover:text-red-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-charcoal-500 mb-1">名称标识</label>
                          <input
                            type="text"
                            value={provider.name}
                            onChange={e => updateProvider(pi, 'name', e.target.value)}
                            placeholder="如: claude、gpt、deepseek"
                            className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                                       focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-charcoal-500 mb-1">API 地址</label>
                          <input
                            type="text"
                            value={provider.apiBase}
                            onChange={e => updateProvider(pi, 'apiBase', e.target.value)}
                            placeholder="https://api.openai.com/v1"
                            className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                                       focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs text-charcoal-500 mb-1">API Key</label>
                        <input
                          type="password"
                          value={provider.apiKey}
                          onChange={e => updateProvider(pi, 'apiKey', e.target.value)}
                          placeholder="sk-..."
                          className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm font-mono
                                     focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                        />
                      </div>

                      <label className="flex items-center gap-2 text-xs text-charcoal-600">
                        <input
                          type="checkbox"
                          checked={provider.isAnthropic}
                          onChange={e => updateProvider(pi, 'isAnthropic', e.target.checked)}
                          className="rounded border-cream-300 text-rust-500 focus:ring-rust-400"
                        />
                        使用 Anthropic 原生 API（非 OpenAI 兼容格式）
                      </label>

                      {/* 模型列表 */}
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-charcoal-600">模型配置</span>
                          <button
                            type="button"
                            onClick={() => addModel(pi)}
                            className="text-xs text-rust-500 hover:text-rust-600 flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> 添加模型
                          </button>
                        </div>

                        {provider.models.map((model, mi) => (
                          <div key={mi} className="bg-cream-50 rounded-lg p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-charcoal-400">模型 {mi + 1}</span>
                              {provider.models.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => removeModel(pi, mi)}
                                  className="text-red-400 hover:text-red-600"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-xs text-charcoal-400 mb-0.5">模型 ID</label>
                                <input
                                  type="text"
                                  value={model.modelId}
                                  onChange={e => updateModel(pi, mi, 'modelId', e.target.value)}
                                  placeholder="gpt-4o / claude-sonnet-4-6"
                                  className="w-full px-2 py-1.5 rounded border border-cream-200 text-xs
                                             focus:outline-none focus:ring-1 focus:ring-rust-400"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-charcoal-400 mb-0.5">显示名称</label>
                                <input
                                  type="text"
                                  value={model.displayName}
                                  onChange={e => updateModel(pi, mi, 'displayName', e.target.value)}
                                  placeholder="GPT-4o"
                                  className="w-full px-2 py-1.5 rounded border border-cream-200 text-xs
                                             focus:outline-none focus:ring-1 focus:ring-rust-400"
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <label className="block text-xs text-charcoal-400 mb-0.5">用途</label>
                                <select
                                  value={model.purpose}
                                  onChange={e => updateModel(pi, mi, 'purpose', e.target.value)}
                                  className="w-full px-2 py-1.5 rounded border border-cream-200 text-xs
                                             focus:outline-none focus:ring-1 focus:ring-rust-400 bg-white"
                                >
                                  <option value="CHAT">对话</option>
                                  <option value="REALTIME_SUMMARY">实时摘要</option>
                                  <option value="FINAL_SUMMARY">最终摘要</option>
                                  <option value="KEYWORD_EXTRACTION">关键词提取</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-charcoal-400 mb-0.5">Max Tokens</label>
                                <input
                                  type="number"
                                  value={model.maxTokens}
                                  onChange={e => updateModel(pi, mi, 'maxTokens', parseInt(e.target.value) || 4096)}
                                  className="w-full px-2 py-1.5 rounded border border-cream-200 text-xs
                                             focus:outline-none focus:ring-1 focus:ring-rust-400"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-charcoal-400 mb-0.5">Temperature</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  min="0"
                                  max="2"
                                  value={model.temperature}
                                  onChange={e => updateModel(pi, mi, 'temperature', parseFloat(e.target.value) || 0.3)}
                                  className="w-full px-2 py-1.5 rounded border border-cream-200 text-xs
                                             focus:outline-none focus:ring-1 focus:ring-rust-400"
                                />
                              </div>
                            </div>
                            <label className="flex items-center gap-1.5 text-xs text-charcoal-500">
                              <input
                                type="checkbox"
                                checked={model.isDefault}
                                onChange={e => updateModel(pi, mi, 'isDefault', e.target.checked)}
                                className="rounded border-cream-300 text-rust-500 focus:ring-rust-400"
                              />
                              设为该用途默认模型
                            </label>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addProvider}
                    className="w-full py-2 border-2 border-dashed border-cream-300 rounded-lg text-sm text-charcoal-400
                               hover:border-rust-300 hover:text-rust-500 transition-colors flex items-center justify-center gap-1"
                  >
                    <Plus className="w-4 h-4" /> 添加更多供应商
                  </button>

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setCurrentStep(1)}
                      className="px-4 py-2.5 bg-cream-100 text-charcoal-600 rounded-lg text-sm font-medium
                                 hover:bg-cream-200 transition-colors flex items-center gap-1"
                    >
                      <ChevronLeft className="w-4 h-4" /> 上一步
                    </button>
                    <button
                      onClick={handleConfigureLlm}
                      disabled={stepLoading}
                      className="flex-1 px-4 py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                                 hover:bg-rust-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                    >
                      {stepLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      保存 LLM 配置
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ======== Step 3: Soniox 语音识别 ======== */}
          {currentStep === 3 && (
            <div>
              <h2 className="text-lg font-semibold text-charcoal-800 mb-2 flex items-center gap-2">
                <Radio className="w-5 h-5 text-rust-500" />
                Soniox 语音识别 API
              </h2>
              <p className="text-sm text-charcoal-500 mb-6">
                配置 Soniox 各区域的 API Key。支持美国 (US)、欧洲 (EU)、日本 (JP) 三个区域。
                API Key 会加密后安全存储在数据库中。
              </p>

              {isStepDone('soniox') ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-sm font-medium">Soniox 已配置</span>
                  </div>
                  <button
                    onClick={handleSkipSoniox}
                    disabled={stepLoading}
                    className="px-4 py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                               hover:bg-rust-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                  >
                    {stepLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                    完成设置
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* 默认区域选择 */}
                  <div>
                    <label className="block text-xs font-medium text-charcoal-600 mb-1">默认区域</label>
                    <select
                      value={sonioxDefaultRegion}
                      onChange={e => setSonioxDefaultRegion(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm bg-white
                                 focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                    >
                      <option value="us">美国 (US)</option>
                      <option value="eu">欧洲 (EU)</option>
                      <option value="jp">日本 (JP)</option>
                    </select>
                  </div>

                  {/* 各区域配置 */}
                  {(['us', 'eu', 'jp'] as const).map(region => {
                    const regionLabels = { us: '美国 (US)', eu: '欧洲 (EU)', jp: '日本 (JP)' };
                    const config = sonioxRegions[region];
                    return (
                      <div key={region} className="border border-cream-200 rounded-lg p-4 space-y-3">
                        <span className="text-sm font-medium text-charcoal-700">
                          {regionLabels[region]}
                          {region === sonioxDefaultRegion && (
                            <span className="ml-2 px-1.5 py-0.5 bg-rust-100 text-rust-600 rounded text-xs">默认</span>
                          )}
                        </span>

                        <div>
                          <label className="block text-xs text-charcoal-500 mb-1">API Key</label>
                          <input
                            type="password"
                            value={config.apiKey}
                            onChange={e => setSonioxRegions(prev => ({
                              ...prev,
                              [region]: { ...prev[region], apiKey: e.target.value },
                            }))}
                            placeholder={`Soniox ${region.toUpperCase()} API Key（不需要可留空）`}
                            className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm font-mono
                                       focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-charcoal-500 mb-1">WebSocket URL</label>
                            <input
                              type="text"
                              value={config.wsUrl}
                              onChange={e => setSonioxRegions(prev => ({
                                ...prev,
                                [region]: { ...prev[region], wsUrl: e.target.value },
                              }))}
                              className="w-full px-3 py-2 rounded-lg border border-cream-300 text-xs
                                         focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-charcoal-500 mb-1">REST URL</label>
                            <input
                              type="text"
                              value={config.restUrl}
                              onChange={e => setSonioxRegions(prev => ({
                                ...prev,
                                [region]: { ...prev[region], restUrl: e.target.value },
                              }))}
                              className="w-full px-3 py-2 rounded-lg border border-cream-300 text-xs
                                         focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setCurrentStep(2)}
                      className="px-4 py-2.5 bg-cream-100 text-charcoal-600 rounded-lg text-sm font-medium
                                 hover:bg-cream-200 transition-colors flex items-center gap-1"
                    >
                      <ChevronLeft className="w-4 h-4" /> 上一步
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipSoniox}
                      className="px-4 py-2.5 bg-cream-100 text-charcoal-600 rounded-lg text-sm font-medium
                                 hover:bg-cream-200 transition-colors"
                    >
                      跳过（使用环境变量）
                    </button>
                    <button
                      onClick={handleConfigureSoniox}
                      disabled={stepLoading}
                      className="flex-1 px-4 py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                                 hover:bg-rust-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                    >
                      {stepLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      保存并完成设置
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <p className="text-center text-xs text-charcoal-400 mt-6">
          所有 API Key 均使用 AES-256-GCM 加密后存储在数据库中
        </p>
      </div>
    </div>
  );
}
