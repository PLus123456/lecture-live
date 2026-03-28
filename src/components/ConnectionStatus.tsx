'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import type { ConnectionState } from '@/types/transcript';
import { Activity, Wifi, WifiOff, Loader2 } from 'lucide-react';
import FlagImg from './FlagImg';
import {
  pingAllRegions,
  setCachedPingResults,
  type ClientPingResult,
} from '@/lib/soniox/clientPing';

const REGION_LABELS: Record<string, string> = {
  us: 'US East (Virginia)',
  eu: 'EU West (Frankfurt)',
  jp: 'AP Northeast (Tokyo)',
};

function latencyColor(ms: number | null): string {
  if (ms == null) return 'text-charcoal-400';
  if (ms < 100) return 'text-emerald-600';
  if (ms < 200) return 'text-yellow-600';
  return 'text-red-500';
}

function latencyBg(ms: number | null): string {
  if (ms == null) return 'bg-charcoal-200';
  if (ms < 100) return 'bg-emerald-500';
  if (ms < 200) return 'bg-yellow-500';
  return 'bg-red-500';
}

function transcriptionLatencyColor(ms: number | null): string {
  if (ms == null) return 'text-charcoal-400';
  if (ms < 1500) return 'text-emerald-600';
  if (ms < 3000) return 'text-yellow-600';
  return 'text-red-500';
}

const stateConfig: Record<ConnectionState, { color: string; pulseColor: string; label: string }> = {
  disconnected: { color: 'bg-charcoal-300', pulseColor: '', label: 'Disconnected' },
  connecting:   { color: 'bg-yellow-400', pulseColor: 'bg-yellow-400', label: 'Connecting' },
  reconnecting: { color: 'bg-amber-500', pulseColor: 'bg-amber-500', label: 'Reconnecting' },
  connected:    { color: 'bg-emerald-500', pulseColor: '', label: 'Connected' },
  error:        { color: 'bg-red-500', pulseColor: '', label: 'Error' },
};

export default function ConnectionStatus() {
  const connectionState = useTranscriptStore((s) => s.connectionState);
  const connectionMeta = useTranscriptStore((s) => s.connectionMeta);

  const [showTooltip, setShowTooltip] = useState(false);
  const [pingResults, setPingResults] = useState<ClientPingResult[] | null>(null);
  const [pinging, setPinging] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const config = stateConfig[connectionState];
  const isConnected = connectionState === 'connected';
  const isActive = connectionState === 'connecting' || connectionState === 'reconnecting';

  // 客户端直接 ping Soniox 数据中心
  const runPing = useCallback(async () => {
    if (pinging) return;
    setPinging(true);
    try {
      const results = await pingAllRegions();
      setPingResults(results);
      // 同步到缓存，供自动选区使用
      setCachedPingResults(results);
    } catch { /* silent */ }
    setPinging(false);
  }, [pinging]);

  useEffect(() => {
    if (showTooltip && !pingResults) {
      void runPing();
    }
  }, [showTooltip, pingResults, runPing]);

  // 出字延迟显示
  const transcriptionLatency = connectionMeta.transcriptionLatencyMs;
  const hasTranscriptionLatency = isConnected && transcriptionLatency != null && transcriptionLatency > 0;

  // 连接延迟标签
  const latencyLabel = connectionMeta.latencyMs != null
    ? `${connectionMeta.latencyMs}ms`
    : null;

  const regionTag = connectionMeta.region?.toUpperCase() || null;

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Compact status badge */}
      <div
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
                   cursor-default select-none transition-colors
                   ${isConnected
                     ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                     : connectionState === 'error'
                       ? 'bg-red-50 text-red-600 border border-red-200'
                       : isActive
                         ? 'bg-yellow-50 text-yellow-700 border border-yellow-200'
                         : 'bg-cream-50 text-charcoal-500 border border-cream-300'
                   }`}
      >
        {/* Status dot with pulse */}
        <span className="relative flex h-2 w-2">
          {(isActive || (isConnected && connectionMeta.latencyMs != null)) && (
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 ${
              isActive ? config.pulseColor : 'bg-emerald-400'
            }`} />
          )}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${config.color}`} />
        </span>

        {/* Label */}
        {isConnected ? (
          <>
            {regionTag && (
              <span className="font-mono text-[10px] opacity-75">{regionTag}</span>
            )}
            {hasTranscriptionLatency ? (
              <span className={`font-mono text-[10px] ${transcriptionLatencyColor(transcriptionLatency)}`}>
                {transcriptionLatency < 1000
                  ? `${transcriptionLatency}ms`
                  : `${(transcriptionLatency / 1000).toFixed(1)}s`}
              </span>
            ) : latencyLabel ? (
              <span className={`font-mono text-[10px] ${latencyColor(connectionMeta.latencyMs)}`}>
                {latencyLabel}
              </span>
            ) : null}
          </>
        ) : (
          <span>{config.label}</span>
        )}
      </div>

      {/* Rich hover tooltip */}
      {showTooltip && (
        <div
          ref={tooltipRef}
          className="absolute top-full mt-2 right-0 w-72 z-50
                     bg-white border border-cream-200 rounded-xl shadow-2xl
                     overflow-hidden animate-fade-in-scale"
        >
          {/* Header */}
          <div className={`px-4 py-3 ${
            isConnected ? 'bg-emerald-50' : connectionState === 'error' ? 'bg-red-50' : 'bg-cream-50'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <Wifi className="w-4 h-4 text-emerald-600" />
                ) : connectionState === 'error' ? (
                  <WifiOff className="w-4 h-4 text-red-500" />
                ) : (
                  <Activity className="w-4 h-4 text-charcoal-400" />
                )}
                <span className="text-sm font-semibold text-charcoal-800">
                  {config.label}
                </span>
              </div>
              {isConnected && connectionMeta.latencyMs != null && (
                <span className={`text-sm font-mono font-bold ${latencyColor(connectionMeta.latencyMs)}`}>
                  {connectionMeta.latencyMs}ms
                </span>
              )}
            </div>

            {/* Current connection details */}
            {isConnected && connectionMeta.region && (
              <div className="mt-2 flex items-center gap-2 text-xs text-charcoal-600">
                <FlagImg code={connectionMeta.region} type="region" size={14} />
                <span>
                  {REGION_LABELS[connectionMeta.region] || connectionMeta.region}
                </span>
              </div>
            )}

            {/* 实时出字延迟 */}
            {hasTranscriptionLatency && (
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-charcoal-500">出字延迟</span>
                <span className={`font-mono font-bold ${transcriptionLatencyColor(transcriptionLatency)}`}>
                  {transcriptionLatency < 1000
                    ? `${transcriptionLatency}ms`
                    : `${(transcriptionLatency / 1000).toFixed(1)}s`}
                </span>
              </div>
            )}

            {connectionState === 'error' && (
              <p className="mt-2 text-[11px] text-red-600 leading-relaxed">
                Connection failed. Check your network, microphone permissions, or API key.
              </p>
            )}
          </div>

          {/* Ping results: all data centers (客户端直测) */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[10px] font-semibold text-charcoal-400 uppercase tracking-wider">
                浏览器到数据中心延迟
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); setPingResults(null); void runPing(); }}
                disabled={pinging}
                className="text-[10px] text-rust-500 hover:text-rust-600 font-medium disabled:opacity-40"
              >
                {pinging ? '测量中...' : '刷新'}
              </button>
            </div>

            {pinging && !pingResults ? (
              <div className="flex items-center justify-center gap-2 py-4 text-charcoal-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="text-xs">正在测量延迟...</span>
              </div>
            ) : (
              <div className="space-y-2">
                {(pingResults || []).map((r) => {
                  const isCurrent = connectionMeta.region === r.region && isConnected;
                  return (
                    <div
                      key={r.region}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs
                                 ${isCurrent
                                   ? 'bg-emerald-50 border border-emerald-200'
                                   : 'bg-cream-50 border border-cream-100'
                                 }`}
                    >
                      <div className="flex items-center gap-2">
                        <FlagImg code={r.region} type="region" size={18} />
                        <div>
                          <div className={`font-medium ${isCurrent ? 'text-emerald-700' : 'text-charcoal-700'}`}>
                            {r.region.toUpperCase()}
                            {isCurrent && (
                              <span className="ml-1.5 text-[9px] font-semibold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded-full">
                                ACTIVE
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-charcoal-400">{r.label}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {r.reachable && r.latencyMs != null ? (
                          <>
                            <div className="w-16 h-1.5 bg-cream-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${latencyBg(r.latencyMs)}`}
                                style={{ width: `${Math.min(100, (r.latencyMs / 500) * 100)}%` }}
                              />
                            </div>
                            <span className={`font-mono font-bold w-12 text-right ${latencyColor(r.latencyMs)}`}>
                              {r.latencyMs}ms
                            </span>
                          </>
                        ) : (
                          <span className="text-charcoal-300 text-[10px]">Unreachable</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          {isConnected && connectionMeta.connectedAt && (
            <div className="px-4 py-2 border-t border-cream-100 bg-cream-50/50">
              <span className="text-[10px] text-charcoal-400">
                Connected for {formatUptime(Date.now() - connectionMeta.connectedAt)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
