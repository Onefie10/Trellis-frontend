import React, { useMemo } from 'react';
import { compareText } from '../lib/diff-utils';
import { useState, useCallback } from 'react';

interface Change {
  value: string;
  added?: boolean;
  removed?: boolean;
}

interface BackfillPreview {
  added: number;
  removed: number;
  unchanged: number;
}

interface Checkpoint {
  offset: number;
  total: number;
}

interface SkippedRecord {
  id: string;
  reason: string;
}

interface FailedRecord {
  id: string;
  error: string;
}

interface UseBackfillPreviewOptions {
  storageKey: string;
  oldContent: string;
  newContent: string;
}

const useBackfillPreview = ({
  storageKey,
  oldContent,
  newContent,
}: UseBackfillPreviewOptions) => {
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as Checkpoint) : null;
    } catch {
      return null;
    }
  });

  const preview = useMemo<BackfillPreview>(() => {
    const parts = compareText(oldContent, newContent);
    let added = 0;
    let removed = 0;
    let unchanged = 0;
    for (const part of parts) {
      const lines = part.value.split('\n').filter((l) => l.length > 0).length;
      if (part.added) added += lines;
      else if (part.removed) removed += lines;
      else unchanged += lines;
    }
    return { added, removed, unchanged };
  }, [oldContent, newContent]);

  const skipped = useMemo<SkippedRecord[]>(() => [], []);
  const failed = useMemo<FailedRecord[]>(() => [], []);

  const resume = useCallback(() => {
    if (typeof window === 'undefined') return;
    const next: Checkpoint = {
      offset: checkpoint ? checkpoint.offset : 0,
      total: preview.added + preview.removed + preview.unchanged,
    };
    setCheckpoint(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // ignore storage failures
    }
  }, [checkpoint, preview, storageKey]);

  const reset = useCallback(() => {
    setCheckpoint(null);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore storage failures
    }
  }, [storageKey]);

  return {
    preview,
    checkpoint,
    skipped,
    failed,
    resume,
    reset,
    isDryRun: true,
  };
};

interface VisualDiffViewerProps {
  oldContent: string;
  newContent: string;
  title?: string;
}

const CHECKPOINT_STORAGE_KEY = 'trellis:backfill:checkpoint';

export const VisualDiffViewer: React.FC<VisualDiffViewerProps> = ({ 
  oldContent, 
  newContent,
  title = "Visual Diff"
}) => {
  const changes = useMemo(() => {
    return compareText(oldContent, newContent);
  }, [oldContent, newContent]);

  const {
    preview,
    checkpoint,
    skipped,
    failed,
    resume,
    reset,
    isDryRun,
  } = useBackfillPreview({
    storageKey: CHECKPOINT_STORAGE_KEY,
    oldContent,
    newContent,
  });

  const summary = useMemo(() => {
    if (!preview) return null;
    return {
      added: preview.added,
      removed: preview.removed,
      unchanged: preview.unchanged,
      skipped: skipped.length,
      failed: failed.length,
    };
  }, [preview, skipped, failed]);

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 shadow-lg text-white mb-6">
      <h3 className="text-xl font-semibold text-slate-200 mb-4">{title}</h3>
      
      <div
        role="region"
        aria-label="Backfill operator controls"
        className="mb-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-300"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-slate-200">
            {isDryRun ? 'Dry run' : 'Apply mode'}
          </span>
          {summary && (
            <span data-testid="backfill-summary">
              +{summary.added} / -{summary.removed} / ={summary.unchanged}
            </span>
          )}
          {checkpoint && (
            <span data-testid="backfill-checkpoint">
              checkpoint: {checkpoint.offset}/{checkpoint.total}
            </span>
          )}
          {skipped.length > 0 && (
            <span data-testid="backfill-skipped" className="text-amber-400">
              skipped: {skipped.length}
            </span>
          )}
          {failed.length > 0 && (
            <span data-testid="backfill-failed" className="text-red-400">
              failed: {failed.length}
            </span>
          )}
          <button
            type="button"
            onClick={resume}
            className="rounded border border-slate-600 px-2 py-1 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded border border-slate-600 px-2 py-1 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Reset checkpoint
          </button>
        </div>
      </div>

      <div className="flex w-full bg-[#090b14] rounded-lg border border-slate-800 font-mono text-sm overflow-hidden">
        {/* Left Side (Old) */}
        <div className="w-1/2 border-r border-slate-700">
          <div className="bg-slate-800 text-slate-400 py-1 px-4 text-xs font-semibold border-b border-slate-700">Old Version</div>
          <div className="flex flex-col">
            {changes.map((part: Change, index: number) => {
              if (part.added) return null; // Skip added on the left
              
              const colorClass = part.removed ? 'bg-red-900/20 text-red-400' : 'text-slate-400';
              const prefix = part.removed ? '- ' : '  ';
              const lines = part.value.split('\n');
              if (lines[lines.length - 1] === '') lines.pop();

              return (
                <div key={index} className={colorClass}>
                  {lines.map((line: string, i: number) => (
                    <div key={i} className="flex px-4 py-1 border-b border-slate-800/30">
                      <span className="opacity-50 select-none mr-4 w-4 text-center shrink-0">{prefix}</span>
                      <span className="whitespace-pre-wrap break-all">{line}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Side (New) */}
        <div className="w-1/2">
          <div className="bg-slate-800 text-slate-400 py-1 px-4 text-xs font-semibold border-b border-slate-700">New Version</div>
          <div className="flex flex-col">
            {changes.map((part: Change, index: number) => {
              if (part.removed) return null; // Skip removed on the right
              
              const colorClass = part.added ? 'bg-green-900/20 text-green-400' : 'text-slate-400';
              const prefix = part.added ? '+ ' : '  ';
              const lines = part.value.split('\n');
              if (lines[lines.length - 1] === '') lines.pop();

              return (
                <div key={index} className={colorClass}>
                  {lines.map((line: string, i: number) => (
                    <div key={i} className="flex px-4 py-1 border-b border-slate-800/30">
                      <span className="opacity-50 select-none mr-4 w-4 text-center shrink-0">{prefix}</span>
                      <span className="whitespace-pre-wrap break-all">{line}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
