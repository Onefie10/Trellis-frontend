/**
 * CSV / JSON exporters for activity timelines.
 *
 * Two hardening rules matter more than the formatting itself:
 *
 * 1. **Formula injection.** A spreadsheet treats a cell starting with `=`, `+`,
 *    `-`, `@`, tab or carriage return as a formula. An event description is
 *    attacker-influenced text, so such cells are prefixed with an apostrophe
 *    before the value is quoted (the standard OWASP CSV-injection mitigation).
 * 2. **Redaction first.** Exporters accept only
 *    {@link import("./redactor").RedactedTimelineEvent}, so the file a user
 *    downloads contains exactly the scrubbed strings the UI displayed.
 */

import type { RedactedTimelineEvent, RedactionFinding } from "./redactor";
import { describeFindings } from "./redactor";
import { eventSeverity } from "../severity";

export type TimelineExportFormat = "csv" | "json";

export interface TimelineExport {
  format: TimelineExportFormat;
  filename: string;
  mimeType: string;
  contents: string;
  /** UTF-8 byte length, useful for showing the download size. */
  byteLength: number;
  rowCount: number;
  /** Total redacted values across the exported rows. */
  redactedCount: number;
  /** Aggregated findings so the UI can explain what was removed. */
  findings: RedactionFinding[];
}

/** Cells that a spreadsheet would evaluate as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Quote a single CSV cell per RFC 4180, neutralising formula injection. */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else {
    text = JSON.stringify(value) ?? "";
  }

  if (FORMULA_PREFIX.test(text)) text = `'${text}`;

  if (/["\r\n,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Build a CSV document from a header row and data rows. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  // Trailing newline keeps `git diff` and spreadsheet importers happy.
  return `${lines.join("\r\n")}\r\n`;
}

/** Column order shared by the CSV export and the JSON projection. */
export const TIMELINE_COLUMNS = [
  "id",
  "timestamp",
  "isoTimestamp",
  "type",
  "severity",
  "visibility",
  "title",
  "description",
  "resourceType",
  "resourceId",
  "resourceUrl",
  "redactionCount",
  "redactionFindings",
] as const;

export type TimelineColumn = (typeof TIMELINE_COLUMNS)[number];

/**
 * Severity for an exported row. Shares the classification used by the UI so a
 * filtered view and its export always agree.
 */
function severityOfEvent(event: RedactedTimelineEvent): string {
  return eventSeverity(event);
}

function findingsSummary(findings: RedactionFinding[]): string {
  return findings.map((finding) => `${finding.label}:${finding.count}`).join("|");
}

/** Flatten an event into the export column order. */
export function eventToRow(event: RedactedTimelineEvent): unknown[] {
  const timestamp = event.timestamp;
  return [
    event.id,
    timestamp,
    Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "",
    event.type,
    severityOfEvent(event),
    event.visibility,
    event.title,
    event.description,
    event.resourceType ?? "",
    event.resourceId ?? "",
    event.resourceUrl ?? "",
    event.redactionCount ?? 0,
    findingsSummary(event.redactionFindings ?? []),
  ];
}

/** Serialise redacted events to CSV. */
export function timelineToCsv(events: RedactedTimelineEvent[]): string {
  return toCsv([...TIMELINE_COLUMNS], events.map(eventToRow));
}

/** Serialise redacted events to pretty-printed JSON. */
export function timelineToJson(events: RedactedTimelineEvent[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: events.length,
      events: events.map((event) => ({
        ...event,
        severity: severityOfEvent(event),
      })),
    },
    null,
    2,
  );
}

/** `timeline-2026-09-27T05-30-00-000Z.csv` — filename-safe and sortable. */
export function exportFilename(format: TimelineExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `timeline-${stamp}.${format}`;
}

function aggregateFindings(events: RedactedTimelineEvent[]): RedactionFinding[] {
  const totals = new Map<string, RedactionFinding>();
  for (const event of events) {
    for (const finding of event.redactionFindings ?? []) {
      const existing = totals.get(finding.id);
      if (existing) existing.count += finding.count;
      else totals.set(finding.id, { ...finding });
    }
  }
  return [...totals.values()].sort((a, b) => b.count - a.count);
}

/**
 * Build a downloadable export.
 *
 * Only redacted events are accepted — passing a raw `TimelineEvent` is a
 * compile error, which is the point: an unredacted export cannot be created by
 * accident.
 */
export function buildTimelineExport(
  events: RedactedTimelineEvent[],
  format: TimelineExportFormat,
  options: { now?: Date; redactedCount?: number } = {},
): TimelineExport {
  const contents = format === "csv" ? timelineToCsv(events) : timelineToJson(events);
  const now = options.now ?? new Date();
  const redactedCount =
    options.redactedCount ??
    events.reduce((sum, event) => sum + (event.redactionCount ?? 0), 0);

  return {
    format,
    filename: exportFilename(format, now),
    mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
    contents,
    byteLength: typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(contents).length
      : contents.length,
    rowCount: events.length,
    redactedCount,
    findings: aggregateFindings(events),
  };
}

/** One-line confirmation shown after an export, naming what was scrubbed. */
export function exportSummary(exported: TimelineExport): string {
  const base = `Exported ${exported.rowCount} event(s) as ${exported.format.toUpperCase()}`;
  if (exported.redactedCount === 0) return `${base} — no sensitive data was present.`;
  return `${base} with ${exported.redactedCount} value(s) redacted (${describeFindings(exported.findings)}).`;
}

/** Trigger a browser download. Safe to call from an `onClick` handler. */
export function downloadTimelineExport(exported: TimelineExport): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([exported.contents], { type: exported.mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exported.filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
