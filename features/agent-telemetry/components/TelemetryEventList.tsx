'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TelemetryEvent } from '@/lib/telemetry/types';
import { highlightTelemetryText } from '@/lib/telemetry/search';
import clsx from 'clsx';

const ROW_HEIGHT = 88;
const OVERSCAN = 6;
const VIEWPORT_HEIGHT = 640;

function severityClass(s: TelemetryEvent['severity']): string {
  switch (s) {
    case 'critical':
    case 'error':
      return 'text-red-300 border-red-500/30 bg-red-950/20';
    case 'warn':
      return 'text-amber-200 border-amber-500/30 bg-amber-950/20';
    case 'info':
      return 'text-cyan-200 border-trellis-amber/30 bg-cyan-950/10';
    default:
      return 'text-gray-400 border-gray-600/30 bg-gray-900/30';
  }
}

function Highlight({ text, pattern }: { text: string; pattern: RegExp | null }) {
  return (
    <>
      {highlightTelemetryText(text, pattern).map((part, index) =>
        typeof part === 'string' ? (
          <React.Fragment key={index}>{part}</React.Fragment>
        ) : (
          <mark key={index} className="rounded bg-yellow-300/80 text-gray-950 px-0.5">
            {part.match}
          </mark>
        )
      )}
    </>
  );
}

interface Props {
  events: TelemetryEvent[];
  searchPattern?: RegExp | null;
  activeEventId?: string | null;
  onDeleteEvent?: (id: string) => void;
}

export const TelemetryEventList = React.memo(
  ({ events, searchPattern = null, activeEventId = null, onDeleteEvent }: Props) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(VIEWPORT_HEIGHT);

    useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport || !activeEventId) return;
      const index = events.findIndex((event) => event.id === activeEventId);
      if (index < 0) return;
      const rowTop = index * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      if (rowTop < viewport.scrollTop || rowBottom > viewport.scrollTop + viewport.clientHeight) {
        viewport.scrollTop = Math.max(0, rowTop - ROW_HEIGHT);
      }
    }, [activeEventId, events]);

    const range = useMemo(() => {
      const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(
        events.length,
        Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
      );
      return { start, end };
    }, [events.length, scrollTop, viewportHeight]);

    if (events.length === 0) {
      return (
        <p className="text-gray-500 text-sm py-8 text-center border border-dashed border-trellis-vine/20 rounded-lg">
          No events match the current filters. Adjust filters or wait for live telemetry.
        </p>
      );
    }

    return (
      <div
        ref={viewportRef}
        role="region"
        aria-label="Telemetry event stream"
        className="h-[min(70vh,640px)] overflow-y-auto pr-1"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          setViewportHeight(event.currentTarget.clientHeight || VIEWPORT_HEIGHT);
        }}
      >
        <ul className="relative" style={{ height: events.length * ROW_HEIGHT }}>
          {events.slice(range.start, range.end).map((ev, offset) => {
            const index = range.start + offset;
            const details = [ev.payload?.code, ev.payload?.message, ev.payload?.state, ev.payload?.taskKind]
              .filter(Boolean)
              .join(' · ');
            return (
              <li
                key={ev.id}
                aria-current={ev.id === activeEventId ? 'true' : undefined}
                className={clsx(
                  'absolute left-0 right-1 rounded-lg border px-3 py-2 text-sm grid gap-1 sm:grid-cols-[auto_1fr_auto] sm:items-center overflow-hidden',
                  severityClass(ev.severity),
                  ev.id === activeEventId && 'ring-2 ring-yellow-300'
                )}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT - 8 }}
              >
                <span className="font-mono text-xs text-gray-400 whitespace-nowrap">
                  {new Date(ev.ts).toLocaleTimeString()}
                </span>
                <div className="min-w-0 overflow-hidden">
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 items-baseline">
                    <span className="font-medium text-white">
                      <Highlight text={ev.type.replace(/_/g, ' ')} pattern={searchPattern} />
                    </span>
                    <span className="text-xs text-gray-400 truncate">
                      <Highlight text={ev.agentRef} pattern={searchPattern} />
                    </span>
                    {ev.classification && (
                      <span
                        className={clsx(
                          'text-[10px] font-mono px-1 rounded border uppercase tracking-wider',
                          ev.classification === 'SENSITIVE'
                            ? 'border-red-500/50 text-red-300 bg-red-950/40'
                            : ev.classification === 'OPERATIONAL'
                              ? 'border-blue-500/40 text-blue-300 bg-blue-950/30'
                              : 'border-emerald-500/40 text-emerald-300 bg-emerald-950/30'
                        )}
                        title={`Retention Tier: ${ev.classification}`}
                      >
                        {ev.classification}
                      </span>
                    )}
                  </div>
                  {details && (
                    <p className="text-xs text-gray-300 mt-1 truncate" title={details}>
                      <Highlight text={details} pattern={searchPattern} />
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 justify-self-start sm:justify-self-end">
                  <span className="text-xs uppercase tracking-wide">
                    <Highlight text={ev.severity} pattern={searchPattern} />
                  </span>
                  {onDeleteEvent && (
                    <button
                      type="button"
                      onClick={() => onDeleteEvent(ev.id)}
                      className="text-[11px] text-gray-400 hover:text-red-300 px-1.5 py-0.5 rounded border border-gray-700 hover:border-red-500/40 transition-colors"
                      title="Testable manual deletion of this operational metadata record"
                      aria-label={`Delete event ${ev.id}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
);

TelemetryEventList.displayName = 'TelemetryEventList';
