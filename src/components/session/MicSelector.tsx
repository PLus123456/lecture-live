'use client';

import { useState, useEffect } from 'react';
import { normalizeMicrophoneDevices } from '@/lib/audio/audioCapture';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { Mic, ChevronDown } from 'lucide-react';

export default function MicSelector({
  onSwitch,
}: {
  onSwitch?: (deviceId: string) => void;
}) {
  const currentMicDeviceId = useTranscriptStore((s) => s.currentMicDeviceId);
  const availableMics = useTranscriptStore((s) => s.availableMics);
  const setAvailableMics = useTranscriptStore((s) => s.setAvailableMics);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then((devices) => {
        const mics = normalizeMicrophoneDevices(devices, {
          fallbackDeviceId: currentMicDeviceId,
        });
        setAvailableMics(mics);
      })
      .catch(() => {
        setAvailableMics(
          currentMicDeviceId
            ? normalizeMicrophoneDevices([], {
                fallbackDeviceId: currentMicDeviceId,
              })
            : []
        );
      });
  }, [currentMicDeviceId, setAvailableMics]);

  const currentLabel =
    availableMics.find((m) => m.deviceId === currentMicDeviceId)?.label ||
    'Select Microphone';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cream-300
                   hover:bg-cream-50 text-xs text-charcoal-600 transition-colors"
      >
        <Mic className="w-3.5 h-3.5" />
        <span className="max-w-[160px] truncate">{currentLabel}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-64 bg-white border border-cream-300
                        rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale">
          {availableMics.map((mic) => (
            <button
              key={mic.deviceId}
              onClick={() => {
                onSwitch?.(mic.deviceId);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-cream-50 transition-colors
                ${mic.deviceId === currentMicDeviceId ? 'text-rust-600 bg-rust-50' : 'text-charcoal-600'}`}
            >
              <div className="flex items-center gap-2">
                <Mic className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{mic.label || `Mic ${mic.deviceId.slice(0, 8)}`}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
