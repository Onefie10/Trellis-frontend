"use client";

import { useCallback } from "react";
import { Button } from "../../../components/Button";
import { EVENT_SEVERITIES, EVENT_SEVERITY_LABELS, type EventSeverity } from "../severity";
import { isQueryActive, type TimelineQuery } from "../filters";
import type { RedactionFinding } from "../redaction/redactor";

export interface TimelineFiltersProps {
  query: TimelineQuery;
  /** Raw `<input type="date">` values, kept separate from the parsed query. */
  fromInput: string;
  toInput: string;
  onChange: (next: { text?: string; from?: string; to?: string }) => void;
  onToggleSeverity: (severity: EventSeverity) => void;
  onReset: () => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  /** Rows remaining after filtering, and the total before filtering. */
  visibleCount: number;
  totalCount: number;
  /** Aggregated redaction findings for the currently visible rows. */
  findings: RedactionFinding[];
  redactedCount: number;
  /** Set while an export is being generated. */
  isExporting?: boolean;
}

/**
 * Search / date-range / severity controls plus the CSV + JSON export actions.
 *
 * Export buttons are disabled when the filtered set is empty so a user cannot
 * download a header-only file and assume their timeline was empty.
 */
export function TimelineFilters({
  query,
  fromInput,
  toInput,
  onChange,
  onToggleSeverity,
  onReset,
  onExportCsv,
  onExportJson,
  visibleCount,
  totalCount,
  findings,
  redactedCount,
  isExporting = false,
}: TimelineFiltersProps) {
  const handleText = useCallback(
    (value: string) => onChange({ text: value }),
    [onChange],
  );

  const active = isQueryActive(query);
  const nothingToExport = visibleCount === 0;

  return (
    <div className="space-y-4 rounded-lg border border-amber-100 bg-white p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[200px]">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Search
          </span>
          <input
            type="search"
            value={query.text ?? ""}
            onChange={(event) => handleText(event.target.value)}
            placeholder="Search titles, descriptions, resources…"
            aria-label="Search timeline"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>

        <label>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            From
          </span>
          <input
            type="date"
            value={fromInput}
            onChange={(event) => onChange({ from: event.target.value })}
            aria-label="From date"
            className="rounded border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>

        <label>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            To
          </span>
          <input
            type="date"
            value={toInput}
            onChange={(event) => onChange({ to: event.target.value })}
            aria-label="To date"
            className="rounded border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>
      </div>

      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Severity
        </legend>
        {EVENT_SEVERITIES.map((severity) => {
          const selected = (query.severities ?? []).includes(severity);
          return (
            <button
              key={severity}
              type="button"
              aria-pressed={selected}
              onClick={() => onToggleSeverity(severity)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                selected
                  ? "border-amber-500 bg-amber-100 text-amber-900"
                  : "border-gray-300 bg-white text-gray-600 hover:border-amber-400"
              }`}
            >
              {EVENT_SEVERITY_LABELS[severity]}
            </button>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3">
        <div className="text-xs text-gray-600">
          <p data-testid="timeline-counts">
            Showing <strong>{visibleCount}</strong> of <strong>{totalCount}</strong> event(s)
            {active ? " (filtered)" : ""}
          </p>
          {redactedCount > 0 ? (
            <p className="mt-1 text-amber-800" data-testid="redaction-summary">
              🔒 {redactedCount} sensitive value(s) redacted
              {findings.length > 0
                ? `: ${findings.map((finding) => `${finding.label} ×${finding.count}`).join(", ")}`
                : ""}
            </p>
          ) : (
            <p className="mt-1 text-gray-400">No sensitive data detected in these events.</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onReset} disabled={!active}>
            Reset
          </Button>
          <Button onClick={onExportCsv} disabled={nothingToExport || isExporting}>
            Export CSV
          </Button>
          <Button onClick={onExportJson} disabled={nothingToExport || isExporting}>
            Export JSON
          </Button>
        </div>
      </div>
    </div>
  );
}

export default TimelineFilters;
