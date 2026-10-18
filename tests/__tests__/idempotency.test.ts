/**
 * Idempotency telemetry (issue #226).
 *
 * Every `executeIdempotent` outcome must move exactly one telemetry counter and
 * reach the operational metrics store, so the operations dashboard can chart
 * duplicate submissions and key collisions over time.
 */

import {
  DUPLICATE_RATE_WARNING_THRESHOLD,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyExpiredError,
  MemoryIdempotencyStore,
  __resetInFlight,
  buildIdempotencyRateSeries,
  duplicateRequestRate,
  executeIdempotent,
  getIdempotencyTelemetry,
  resetIdempotencyTelemetry,
  scopeFromIdempotencyKey,
  subscribeIdempotencyTelemetry,
  type IdempotencyTelemetryEvent,
} from '@/lib/idempotency';
import { defaultMetricExporter } from '@/lib/metric-definitions';
import { useApiMetricsStore } from '@/store/apiMetricsStore';

describe('idempotency telemetry counters', () => {
  let store: MemoryIdempotencyStore;
  let now: number;
  let events: IdempotencyTelemetryEvent[];
  let unsubscribe: () => void;

  const run = <T,>(operation: () => Promise<T>, overrides: Partial<{ key: string; fingerprint: string }> = {}) =>
    executeIdempotent<T>(
      {
        key: overrides.key ?? 'payout:abc123',
        fingerprint: overrides.fingerprint ?? 'fp-1',
        store,
        now: () => now,
      },
      operation,
    );

  beforeEach(() => {
    store = new MemoryIdempotencyStore();
    now = 1_760_000_000_000;
    events = [];
    __resetInFlight();
    resetIdempotencyTelemetry();
    useApiMetricsStore.getState().clearIdempotencyTelemetry();
    unsubscribe = subscribeIdempotencyTelemetry((event) => events.push(event));
  });

  afterEach(() => unsubscribe());

  test('a first attempt counts as a request but not a hit or collision', async () => {
    await run(async () => 'ok');

    expect(getIdempotencyTelemetry()).toEqual({
      idempotency_requests: 1,
      idempotency_hits: 0,
      idempotency_collisions: 0,
      idempotency_retries: 0,
      idempotency_expired: 0,
    });
    expect(events).toEqual([{ kind: 'miss', reason: 'first_attempt', scope: 'payout', ts: now }]);
  });

  test('replaying a stored success increments idempotency_hits', async () => {
    await run(async () => 'ok');
    await run(async () => 'ok');
    await run(async () => 'ok');

    const counters = getIdempotencyTelemetry();
    expect(counters.idempotency_requests).toBe(3);
    expect(counters.idempotency_hits).toBe(2);
    expect(events.filter((e) => e.kind === 'hit').every((e) => e.reason === 'replayed')).toBe(true);
  });

  test('a double click while the first request is in flight counts as a hit', async () => {
    let release!: (value: string) => void;
    const operation = jest.fn(() => new Promise<string>((resolve) => (release = resolve)));

    const first = run(operation);
    const second = run(operation);
    release('done');
    await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(getIdempotencyTelemetry().idempotency_hits).toBe(1);
    expect(events.map((e) => e.reason)).toContain('in_flight');
  });

  test('same key with a different payload increments idempotency_collisions', async () => {
    await run(async () => 'ok');
    await expect(run(async () => 'other', { fingerprint: 'fp-2' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );

    expect(getIdempotencyTelemetry().idempotency_collisions).toBe(1);
    expect(events[events.length - 1]).toMatchObject({ kind: 'collision', reason: 'fingerprint_mismatch' });
  });

  test('a fresh in-progress record from another tab counts as a collision', async () => {
    store.set('payout:abc123', {
      key: 'payout:abc123',
      fingerprint: 'fp-1',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });

    await expect(run(async () => 'ok')).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(getIdempotencyTelemetry().idempotency_collisions).toBe(1);
    expect(events[events.length - 1]?.reason).toBe('in_progress');
  });

  test('re-running after a failure increments idempotency_retries', async () => {
    await expect(run(async () => Promise.reject(new Error('network down')))).rejects.toThrow('network down');
    await run(async () => 'ok');

    expect(getIdempotencyTelemetry().idempotency_retries).toBe(1);
    expect(events[events.length - 1]).toMatchObject({ kind: 'retry', reason: 'failed_retry' });
  });

  test('an expired key increments idempotency_expired', async () => {
    await run(async () => 'ok');
    now += 25 * 60 * 60 * 1000;

    await expect(run(async () => 'ok')).rejects.toBeInstanceOf(IdempotencyKeyExpiredError);
    expect(getIdempotencyTelemetry().idempotency_expired).toBe(1);
  });

  test('telemetry is exported to the operational metrics store', async () => {
    await run(async () => 'ok');
    await run(async () => 'ok');
    await expect(run(async () => 'x', { fingerprint: 'fp-2' })).rejects.toThrow();

    const state = useApiMetricsStore.getState();
    expect(state.idempotency).toMatchObject({
      idempotency_requests: 3,
      idempotency_hits: 1,
      idempotency_collisions: 1,
    });
    expect(state.idempotencyEvents.map((e) => e.kind)).toEqual(['miss', 'hit', 'collision']);
  });

  test('telemetry is recorded on the OTLP exporter without the key', async () => {
    const recordSpy = jest.spyOn(defaultMetricExporter, 'record');
    await run(async () => 'ok');
    await run(async () => 'ok');

    const names = recordSpy.mock.calls.map(([point]) => point.name);
    expect(names).toEqual(['idempotency.requests', 'idempotency.requests', 'idempotency.hits']);
    for (const [point] of recordSpy.mock.calls) {
      expect(JSON.stringify(point.attributes)).not.toContain('abc123');
    }
    recordSpy.mockRestore();
  });

  test('a throwing listener does not break the write path', async () => {
    const off = subscribeIdempotencyTelemetry(() => {
      throw new Error('listener bug');
    });
    await expect(run(async () => 'ok')).resolves.toEqual({ value: 'ok', replayed: false });
    off();
  });
});

describe('idempotency telemetry helpers', () => {
  test('scopeFromIdempotencyKey keeps only the operation scope', () => {
    expect(scopeFromIdempotencyKey('payout:deadbeef')).toBe('payout');
    expect(scopeFromIdempotencyKey('rewards:claim:deadbeef')).toBe('rewards:claim');
    expect(scopeFromIdempotencyKey('attempt:payout:deadbeef')).toBe('payout');
    expect(scopeFromIdempotencyKey('no-scope')).toBe('unscoped');
  });

  test('duplicateRequestRate is (hits + collisions) / requests', () => {
    expect(duplicateRequestRate({ idempotency_requests: 0, idempotency_hits: 0, idempotency_collisions: 0 })).toBe(0);
    expect(duplicateRequestRate({ idempotency_requests: 10, idempotency_hits: 2, idempotency_collisions: 1 })).toBeCloseTo(0.3);
    expect(DUPLICATE_RATE_WARNING_THRESHOLD).toBeGreaterThan(0);
  });

  test('buildIdempotencyRateSeries buckets events over the window', () => {
    const now = 1_000_000;
    const event = (kind: IdempotencyTelemetryEvent['kind'], ts: number): IdempotencyTelemetryEvent => ({
      kind,
      reason: 'first_attempt',
      scope: 'payout',
      ts,
    });
    const series = buildIdempotencyRateSeries(
      [
        event('miss', now - 50_000),
        event('hit', now - 45_000),
        event('collision', now - 5_000),
        event('miss', now - 5_000),
        event('miss', now - 500_000), // outside window
        event('hit', now), // window end is exclusive
      ],
      { windowMs: 60_000, bucketMs: 30_000, now },
    );

    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ requests: 2, hits: 1, collisions: 0, duplicateRate: 0.5 });
    expect(series[1]).toMatchObject({ requests: 2, hits: 0, collisions: 1, duplicateRate: 0.5 });
    expect(buildIdempotencyRateSeries([], { windowMs: 0, bucketMs: 1, now })).toEqual([]);
  });
});
