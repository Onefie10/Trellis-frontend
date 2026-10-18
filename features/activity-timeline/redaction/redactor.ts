/**
 * Deep PII redaction for activity-timeline events.
 *
 * Redaction happens **before** data reaches the DOM or an export file, so the
 * same sanitized value is what a user reads and what they download — there is no
 * path where the raw event is rendered and only the export is scrubbed, or vice
 * versa.
 *
 * Two independent layers run:
 *
 * 1. **Structural** — object keys that name a credential (`password`, `token`,
 *    `authorization`, `clientIp`, `stack`, …) have their whole value replaced,
 *    whatever it contains. This catches a raw IP sitting in `clientIp` even if it
 *    were formatted in a way the address regex does not recognise.
 * 2. **Pattern** — every remaining string is scanned by
 *    {@link import("./patterns").PII_PATTERNS} for JWTs, bearer tokens, Stellar
 *    secret keys, PEM blocks, AWS/GitHub/Slack/Stripe keys, IP addresses, emails,
 *    card numbers and other credential shapes.
 */

import type { TimelineEvent } from "../types";
import {
  PII_PATTERNS,
  compilePattern,
  sensitiveKeyLabel,
  tokenFor,
  type PiiPattern,
  type PiiSeverity,
} from "./patterns";

export interface RedactionFinding {
  /** Pattern id, or `key:<normalizedKey>` for a structural redaction. */
  id: string;
  label: string;
  severity: PiiSeverity;
  /** Number of values replaced by this rule in one pass. */
  count: number;
}

export interface RedactOptions {
  /** Replace a redacted value with this instead of the default token. */
  token?: (finding: { id: string; label: string }) => string;
  /** Guard against pathological/recursive payloads. Default 12. */
  maxDepth?: number;
  /** Extra patterns appended after the built-ins. */
  extraPatterns?: PiiPattern[];
}

export interface RedactionResult<T> {
  value: T;
  findings: RedactionFinding[];
  /** Total number of individual values replaced. */
  redactedCount: number;
}

/** A timeline event whose strings have been scrubbed. */
export interface RedactedTimelineEvent extends TimelineEvent {
  /** Always `true` — marks the value as safe to render and export. */
  redacted: true;
  /** Per-rule counts so the UI can explain what was hidden. */
  redactionFindings: RedactionFinding[];
  /** Total values replaced in this event. */
  redactionCount: number;
}

const DEFAULT_MAX_DEPTH = 12;

class FindingCollector {
  private readonly counts = new Map<string, RedactionFinding>();

  add(id: string, label: string, severity: PiiSeverity, count = 1): void {
    const existing = this.counts.get(id);
    if (existing) {
      existing.count += count;
      return;
    }
    this.counts.set(id, { id, label, severity, count });
  }

  list(): RedactionFinding[] {
    return [...this.counts.values()].sort((a, b) => b.count - a.count);
  }

  get total(): number {
    let sum = 0;
    for (const entry of this.counts.values()) sum += entry.count;
    return sum;
  }
}

interface ResolvedPattern {
  id: string;
  label: string;
  severity: PiiSeverity;
  regex: RegExp;
  replacement?: string;
}

/** Global regexes carry `lastIndex` state; always hand out a fresh instance. */
function fresh(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

function resolvePatterns(options: RedactOptions): ResolvedPattern[] {
  const patterns = [...PII_PATTERNS, ...(options.extraPatterns ?? [])];
  return patterns.map((pattern) => ({
    id: pattern.id,
    label: pattern.label,
    severity: pattern.severity,
    regex: compilePattern(pattern),
    replacement: pattern.replacement,
  }));
}

/**
 * Apply every pattern to a single string.
 *
 * Returns the scrubbed text plus the findings, so callers can show exactly which
 * rules fired instead of a generic "some data was hidden".
 */
export function redactString(
  input: string,
  options: RedactOptions = {},
): { text: string; findings: RedactionFinding[] } {
  if (input.length === 0) return { text: input, findings: [] };

  const collector = new FindingCollector();
  const token = options.token ?? ((finding) => tokenFor(finding.label));
  let text = input;

  for (const pattern of resolvePatterns(options)) {
    const matches = text.match(fresh(pattern.regex));
    if (!matches || matches.length === 0) continue;

    collector.add(pattern.id, pattern.label, pattern.severity, matches.length);

    text = pattern.replacement
      ? // `$1` templates keep a safe prefix (the header/field name) visible.
        text.replace(fresh(pattern.regex), pattern.replacement)
      : text.replace(fresh(pattern.regex), () => token({ id: pattern.id, label: pattern.label }));
  }

  return { text, findings: collector.list() };
}

function redactValueInner(
  value: unknown,
  collector: FindingCollector,
  token: (finding: { id: string; label: string }) => string,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const { text, findings } = redactString(value, { token: (finding) => token(finding) });
    for (const finding of findings) {
      collector.add(finding.id, finding.label, finding.severity, finding.count);
    }
    return text;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (depth >= maxDepth) return value;

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) =>
          redactValueInner(entry, collector, token, depth + 1, maxDepth, seen),
        );
      }

      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const label = sensitiveKeyLabel(key);
        if (label) {
          const id = `key:${key.toLowerCase()}`;
          collector.add(id, label, "high");
          output[key] = token({ id, label });
          continue;
        }
        output[key] = redactValueInner(entry, collector, token, depth + 1, maxDepth, seen);
      }
      return output;
    } finally {
      seen.delete(value as object);
    }
  }

  // Functions, symbols — rendered as-is; the DOM never gets these from an API.
  return value;
}

/** Recursively redact an arbitrary value (object, array, string, primitive). */
export function redactValue<T = unknown>(
  value: T,
  options: RedactOptions = {},
): RedactionResult<T> {
  const collector = new FindingCollector();
  const token = options.token ?? ((finding) => tokenFor(finding.label));
  const redacted = redactValueInner(
    value,
    collector,
    token,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    0,
    new WeakSet(),
  ) as T;
  return { value: redacted, findings: collector.list(), redactedCount: collector.total };
}

/**
 * Redact a timeline event.
 *
 * `id`, `userId` and `type` are preserved verbatim — they are the event's
 * identity and are already scoped to the requesting user — while every
 * human-readable string and the whole `metadata` bag are scrubbed.
 */
export function redactTimelineEvent(
  event: TimelineEvent,
  options: RedactOptions = {},
): RedactionResult<RedactedTimelineEvent> {
  const collector = new FindingCollector();
  const token = options.token ?? ((finding) => tokenFor(finding.label));
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const scrub = (input: string): string => {
    const { text, findings } = redactString(input, { ...options, token });
    for (const finding of findings) {
      collector.add(finding.id, finding.label, finding.severity, finding.count);
    }
    return text;
  };

  const metadata = event.metadata
    ? (redactValueInner(
        event.metadata,
        collector,
        token,
        maxDepth,
        0,
        new WeakSet(),
      ) as Record<string, unknown>)
    : undefined;

  const value: RedactedTimelineEvent = {
    ...event,
    title: scrub(event.title ?? ""),
    description: scrub(event.description ?? ""),
    resourceId: event.resourceId ? scrub(event.resourceId) : undefined,
    resourceUrl: event.resourceUrl ? scrub(event.resourceUrl) : undefined,
    ...(metadata ? { metadata } : {}),
    redacted: true,
    redactionFindings: collector.list(),
    redactionCount: collector.total,
  };

  return { value, findings: value.redactionFindings, redactedCount: value.redactionCount };
}

/** Redact a batch of events, aggregating the findings across all of them. */
export function redactTimelineEvents(
  events: TimelineEvent[],
  options: RedactOptions = {},
): RedactionResult<RedactedTimelineEvent[]> {
  const collector = new FindingCollector();
  const values: RedactedTimelineEvent[] = [];

  for (const event of events) {
    const result = redactTimelineEvent(event, options);
    values.push(result.value);
    for (const finding of result.findings) {
      collector.add(finding.id, finding.label, finding.severity, finding.count);
    }
  }

  return { value: values, findings: collector.list(), redactedCount: collector.total };
}

/** Human-readable summary of what a redaction pass removed. */
export function describeFindings(findings: RedactionFinding[]): string {
  if (findings.length === 0) return "No sensitive data detected.";
  return findings
    .map((finding) => `${finding.count} × ${finding.label}`)
    .join(", ");
}

/** Highest severity present in a finding list, or `null` when none. */
export function highestSeverity(findings: RedactionFinding[]): PiiSeverity | null {
  const order: PiiSeverity[] = ["critical", "high", "medium"];
  for (const severity of order) {
    if (findings.some((finding) => finding.severity === severity)) return severity;
  }
  return null;
}
