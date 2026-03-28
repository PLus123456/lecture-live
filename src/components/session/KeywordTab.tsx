'use client';

import { useState, useCallback } from 'react';
import { useKeywords } from '@/hooks/useKeywords';
import {
  Tag,
  Plus,
  X,
  Upload,
  Loader2,
  Zap,
} from 'lucide-react';

export default function KeywordTab({
  onInjectKeywords,
}: {
  onInjectKeywords?: (keywords: string[]) => Promise<void> | void;
}) {
  const {
    keywords,
    isExtracting,
    addManualKeyword,
    getActiveKeywords,
    removeKeyword,
    toggleKeyword,
    extractFromFile,
  } = useKeywords();

  const [manualInput, setManualInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [isInjecting, setIsInjecting] = useState(false);

  const handleInject = useCallback(async () => {
    if (!onInjectKeywords) return;

    const activeKeywords = getActiveKeywords();
    if (activeKeywords.length === 0) {
      return;
    }

    setIsInjecting(true);
    try {
      await onInjectKeywords(activeKeywords);
    } catch (error) {
      console.error('Keyword injection failed:', error);
    } finally {
      setIsInjecting(false);
    }
  }, [getActiveKeywords, onInjectKeywords]);

  const handleAddManual = () => {
    if (!manualInput.trim()) return;
    // 支持逗号分隔的多个关键词
    const words = manualInput
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
    words.forEach(addManualKeyword);
    setManualInput('');
  };

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) await extractFromFile(file);
    },
    [extractFromFile]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) await extractFromFile(file);
    },
    [extractFromFile]
  );

  const sourceIcon = (source: string) => {
    if (source === 'manual') return '🏷';
    if (source === 'llm') return '🤖';
    return '📄';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Manual input */}
      <div className="px-4 py-3 border-b border-cream-100">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddManual()}
            placeholder="Add keywords (comma-separated)"
            className="flex-1 px-3 py-1.5 rounded-lg border border-cream-300 text-xs
                       focus:outline-none focus:ring-1 focus:ring-rust-400"
          />
          <button
            onClick={handleAddManual}
            className="p-1.5 rounded-lg bg-rust-500 text-white hover:bg-rust-600"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* File upload area */}
      <div
        className={`mx-4 mt-3 border-2 border-dashed rounded-lg p-4 text-center transition-colors
          ${dragOver ? 'border-rust-400 bg-rust-50' : 'border-cream-300 hover:border-cream-400'}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleFileDrop}
      >
        {isExtracting ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 text-rust-500 animate-spin" />
            <span className="text-xs text-rust-600">Extracting keywords...</span>
          </div>
        ) : (
          <>
            <Upload className="w-5 h-5 mx-auto mb-1.5 text-charcoal-300" />
            <p className="text-[11px] text-charcoal-400">
              Drop PPT/Word/PDF/TXT here
            </p>
            <label className="text-[11px] text-rust-500 cursor-pointer hover:underline">
              or browse
              <input
                type="file"
                className="hidden"
                accept=".pdf,.docx,.pptx,.txt"
                onChange={handleFileSelect}
              />
            </label>
          </>
        )}
      </div>

      {/* Keyword list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {keywords.length === 0 ? (
          <div className="text-center py-6 text-charcoal-300">
            <Tag className="w-6 h-6 mx-auto mb-2 opacity-50" />
            <p className="text-[11px]">No keywords yet</p>
            <p className="text-[10px] mt-1">
              Add manually or upload a file to extract
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {keywords.map((kw) => (
              <span
                key={kw.text}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border cursor-pointer
                  ${
                    kw.active
                      ? 'bg-rust-50 text-rust-700 border-rust-200'
                      : 'bg-cream-50 text-charcoal-400 border-cream-200 line-through'
                  }`}
                onClick={() => toggleKeyword(kw.text)}
              >
                <span>{sourceIcon(kw.source)}</span>
                {kw.text}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeKeyword(kw.text);
                  }}
                  className="ml-0.5 hover:text-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Inject button */}
      {keywords.filter((k) => k.active).length > 0 && (
        <div className="px-4 py-3 border-t border-cream-100">
          <button
            onClick={handleInject}
            disabled={!onInjectKeywords || isInjecting}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                             bg-charcoal-800 text-white text-xs hover:bg-charcoal-700 transition-colors
                             disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isInjecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            {isInjecting
              ? 'Updating ASR context...'
              : `Inject ${keywords.filter((k) => k.active).length} keywords into ASR`}
          </button>
        </div>
      )}
    </div>
  );
}
