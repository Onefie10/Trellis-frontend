import { TimelineEvent, EVENT_TYPE_LABELS } from "../types";
import { RedactedText } from "./RedactedText";
import { SEVERITY_STYLES, type EventSeverity } from "../severity";
import type { RedactionFinding } from "../redaction/redactor";

interface TimelineEntryProps {
  event: TimelineEvent & {
    redactionFindings?: RedactionFinding[];
    redactionCount?: number;
  };
  /** Derived severity; falls back to the type default when not supplied. */
  severity?: EventSeverity;
}

/** Only render navigable resource links with a non-executable URL scheme. */
export function safeTimelineResourceHref(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (!candidate || candidate.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(candidate)) return null;

  try {
    const parsed = new URL(candidate, "https://trellis.invalid");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Renders a single timeline entry with a stable link to the resource.
 *
 * Every human-readable string goes through {@link RedactedText}, so a redaction
 * token is visible as a badge rather than silently missing.
 */
export function TimelineEntry({ event, severity = "info" }: TimelineEntryProps) {
  const label = EVENT_TYPE_LABELS[event.type];
  const formattedDate = new Date(event.timestamp).toLocaleString();
  const findings = event.redactionFindings ?? [];
  const resourceHref = safeTimelineResourceHref(event.resourceUrl);

  return (
    <div
      className="border-l-2 border-amber-200 pl-4 py-3"
      data-testid="timeline-entry"
      data-severity={severity}
      data-redaction-count={event.redactionCount ?? 0}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-amber-900">{label}</h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEVERITY_STYLES[severity]}`}
            >
              {severity}
            </span>
          </div>

          <RedactedText text={event.description} className="mt-1 block text-sm text-gray-700" />

          {findings.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-800" data-testid="redaction-badges">
              🔒 {findings.map((finding) => `${finding.label} ×${finding.count}`).join(", ")}
            </p>
          )}

          {resourceHref && (
            <a
              href={resourceHref}
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-amber-600 hover:underline"
            >
              View Details →
            </a>
          )}
        </div>
        <time className="whitespace-nowrap text-xs text-gray-500">{formattedDate}</time>
      </div>
    </div>
  );
}

export default TimelineEntry;
