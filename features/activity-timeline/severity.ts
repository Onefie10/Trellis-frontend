/**
 * Event severity.
 *
 * The timeline model has no explicit severity field, but the UI needs one to
 * offer "filter by severity". It is derived from the event type, and an explicit
 * `metadata.severity` always wins so the backend can override the default
 * classification without a schema change.
 */

import type { TimelineEvent, TimelineEventType } from "./types";

export type EventSeverity = "info" | "success" | "warning" | "error";

/** Every severity, ordered from least to most urgent. */
export const EVENT_SEVERITIES: readonly EventSeverity[] = [
  "info",
  "success",
  "warning",
  "error",
] as const;

export const EVENT_SEVERITY_LABELS: Record<EventSeverity, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  error: "Error",
};

/** Default classification per event type. */
export const EVENT_SEVERITY: Record<TimelineEventType, EventSeverity> = {
  claim_created: "info",
  claim_settled: "success",
  claim_rejected: "error",
  referral_earned: "success",
  payout_requested: "warning",
  payout_completed: "success",
  wallet_connected: "info",
  profile_updated: "info",
  verification_completed: "success",
};

export function isEventSeverity(value: unknown): value is EventSeverity {
  return (
    typeof value === "string" && (EVENT_SEVERITIES as readonly string[]).includes(value)
  );
}

/** Resolve an event's severity: explicit metadata first, then the type default. */
export function eventSeverity(event: TimelineEvent): EventSeverity {
  const override = event.metadata?.severity;
  if (isEventSeverity(override)) return override;
  return EVENT_SEVERITY[event.type] ?? "info";
}

/** Tailwind classes for a severity pill. */
export const SEVERITY_STYLES: Record<EventSeverity, string> = {
  info: "text-sky-700 bg-sky-50 border-sky-200",
  success: "text-emerald-700 bg-emerald-50 border-emerald-200",
  warning: "text-amber-800 bg-amber-50 border-amber-200",
  error: "text-rose-700 bg-rose-50 border-rose-200",
};
