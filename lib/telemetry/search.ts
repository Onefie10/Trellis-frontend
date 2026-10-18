import type { TelemetryEvent } from './types';

export interface TelemetrySearchPattern {
  regex: RegExp | null;
  error: string | null;
}

/** Compile once per query; global/sticky flags are added only to fresh highlighters. */
export function compileTelemetrySearch(query: string, useRegex: boolean): TelemetrySearchPattern {
  if (!query.trim()) return { regex: null, error: null };
  if (!useRegex) return { regex: new RegExp(escapeRegExp(query), 'i'), error: null };

  try {
    return { regex: new RegExp(query, 'i'), error: null };
  } catch (error) {
    return {
      regex: null,
      error: error instanceof Error ? error.message : 'Invalid regular expression',
    };
  }
}

export function telemetryEventSearchText(event: TelemetryEvent): string {
  return [
    event.agentRef,
    event.type,
    event.severity,
    event.payload?.code,
    event.payload?.message,
    event.payload?.state,
    event.payload?.taskKind,
    event.payload?.correlationId,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

export function filterTelemetryEvents(
  events: TelemetryEvent[],
  pattern: TelemetrySearchPattern
): TelemetryEvent[] {
  if (!pattern.regex) return pattern.error ? [] : events;
  return events.filter((event) => pattern.regex!.test(telemetryEventSearchText(event)));
}

export function highlightTelemetryText(text: string, pattern: RegExp | null): Array<string | { match: string }> {
  if (!pattern) return [text];
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`);
  const result: Array<string | { match: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (match.index > lastIndex) result.push(text.slice(lastIndex, match.index));
    // Empty matches must advance to avoid an infinite loop.
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    result.push({ match: match[0] });
    lastIndex = matcher.lastIndex;
  }
  if (lastIndex < text.length) result.push(text.slice(lastIndex));
  return result.length ? result : [text];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
