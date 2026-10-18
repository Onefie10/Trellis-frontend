/**
 * Tests for the idempotency layer (issue #28).
 *
 * The engine is tested against an in-memory store and a fake clock, so every
 * branch is deterministic. The last block drives `apiClient.postIdempotent`
 * with a mocked `fetch` to prove that a repeated attempt reaches the network
 * once, not twice.
 */

import {
  DEFAULT_STALE_IN_PROGRESS_MS,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyExpiredError,
  IdempotencyRecord,
  LocalStorageIdempotencyStore,
  MemoryIdempotencyStore,
  __resetInFlight,
  beginIdempotentAttempt,
  createIdempotencyKey,
  executeIdempotent,
  fingerprintRequest,
  finishIdempotentAttempt,
} from '../idempotency';

describe('executeIdempotent', () => {
  let store: MemoryIdempotencyStore;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    store = new MemoryIdempotencyStore();
    now = 1_760_000_000_000;
    __resetInFlight();
  });

  const run = <T,>(
    operation: () => Promise<T>,
    overrides: Partial<{ key: string; fingerprint: string; ttlMs: number }> = {},
  ) =>
    executeIdempotent<T>(
      {
        key: overrides.key ?? 'key-1',
        fingerprint: overrides.fingerprint ?? 'fp-1',
        ttlMs: overrides.ttlMs,
        store,
        now: clock,
      },
      operation,
    );

  test('runs the operation once and remembers its outcome', async () => {
    const operation = jest.fn(async () => ({ payout: 'queued' }));

    const first = await run(operation);

    expect(first).toEqual({ value: { payout: 'queued' }, replayed: false });
    expect(operation).toHaveBeenCalledTimes(1);
    const record = store.get('key-1') as IdempotencyRecord;
    expect(record.status).toBe('succeeded');
    expect(record.result).toEqual({ payout: 'queued' });
  });

  test('retry after success replays the stored result without a second call', async () => {
    const operation = jest.fn(async () => ({ payout: 'queued' }));
    await run(operation);

    const retry = await run(operation);

    expect(retry).toEqual({ value: { payout: 'queued' }, replayed: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('retry after failure runs again and can succeed', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce('queued');

    await expect(run(operation)).rejects.toThrow('network down');
    expect((store.get('key-1') as IdempotencyRecord).status).toBe('failed');

    const retry = await run(operation);

    expect(retry).toEqual({ value: 'queued', replayed: false });
    expect(operation).toHaveBeenCalledTimes(2);
    expect((store.get('key-1') as IdempotencyRecord).status).toBe('succeeded');
  });

  test('records the failure reason for later inspection', async () => {
    await expect(
      run(async () => {
        throw new Error('insufficient pending earnings');
      }),
    ).rejects.toThrow('insufficient pending earnings');

    expect((store.get('key-1') as IdempotencyRecord).error).toBe(
      'insufficient pending earnings',
    );
  });

  test('concurrent duplicates share one operation', async () => {
    let resolveOperation: (value: string) => void = () => {};
    const operation = jest.fn(
      () => new Promise<string>((resolve) => {
        resolveOperation = resolve;
      }),
    );

    const first = run(operation);
    const second = run(operation);
    resolveOperation('queued');

    const [a, b] = await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: 'queued', replayed: false });
    expect(b).toEqual({ value: 'queued', replayed: false });
  });

  test('the same key with a different payload is a conflict', async () => {
    await run(async () => 'first', { fingerprint: 'fp-amount-100' });

    await expect(run(async () => 'second', { fingerprint: 'fp-amount-999' })).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  test('an expired key is refused instead of being replayed', async () => {
    await run(async () => 'queued', { ttlMs: 1_000 });

    now += 1_001;

    await expect(run(async () => 'queued')).rejects.toThrow(IdempotencyKeyExpiredError);
  });

  test('a fresh in-progress attempt from another tab is refused', async () => {
    store.set('key-1', {
      key: 'key-1',
      fingerprint: 'fp-1',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });

    await expect(run(async () => 'queued')).rejects.toThrow(IdempotencyInProgressError);
  });

  test('cross-tab lock contention refuses duplicate attempt', async () => {
    const originalLocks = global.navigator?.locks;
    Object.defineProperty(global, 'navigator', {
      value: {
        locks: {
          request: jest.fn(async (name, options, callback) => {
             // Simulate lock already held by another tab
             return callback(null);
          })
        }
      },
      writable: true
    });

    await expect(run(async () => 'queued')).rejects.toThrow(IdempotencyInProgressError);
    expect(global.navigator.locks.request).toHaveBeenCalledWith('trellis:idempotency:key-1', { ifAvailable: true }, expect.any(Function));

    Object.defineProperty(global, 'navigator', { value: { locks: originalLocks }, writable: true });
  });

  test('an abandoned in-progress attempt is retried once it goes stale', async () => {
    store.set('key-1', {
      key: 'key-1',
      fingerprint: 'fp-1',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });

    now += DEFAULT_STALE_IN_PROGRESS_MS + 1;
    const operation = jest.fn(async () => 'queued');

    const result = await run(operation);

    expect(result.value).toBe('queued');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('a retry keeps the original expiry rather than extending it', async () => {
    await expect(
      run(
        async () => {
          throw new Error('boom');
        },
        { ttlMs: 1_000 },
      ),
    ).rejects.toThrow('boom');
    const originalExpiry = (store.get('key-1') as IdempotencyRecord).expiresAt;

    now += 500;
    await run(async () => 'queued');

    expect((store.get('key-1') as IdempotencyRecord).expiresAt).toBe(originalExpiry);
  });
});

describe('request fingerprints and derived keys', () => {
  test('a fingerprint ignores key order but follows the values', () => {
    expect(fingerprintRequest({ amount: '100', to: 'GABC' })).toBe(
      fingerprintRequest({ to: 'GABC', amount: '100' }),
    );
    expect(fingerprintRequest({ amount: '100' })).not.toBe(
      fingerprintRequest({ amount: '101' }),
    );
  });

  test('an operation gets the same key for the same request and a different one otherwise', async () => {
    const request = { walletAddress: 'GABC', amount: '100' };

    const a = await createIdempotencyKey('payout:GABC', request);
    const b = await createIdempotencyKey('payout:GABC', request);
    const different = await createIdempotencyKey('payout:GABC', { ...request, amount: '101' });
    const otherScope = await createIdempotencyKey('claim:42', request);

    expect(a).toBe(b);
    expect(a).not.toBe(different);
    expect(a).toMatch(/^payout:GABC:/);
    expect(otherScope).toMatch(/^claim:42:/);
  });
});

describe('attempt keys', () => {
  let store: MemoryIdempotencyStore;
  let now: number;

  beforeEach(() => {
    store = new MemoryIdempotencyStore();
    now = 1_760_000_000_000;
  });

  const begin = (scope: string, ttlMs?: number) =>
    beginIdempotentAttempt(scope, { store, now: () => now, ttlMs });

  test('a second click on the same attempt reuses its key', async () => {
    const first = await begin('payout:GABC:100:GABC');
    const second = await begin('payout:GABC:100:GABC');

    expect(second).toBe(first);
  });

  test('after the attempt closes, the same request is a new intent', async () => {
    const first = await begin('payout:GABC:100:GABC');
    finishIdempotentAttempt('payout:GABC:100:GABC', store);

    const second = await begin('payout:GABC:100:GABC');

    expect(second).not.toBe(first);
  });

  test('an attempt left open past its window is replaced', async () => {
    const first = await begin('payout:GABC:100:GABC', 1_000);
    now += 1_001;

    const second = await begin('payout:GABC:100:GABC', 1_000);

    expect(second).not.toBe(first);
  });

  test('different amounts are different attempts', async () => {
    const hundred = await begin('payout:GABC:100:GABC');
    const twoHundred = await begin('payout:GABC:200:GABC');

    expect(twoHundred).not.toBe(hundred);
  });
});

describe('LocalStorageIdempotencyStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('an outcome written before a reload is still readable after it', () => {
    const beforeReload = new LocalStorageIdempotencyStore();
    beforeReload.set('key-1', {
      key: 'key-1',
      fingerprint: 'fp-1',
      status: 'succeeded',
      result: { payout: 'queued' },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    });

    // A "reload" is a new store instance over the same storage.
    const afterReload = new LocalStorageIdempotencyStore();

    expect(afterReload.get('key-1')?.result).toEqual({ payout: 'queued' });
  });

  test('a corrupted record is dropped rather than blocking every retry', () => {
    window.localStorage.setItem('trellis:idempotency:key-1', '{not json');

    expect(new LocalStorageIdempotencyStore().get('key-1')).toBeNull();
    expect(window.localStorage.getItem('trellis:idempotency:key-1')).toBeNull();
  });

  test('a stored outcome is replayed after a reload instead of re-sent', async () => {
    const store = new LocalStorageIdempotencyStore();
    const operation = jest.fn(async () => ({ payout: 'queued' }));

    await executeIdempotent(
      { key: 'key-1', fingerprint: 'fp-1', store },
      operation,
    );
    __resetInFlight();

    const afterReload = await executeIdempotent(
      { key: 'key-1', fingerprint: 'fp-1', store: new LocalStorageIdempotencyStore() },
      operation,
    );

    expect(afterReload.replayed).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('apiClient.postIdempotent', () => {
  const response = (payload: unknown) =>
    ({ ok: true, statusText: 'OK', json: async () => payload }) as unknown as Response;

  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    window.localStorage.clear();
    fetchMock = jest.fn(async () => response({ id: 'payout-1' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  test('a repeated identical request reaches the network once', async () => {
    const { apiClient } = await import('../api');
    apiClient.clearCache();

    const body = { walletAddress: 'GABC', amount: '100', destinationAddress: 'GABC' };

    const first = await apiClient.postIdempotent('/affiliates/payouts', body);
    const second = await apiClient.postIdempotent('/affiliates/payouts', body);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('the idempotency key travels to the server as a header', async () => {
    const { apiClient } = await import('../api');
    apiClient.clearCache();

    await apiClient.postIdempotent('/affiliates/payouts', { amount: '100' });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^\/affiliates\/payouts:/);
  });

  test('a different amount is a different request, not a replay', async () => {
    const { apiClient } = await import('../api');
    apiClient.clearCache();

    await apiClient.postIdempotent('/affiliates/payouts', { amount: '100' });
    await apiClient.postIdempotent('/affiliates/payouts', { amount: '200' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a failed request is retried by the caller', async () => {
    const { apiClient } = await import('../api');
    apiClient.clearCache();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      })
      .mockResolvedValueOnce(response({ id: 'payout-1' }));

    await expect(
      apiClient.postIdempotent('/affiliates/payouts', { amount: '100' }),
    ).rejects.toThrow('API error');
    const retry = await apiClient.postIdempotent('/affiliates/payouts', { amount: '100' });

    expect(retry.replayed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
