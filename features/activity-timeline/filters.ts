/**
 * Search, date-range and severity filtering for the activity timeline.
 *
 * Filtering runs on **redacted** events so a search for a raw IP address or a
 * token cannot be used as an oracle to confirm that such a value was present in
 * the original payload.
 */

import type { TimelineEvent, TimelineEventType } from "./types";
import { EVENT_SEVERITIES, eventSeverity, isEventSeverity, type EventSeverity } from "./severity";

export interface TimelineQuery {
  /** Free-text search across title, description and resource id. */
  text?: string;
  /** Inclusive lower bound, epoch milliseconds. */
  from?: number | null;
  /** Inclusive upper bound, epoch milliseconds. */
  to?: number | null;
  /** Restrict to these severities; empty/undefined means "any". */
  severities?: EventSeverity[];
  /** Restrict to these event types; empty/undefined means "any". */
  types?: TimelineEventType[];
}

export const EMPTY_TIMELINE_QUERY: TimelineQuery = {
  text: "",
  from: null,
  to: null,
  severities: [],
  types: [],
};

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * `true` when every populated part of the query matches the event.
 *
 * An event with no `title`/`description` is still searchable by `resourceId` so
 * "find the claim I acted on" works even for sparse records.
 */
export function matchesQuery(event: TimelineEvent, query: TimelineQuery): boolean {
  const needle = normalize(query.text ?? "");
  if (needle.length > 0) {
    const haystack = normalize(
      [event.title, event.description, event.resourceId, event.resourceType]
        .filter((value): value is string => typeof value === "string")
        .join(" "),
    );
    if (!haystack.includes(needle)) return false;
  }

  if (typeof query.from === "number" && event.timestamp < query.from) return false;
  if (typeof query.to === "number" && event.timestamp > query.to) return false;

  if (query.severities && query.severities.length > 0) {
    if (!query.severities.includes(eventSeverity(event))) return false;
  }

  if (query.types && query.types.length > 0) {
    if (!query.types.includes(event.type)) return false;
  }

  return true;
}

/** Filter a timeline, preserving the incoming order. */
export function filterTimelineEvents<T extends TimelineEvent>(
  events: T[],
  query: TimelineQuery,
): T[] {
  return events.filter((event) => matchesQuery(event, query));
}

/**
 * Parse a `<input type="date">` value (`YYYY-MM-DD`).
 *
 * `boundary` decides whether the returned instant is the start or the end of
 * that local day, so "to 2026-09-27" includes everything that happened on the
 * 27th rather than stopping at midnight.
 */
export function parseDateInput(
  value: string,
  boundary: "start" | "end" = "start",
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  if (boundary === "end") {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date.getTime();
}

/** Build a query from raw form input, ignoring blank/partial values. */
export function buildQueryFromInputs(inputs: {
  text?: string;
  from?: string;
  to?: string;
  severities?: string[];
  types?: string[];
}): TimelineQuery {
  return {
    text: inputs.text ?? "",
    from: inputs.from ? parseDateInput(inputs.from, "start") : null,
    to: inputs.to ? parseDateInput(inputs.to, "end") : null,
    severities: (inputs.severities ?? []).filter(isEventSeverity),
    types: (inputs.types ?? []) as TimelineEventType[],
  };
}

/** `true` when the query would narrow the timeline at all. */
export function isQueryActive(query: TimelineQuery): boolean {
  return (
    normalize(query.text ?? "").length > 0 ||
    typeof query.from === "number" ||
    typeof query.to === "number" ||
    (query.severities?.length ?? 0) > 0 ||
    (query.types?.length ?? 0) > 0
  );
}

/** All severities, re-exported so controls can iterate without importing twice. */
export { EVENT_SEVERITIES };
