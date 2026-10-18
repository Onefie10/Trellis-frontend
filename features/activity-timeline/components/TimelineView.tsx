"use client";

import { useCallback, useMemo, useState } from "react";
import { TimelineEvent, isEventVisible } from "../types";
import { TimelineEntry } from "./TimelineEntry";
import { TimelineFilters } from "./TimelineFilters";
import { Button } from "../../../components/Button";
import { redactTimelineEvents, type RedactionFinding } from "../redaction/redactor";
import {
  buildTimelineExport,
  downloadTimelineExport,
  exportSummary,
} from "../redaction/exporter";
import {
  buildQueryFromInputs,
  filterTimelineEvents,
  EMPTY_TIMELINE_QUERY,
  type TimelineQuery,
} from "../filters";
import { eventSeverity, type EventSeverity } from "../severity";

interface TimelineViewProps {
  events: TimelineEvent[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoading?: boolean;
  forPublicView?: boolean;
}

/**
 * Renders a filtered timeline view with pagination.
 *
 * Pipeline: visibility rules → PII redaction → search/date/severity filters →
 * newest-first sort. Redaction runs *before* filtering so the search box can
 * never be used to probe for a secret that was removed.
 */
export function TimelineView({
  events,
  onLoadMore,
  hasMore = false,
  isLoading = false,
  forPublicView = false,
}: TimelineViewProps) {
  const [query, setQuery] = useState<TimelineQuery>(EMPTY_TIMELINE_QUERY);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const visibleEvents = useMemo(() => {
    return events.filter((e) => isEventVisible(e, forPublicView));
  }, [events, forPublicView]);

  const { value: redactedEvents, findings, redactedCount } = useMemo(
    () => redactTimelineEvents(visibleEvents),
    [visibleEvents],
  );

  const filteredEvents = useMemo(
    () => filterTimelineEvents(redactedEvents, query),
    [redactedEvents, query],
  );

  const sortedEvents = useMemo(() => {
    return [...filteredEvents].sort((a, b) => b.timestamp - a.timestamp);
  }, [filteredEvents]);

  const handleLoadMore = useCallback(() => {
    onLoadMore?.();
  }, [onLoadMore]);

  const handleFilterChange = useCallback(
    (next: { text?: string; from?: string; to?: string }) => {
      setExportMessage(null);
      if (next.from !== undefined) setFromInput(next.from);
      if (next.to !== undefined) setToInput(next.to);
      setQuery((current) => {
        const text = next.text !== undefined ? next.text : (current.text ?? "");
        const from = next.from !== undefined ? next.from : fromInput;
        const to = next.to !== undefined ? next.to : toInput;
        return buildQueryFromInputs({
          text,
          from,
          to,
          severities: current.severities,
          types: current.types,
        });
      });
    },
    [fromInput, toInput],
  );

  const handleToggleSeverity = useCallback((severity: EventSeverity) => {
    setExportMessage(null);
    setQuery((current) => {
      const selected = current.severities ?? [];
      const next = selected.includes(severity)
        ? selected.filter((entry) => entry !== severity)
        : [...selected, severity];
      return { ...current, severities: next };
    });
  }, []);

  const handleReset = useCallback(() => {
    setQuery(EMPTY_TIMELINE_QUERY);
    setFromInput("");
    setToInput("");
    setExportMessage(null);
  }, []);

  const runExport = useCallback(
    (format: "csv" | "json") => {
      const exported = buildTimelineExport(sortedEvents, format, { redactedCount });
      downloadTimelineExport(exported);
      setExportMessage(exportSummary(exported));
    },
    [sortedEvents, redactedCount],
  );

  const handleExportCsv = useCallback(() => runExport("csv"), [runExport]);
  const handleExportJson = useCallback(() => runExport("json"), [runExport]);

  const visibleFindings: RedactionFinding[] = useMemo(() => {
    const totals = new Map<string, RedactionFinding>();
    for (const event of sortedEvents) {
      for (const finding of event.redactionFindings ?? []) {
        const existing = totals.get(finding.id);
        if (existing) existing.count += finding.count;
        else totals.set(finding.id, { ...finding });
      }
    }
    return [...totals.values()].sort((a, b) => b.count - a.count);
  }, [sortedEvents]);

  const visibleRedactedCount = useMemo(
    () => sortedEvents.reduce((sum, event) => sum + (event.redactionCount ?? 0), 0),
    [sortedEvents],
  );

  const filters = (
    <TimelineFilters
      query={query}
      fromInput={fromInput}
      toInput={toInput}
      onChange={handleFilterChange}
      onToggleSeverity={handleToggleSeverity}
      onReset={handleReset}
      onExportCsv={handleExportCsv}
      onExportJson={handleExportJson}
      visibleCount={sortedEvents.length}
      totalCount={visibleEvents.length}
      findings={visibleFindings.length > 0 ? visibleFindings : findings}
      redactedCount={visibleRedactedCount || redactedCount}
    />
  );

  return (
    <div className="space-y-6">
      {filters}

      {exportMessage && (
        <p
          role="status"
          data-testid="export-confirmation"
          className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {exportMessage}
        </p>
      )}

      {sortedEvents.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
          <p className="text-gray-600">
            {visibleEvents.length === 0 ? "No activity yet" : "No events match your filters"}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sortedEvents.map((event) => (
            <TimelineEntry
              key={event.id}
              event={event}
              severity={eventSeverity(event)}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center pt-4">
          <Button onClick={handleLoadMore} disabled={isLoading}>
            {isLoading ? "Loading..." : "Load More"}
          </Button>
        </div>
      )}
    </div>
  );
}

export default TimelineView;
