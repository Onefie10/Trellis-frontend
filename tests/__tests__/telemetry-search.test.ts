import {
  compileTelemetrySearch,
  filterTelemetryEvents,
  highlightTelemetryText,
} from '@/lib/telemetry/search';
import type { TelemetryEvent } from '@/lib/telemetry/types';

function event(id: number, message: string): TelemetryEvent {
  return {
    id: `event-${id}`,
    ts: id,
    agentRef: 'agent-search-test',
    type: 'status',
    severity: 'info',
    payload: { message },
  };
}

describe('telemetry search', () => {
  it('treats plain text as literal, case-insensitive input', () => {
    const pattern = compileTelemetrySearch('disk (full)', false);
    expect(pattern.error).toBeNull();
    expect(filterTelemetryEvents([event(1, 'DISK (FULL)'), event(2, 'disk full')], pattern)).toHaveLength(1);
  });

  it('reports malformed regular expressions without throwing', () => {
    const pattern = compileTelemetrySearch('[', true);
    expect(pattern.regex).toBeNull();
    expect(pattern.error).toBeTruthy();
    expect(filterTelemetryEvents([event(1, 'anything')], pattern)).toEqual([]);
  });

  it('filters a stream larger than 10,000 events without per-row regex compilation', () => {
    const events = Array.from({ length: 12_000 }, (_, index) =>
      event(index, index % 997 === 0 ? `WARN reconnect ${index}` : `heartbeat ${index}`)
    );
    const pattern = compileTelemetrySearch('WARN\\s+reconnect\\s+\\d+', true);

    const results = filterTelemetryEvents(events, pattern);

    expect(results).toHaveLength(13);
    expect(results[0].id).toBe('event-0');
    expect(results.at(-1)?.id).toBe('event-11964');
  });

  it('highlights all matches for navigation context', () => {
    expect(highlightTelemetryText('warn: warn', /warn/i)).toEqual([
      { match: 'warn' },
      ': ',
      { match: 'warn' },
    ]);
  });
});
