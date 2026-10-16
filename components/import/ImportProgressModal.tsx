"use client";

import { useRef, useState } from 'react';

export interface ImportProgress { processed: number; total: number; current_item?: string; errors: number; }

export interface ImportRowPreview {
  rowNumber: number;
  raw: string;
  status: 'accepted' | 'quarantined';
  reason?: string;
}

export interface ImportPreview {
  rows: ImportRowPreview[];
  accepted: number;
  quarantined: number;
}

export interface ImportRollbackInfo {
  importId?: string;
  acceptedRows: number;
  quarantinedRows: number;
  retryable: boolean;
  guidance: string;
}

const MAX_PREVIEW_ROWS = 500;
const MAX_ROW_LENGTH = 4096;

function parseCsvRows(payload: string): string[] {
  const normalized = payload.replace(/\r\n?/g, '\n');
  return normalized.split('\n').filter((line) => line.trim().length > 0);
}

function validateRow(raw: string, index: number): ImportRowPreview {
  const rowNumber = index + 1;
  if (raw.length > MAX_ROW_LENGTH) {
    return { rowNumber, raw, status: 'quarantined', reason: 'Row exceeds maximum length' };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) {
    return { rowNumber, raw, status: 'quarantined', reason: 'Row contains control characters' };
  }
  const columns = raw.split(',');
  if (columns.some((column) => column.trim().length === 0)) {
    return { rowNumber, raw, status: 'quarantined', reason: 'Row contains empty required column' };
  }
  return { rowNumber, raw, status: 'accepted' };
}

export function buildImportPreview(payload: string): ImportPreview {
  const rows = parseCsvRows(payload).slice(0, MAX_PREVIEW_ROWS).map(validateRow);
  const accepted = rows.filter((row) => row.status === 'accepted').length;
  const quarantined = rows.length - accepted;
  return { rows, accepted, quarantined };
}

export default function ImportProgressModal({ open, payload, onComplete }: { open: boolean; payload: string; onComplete?: (result: unknown) => void }) {
  const [progress, setProgress] = useState<ImportProgress>({ processed: 0, total: 0, errors: 0 });
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'cancelled' | 'error'>('idle');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rollback, setRollback] = useState<ImportRollbackInfo | null>(null);
  const controller = useRef<AbortController | null>(null);

  async function start() {
    controller.current = new AbortController(); setStatus('running');
    setRollback(null);
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

  function handlePreview() {
    setPreview(buildImportPreview(payload));
    setStatus('idle');
  }

  function handleRollback() {
    setRollback({
      acceptedRows: preview?.accepted ?? progress.processed,
      quarantinedRows: preview?.quarantined ?? progress.errors,
      retryable: status !== 'running',
      guidance: 'To roll back, re-run the import with the original payload after fixing quarantined rows. Retry is safe because accepted rows are idempotent by row hash.',
    });
  }

  if (!open) return null;
  const percentage = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;
  return (
    <div role="dialog" aria-modal="true" aria-label="Import progress" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 text-gray-900 shadow-xl">
        <h2>Importing records</h2>
        <p className="mt-2 text-sm text-gray-600">{status === 'idle' ? 'Ready to import.' : `${percentage}% complete`}</p>
        <progress className="mt-4 w-full" max="100" value={percentage} />
        {progress.current_item && <p className="mt-2 truncate text-xs text-gray-500">{progress.current_item}</p>}
        {preview && (
          <div className="mt-4 rounded border p-3 text-xs">
            <p className="font-medium">Preview: {preview.accepted} accepted, {preview.quarantined} quarantined</p>
            <ul className="mt-2 max-h-32 overflow-auto">
              {preview.rows.filter((row) => row.status === 'quarantined').map((row) => (
                <li key={row.rowNumber} className="text-red-600">Row {row.rowNumber}: {row.reason}</li>
              ))}
            </ul>
          </div>
        )}
        {rollback && (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-medium">Rollback guidance</p>
            <p className="mt-1">{rollback.guidance}</p>
            <p className="mt-1">Accepted: {rollback.acceptedRows} · Quarantined: {rollback.quarantinedRows} · Retryable: {rollback.retryable ? 'yes' : 'no'}</p>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={handlePreview} disabled={status === 'running'} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Preview</button>
          <button type="button" onClick={start} disabled={status === 'running'} className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50">{status === 'complete' ? 'Imported' : 'Start import'}</button>
          <button type="button" onClick={() => { controller.current?.abort(); setStatus('cancelled'); }} disabled={status !== 'running'} className="rounded border px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={handleRollback} disabled={status === 'running'} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Rollback guidance</button>
        </div>
      </div>
    </div>
  );
}
