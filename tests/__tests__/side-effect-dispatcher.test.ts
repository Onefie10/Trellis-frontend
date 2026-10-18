/**
 * Verification test suite for Idempotent Side-Effect Dispatcher and DLQ recovery.
 */

import {
  IdempotencyConflictError,
  IdempotencyKeyExpiredError,
  MemoryIdempotencyStore,
} from '@/lib/idempotency';
import {
  SideEffectDispatcher,
  MemorySideEffectDLQStore,
  SideEffectDeadLetterQueue,
  type SideEffectDescriptor,
  type SideEffectTelemetryEvent,
} from '@/lib/side-effects';

describe('Idempotent Side-Effect Dispatcher', () => {
  let mockNow: number;
  let nowFn: () => number;
  let sleepFn: (ms: number) => Promise<void>;
  let idempotencyStore: MemoryIdempotencyStore;
  let dlqStore: MemorySideEffectDLQStore;
  let dlq: SideEffectDeadLetterQueue;
  let telemetryEvents: SideEffectTelemetryEvent[];
  let dispatcher: SideEffectDispatcher;

  beforeEach(() => {
    mockNow = 1_700_000_000_000;
    nowFn = () => mockNow;
    sleepFn = jest.fn().mockImplementation((ms: number) => {
      mockNow += ms;
      return Promise.resolve();
    });
    idempotencyStore = new MemoryIdempotencyStore();
    dlqStore = new MemorySideEffectDLQStore();
    dlq = new SideEffectDeadLetterQueue(dlqStore, nowFn);
    telemetryEvents = [];

    dispatcher = new SideEffectDispatcher(idempotencyStore, dlq, {
      now: nowFn,
      sleep: sleepFn,
      random: () => 0.5,
      onTelemetry: (evt) => telemetryEvents.push(evt),
    });
  });

  it('executes a side effect and caches the result for replay with same key and payload', async () => {
    const handler = jest.fn().mockResolvedValue({ txHash: 'tx_123', status: 'confirmed' });
    const descriptor: SideEffectDescriptor<{ amount: number; recipient: string }> = {
      action: 'wallet:transfer',
      key: 'key-transfer-1',
      payload: { amount: 100, recipient: 'GA...' },
      operationClass: 'stellar_payment',
    };

    // First execution
    const firstResult = await dispatcher.dispatch(descriptor, handler);
    expect(firstResult.ok).toBe(true);
    expect(firstResult.isCached).toBe(false);
    expect(firstResult.result).toEqual({ txHash: 'tx_123', status: 'confirmed' });
    expect(handler).toHaveBeenCalledTimes(1);

    // Second execution with same key and payload (e.g. repeated user click or page reload)
    const secondResult = await dispatcher.dispatch(descriptor, handler);
    expect(secondResult.ok).toBe(true);
    expect(secondResult.isCached).toBe(true);
    expect(secondResult.result).toEqual({ txHash: 'tx_123', status: 'confirmed' });
    expect(handler).toHaveBeenCalledTimes(1); // Not called again!

    // Verify telemetry
    expect(telemetryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'side_effect_queued', key: 'key-transfer-1' }),
        expect.objectContaining({ type: 'side_effect_succeeded', key: 'key-transfer-1' }),
        expect.objectContaining({ type: 'side_effect_cached_hit', key: 'key-transfer-1' }),
      ]),
    );
  });

  it('rejects with IdempotencyConflictError if the same key is reused with different payload', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const descriptor1: SideEffectDescriptor<{ amount: number }> = {
      action: 'payout',
      key: 'key-payout-1',
      payload: { amount: 50 },
    };
    const descriptor2: SideEffectDescriptor<{ amount: number }> = {
      action: 'payout',
      key: 'key-payout-1',
      payload: { amount: 100 },
    };

    await dispatcher.dispatch(descriptor1, handler);

    await expect(dispatcher.dispatch(descriptor2, handler)).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  it('rejects with IdempotencyKeyExpiredError when key has expired', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const descriptor: SideEffectDescriptor<{ foo: string }> = {
      action: 'test',
      key: 'key-expired',
      payload: { foo: 'bar' },
      ttlMs: 1000,
    };

    await dispatcher.dispatch(descriptor, handler);

    // Advance time past TTL
    mockNow += 2000;

    await expect(dispatcher.dispatch(descriptor, handler)).rejects.toThrow(
      IdempotencyKeyExpiredError,
    );
  });

  it('shares concurrent in-flight execution promise within same tab', async () => {
    let resolveHandler: (val: any) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveHandler = resolve;
    });

    const handler = jest.fn().mockReturnValue(deferredPromise);
    const descriptor: SideEffectDescriptor<{ id: string }> = {
      action: 'concurrent-action',
      key: 'key-concurrent',
      payload: { id: 'item-1' },
    };

    const call1 = dispatcher.dispatch(descriptor, handler);
    const call2 = dispatcher.dispatch(descriptor, handler);

    resolveHandler({ data: 'ok' });

    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and moves exhausted operations into dead-letter queue', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    const descriptor: SideEffectDescriptor<{ note: string }> = {
      action: 'api:mutate',
      key: 'key-failing-1',
      payload: { note: 'important' },
      operationClass: 'api_write',
      retryPolicy: { maxRetries: 2, baseDelayMs: 100 },
    };

    const result = await dispatcher.dispatch(descriptor, handler);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('dead_lettered');
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(result.deadLetterId).toBeDefined();

    // DLQ assertions
    const dlqItems = dlq.list();
    expect(dlqItems).toHaveLength(1);
    expect(dlqItems[0].key).toBe('key-failing-1');
    expect(dlqItems[0].totalAttempts).toBe(3);
    expect(dlqItems[0].lastError).toContain('503');

    // Telemetry assertions
    expect(telemetryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'side_effect_retry', key: 'key-failing-1', attempt: 1 }),
        expect.objectContaining({ type: 'side_effect_retry', key: 'key-failing-1', attempt: 2 }),
        expect.objectContaining({ type: 'side_effect_dead_lettered', key: 'key-failing-1' }),
      ]),
    );
  });

  it('recovers dead-lettered operations upon manual replay', async () => {
    let callCount = 0;
    const testHandler = jest.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 3) {
        throw new Error('503 Temporary Network Error');
      }
      return { settled: true };
    });

    dispatcher.registerHandler('payment:send', testHandler);

    const descriptor: SideEffectDescriptor<{ orderId: string }> = {
      action: 'payment:send',
      key: 'key-order-99',
      payload: { orderId: 'ord-99' },
      retryPolicy: { maxRetries: 2, baseDelayMs: 10 },
    };

    const firstRun = await dispatcher.dispatch(descriptor);
    expect(firstRun.ok).toBe(false);
    expect(firstRun.deadLetterId).toBeDefined();

    const dlqId = firstRun.deadLetterId!;
    expect(dlq.get(dlqId)?.resolvedAt).toBeUndefined();

    // Replay from DLQ
    const replayResult = await dispatcher.replayDeadLetter<{ settled: boolean }>(dlqId);
    expect(replayResult.ok).toBe(true);
    expect(replayResult.result?.settled).toBe(true);

    // Verify DLQ marked resolved
    const resolvedEntry = dlq.get(dlqId);
    expect(resolvedEntry?.resolution).toBe('replayed');
    expect(resolvedEntry?.resolvedAt).toBeDefined();

    // Verify subsequent call with same key returns cached result
    const cachedRun = await dispatcher.dispatch(descriptor);
    expect(cachedRun.ok).toBe(true);
    expect(cachedRun.isCached).toBe(true);
  });

  it('discards a dead-letter entry cleanly when requested', () => {
    dlq.enqueue(
      { action: 'discard:test', key: 'key-discard', payload: {} },
      [],
      'Permanent validation failure',
    );
    expect(dlq.list()).toHaveLength(1);
    const entryId = dlq.list()[0].id;

    const discarded = dispatcher.discardDeadLetter(entryId);
    expect(discarded).toBe(true);
    expect(dlq.list()).toHaveLength(0);
  });
});
