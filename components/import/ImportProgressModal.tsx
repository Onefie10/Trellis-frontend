"use client";

import { useRef, useState } from 'react';
import useFocusTrap from '@/components/useFocusTrap';

export interface ImportProgress { processed: number; total: number; current_item?: string; errors: number; }

export default function ImportProgressModal({ open, payload, onComplete }: { open: boolean; payload: string; onComplete?: (result: unknown) => void }) {
  const [progress, setProgress] = useState<ImportProgress>({ processed: 0, total: 0, errors: 0 });
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'cancelled' | 'error'>('idle');
  const controller = useRef<AbortController | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>({ active: open });

  async function start() {
    controller.current = new AbortController(); setStatus('running');
    const response = await fetch('/api/import?stream=true', { method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'text/csv' }, body: payload, signal: controller.current.signal });
    if (!response.body) { setStatus('error'); return; }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += chunk.value;
      const events = buffer.split('\n\n'); buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim(); if (!data) continue;
        const parsed = JSON.parse(data); if (event.startsWith('event: progress')) setProgress(parsed); else if (event.startsWith('event: complete')) { setStatus('complete'); onComplete?.(parsed); } else if (event.startsWith('event: cancelled')) setStatus('cancelled'); else if (event.startsWith('event: error')) setStatus('error');
      }
    }
  }

  if (!open) return null;
  const percentage = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;
  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label="Import progress"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 text-gray-900 shadow-xl">
        <h2 className="text-lg font-semibold">Importing records</h2>
        <p className="mt-2 text-sm text-gray-600">
          {status === 'idle' ? 'Ready to import.' : `${percentage}% complete`}
        </p>
        <progress className="mt-4 w-full" max="100" value={percentage} />
        {progress.current_item && (
          <p className="mt-2 truncate text-xs text-gray-500">{progress.current_item}</p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={start}
            disabled={status === 'running'}
            className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {status === 'complete' ? 'Imported' : 'Start import'}
          </button>
          <button
            type="button"
            onClick={() => { controller.current?.abort(); setStatus('cancelled'); }}
            disabled={status !== 'running'}
            className="rounded border px-3 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
