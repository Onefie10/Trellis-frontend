import {
  ApiError,
  DeadLetterQueue,
  InMemoryDeadLetterStore,
  NonRetryableError,
  RetryExhaustedError,
  RetryScheduler,
  classifyError,
  computeBackoffDelay,
  deadLetterQueue,
  executeWithRetry,
  plannedBackoffSchedule,
  resolvePolicy,
  type OperationClass,
  type RetryAttempt,
} from '@/lib/retry';

/** Deterministic stand-in for `setTimeout` that records what it was asked to wait. */
function createFakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

/** Jitter source pinned to 0.5 so `full` jitter yields exactly half the ceiling. */
const HALF = () => 0.5;

function options(
  overrides: Partial<Parameters<RetryScheduler['execute']>[1]> = {},
): Parameters<RetryScheduler['execute']>[1] {
  const { sleep } = createFakeSleep();
  return {
    operationClass: 'http_request',
    operationId: 'op_test',
    sleep,
    random: HALF,
    ...overrides,
  };
}

describe('Retry policy and backoff', () => {
  describe('resolvePolicy', () => {
    it('should apply class defaults when no overrides are given', () => {
      const policy = resolvePolicy('http_request');

      expect(policy.maxRetries).toBe(3);
      expect(policy.initialDelayMs).toBe(1000);
      expect(policy.retryable).toBe(true);
    });

    it('should merge per-call overrides over class defaults', () => {
      const policy = resolvePolicy('transaction', { maxRetries: 0 });

      expect(policy.maxRetries).toBe(0);
      // Untouched fields keep the transaction defaults.
      expect(policy.initialDelayMs).toBe(5000);
    });

    it('should reject a maxDelayMs below initialDelayMs', () => {
      expect(() => resolvePolicy('sync', { initialDelayMs: 5000, maxDelayMs: 1000 })).toThrow(
        /maxDelayMs/,
      );
    });

    it('should reject a negative retry budget', () => {
      expect(() => resolvePolicy('sync', { maxRetries: -1 })).toThrow(/maxRetries/);
    });

    it('should not let a caller mutate the shared defaults', () => {
      const policy = resolvePolicy('webhook');

      expect(Object.isFrozen(policy)).toBe(true);
      // A silent no-op would leave the module-level defaults reachable and mutable.
      expect(() => {
        (policy as { maxRetries: number }).maxRetries = 99;
      }).toThrow(TypeError);

      expect(resolvePolicy('webhook').maxRetries).toBe(5);
    });
  });

  describe('computeBackoffDelay', () => {
    const policy = resolvePolicy('http_request', { jitter: 'none' });

    it('should grow exponentially from initialDelayMs', () => {
      expect(computeBackoffDelay(0, policy)).toBe(1000);
      expect(computeBackoffDelay(1, policy)).toBe(2000);
      expect(computeBackoffDelay(2, policy)).toBe(4000);
    });

    it('should cap at maxDelayMs', () => {
      expect(computeBackoffDelay(50, policy)).toBe(30000);
    });

    it('should apply full jitter within the capped ceiling', () => {
      const jittered = resolvePolicy('http_request', { jitter: 'full' });

      // 0.5 of the 2000ms exponential term for attempt 1.
      expect(computeBackoffDelay(1, jittered, HALF)).toBe(1000);
      // A jitter source of 0 yields the floor of the range.
      expect(computeBackoffDelay(1, jittered, () => 0)).toBe(0);
      // A jitter source near 1 stays under the ceiling.
      expect(computeBackoffDelay(1, jittered, () => 0.999)).toBeLessThan(2000);
    });

    it('should never exceed maxDelayMs even with maximum jitter', () => {
      const jittered = resolvePolicy('http_request', { jitter: 'full' });

      expect(computeBackoffDelay(99, jittered, () => 0.999999)).toBeLessThanOrEqual(30000);
    });

    it('should treat a negative attempt index as the first retry', () => {
      expect(computeBackoffDelay(-5, policy)).toBe(1000);
    });

    it('should produce a deterministic plan of maxRetries delays', () => {
      const plan = plannedBackoffSchedule(resolvePolicy('http_request'));

      expect(plan).toEqual([1000, 2000, 4000]);
    });
  });
});

describe('Error classification', () => {
  it('should classify transient HTTP statuses as retryable', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const result = classifyError(new ApiError('boom', { status }));

      expect(result.kind).toBe('retryable');
      expect(result.retryable).toBe(true);
      expect(result.status).toBe(status);
    }
  });

  it('should classify client HTTP statuses as permanent', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const result = classifyError(new ApiError('nope', { status }));

      expect(result.kind).toBe('permanent');
      expect(result.retryable).toBe(false);
    }
  });

  it('should treat a caller abort as permanent', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    expect(classifyError(abort).kind).toBe('permanent');
  });

  it('should honour an explicit NonRetryableError over a retryable status', () => {
    const error = new NonRetryableError('transaction failed simulation', {
      cause: new ApiError('server hiccup', { status: 503 }),
    });

    const result = classifyError(error);

    expect(result.kind).toBe('permanent');
    expect(result.reason).toMatch(/simulation/);
  });

  it('should read a status from a response-shaped error', () => {
    const result = classifyError({ response: { status: 503 } });

    expect(result.kind).toBe('retryable');
  });

  it('should classify a network failure as retryable', () => {
    expect(classifyError(new Error('Failed to fetch')).kind).toBe('retryable');
  });

  it('should classify a validation failure as permanent', () => {
    expect(classifyError(new Error('Invalid transaction payload')).kind).toBe('permanent');
  });

  it('should fall back to retryable for an unrecognised error', () => {
    const result = classifyError(new Error('something odd'));

    expect(result.kind).toBe('retryable');
    expect(result.reason).toMatch(/Unclassified/);
  });
});

describe('RetryScheduler success after retry', () => {
  it('should return the value once a retry succeeds', async () => {
    const { sleep, waits } = createFakeSleep();
    const scheduler = new RetryScheduler();
    let calls = 0;

    const value = await scheduler.execute(
      async (attempt) => {
        calls += 1;
        if (attempt < 2) {
          throw new ApiError('upstream unavailable', { status: 503 });
        }
        return `ok-after-${attempt}`;
      },
      {
        operationClass: 'http_request',
        operationId: 'op_recovers',
        sleep,
        random: HALF,
      },
    );

    expect(value).toBe('ok-after-2');
    expect(calls).toBe(3);
  });

  it('should not sleep at all when the first attempt succeeds', async () => {
    const { sleep, waits } = createFakeSleep();
    const scheduler = new RetryScheduler();
    let calls = 0;

    const value = await scheduler.execute(
      async () => {
        calls += 1;
        return 'immediate';
      },
      { operationClass: 'http_request', operationId: 'op_first_try', sleep, random: HALF },
    );

    expect(value).toBe('immediate');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('should wait with exponential backoff between attempts', async () => {
    const { sleep, waits } = createFakeSleep();
    const scheduler = new RetryScheduler();

    await scheduler.execute(
      async (attempt) => {
        if (attempt < 2) throw new ApiError('flaky', { status: 500 });
        return 'done';
      },
      {
        operationClass: 'http_request',
        operationId: 'op_backoff',
        sleep,
        random: () => 1,
        // jitter 'none' via a class whose policy we override for determinism.
        policy: { jitter: 'none' },
      },
    );

    expect(waits).toEqual([1000, 2000]);
  });

  it('should not dead-letter a recovered operation', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();

    await scheduler.execute(
      async (attempt) => {
        if (attempt < 1) throw new ApiError('transient', { status: 429 });
        return 'ok';
      },
      {
        operationClass: 'webhook',
        operationId: 'op_recovered',
        sleep,
        random: HALF,
        deadLetterQueue: queue,
      },
    );

    expect(queue.list()).toHaveLength(0);
    expect(queue.stats().dropped).toBe(0);
  });
});

describe('RetryScheduler retry exhaustion', () => {
  it('should throw RetryExhaustedError after using the full budget', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();
    let calls = 0;

    const promise = scheduler.execute(
      async () => {
        calls += 1;
        throw new ApiError('still down', { status: 503 });
      },
      {
        operationClass: 'http_request',
        operationId: 'op_exhausted',
        sleep,
        random: HALF,
        policy: { maxRetries: 2 },
        deadLetterQueue: queue,
      },
    );

    await expect(promise).rejects.toBeInstanceOf(RetryExhaustedError);
    // 1 initial attempt + 2 retries.
    expect(calls).toBe(3);
  });

  it('should make the exhausted failure visible as a dead-letter record', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();

    await expect(
      scheduler.execute(async () => {
        throw new ApiError('still down', { status: 503 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_visible',
        sleep,
        random: HALF,
        policy: { maxRetries: 1 },
        context: { wallet: 'GABC' },
        deadLetterQueue: queue,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    const [record] = queue.list();

    expect(record).toBeDefined();
    expect(record.operationId).toBe('op_visible');
    expect(record.reason).toBe('retries_exhausted');
    expect(record.attemptsCount).toBe(2);
    expect(record.classification.status).toBe(503);
    expect(record.context).toEqual({ wallet: 'GABC' });
  });

  it('should record every attempt with its own classification', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();

    await expect(
      scheduler.execute(async (attempt) => {
        throw new ApiError(`fail ${attempt}`, { status: 500 });
      }, {
        operationClass: 'rpc',
        operationId: 'op_history',
        sleep,
        random: HALF,
        policy: { maxRetries: 2 },
        deadLetterQueue: queue,
      }),
    ).rejects.toThrow(RetryExhaustedError);

    const [record] = queue.list();

    expect(record.attempts).toHaveLength(3);
    expect(record.attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
    expect(record.attempts[0].classification.retryable).toBe(true);
    // The final attempt has no follow-up wait.
    expect(record.attempts[2].waitedMs).toBeUndefined();
  });

  it('should link the thrown error to its dead-letter record', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();

    let thrown: unknown;
    try {
      await scheduler.execute(async () => {
        throw new ApiError('down', { status: 503 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_linked',
        sleep,
        random: HALF,
        policy: { maxRetries: 0 },
        deadLetterQueue: queue,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RetryExhaustedError);
    const exhausted = thrown as RetryExhaustedError;
    expect(exhausted.deadLetterId).toBeDefined();
    expect(queue.get(exhausted.deadLetterId!)).not.toBeNull();
  });

  it('should honour maxRetries of 0 as a single attempt', async () => {
    const { sleep } = createFakeSleep();
    const scheduler = new RetryScheduler(new DeadLetterQueue(new InMemoryDeadLetterStore(10)));
    let calls = 0;

    await expect(
      scheduler.execute(async () => {
        calls += 1;
        throw new ApiError('down', { status: 503 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_single',
        sleep,
        random: HALF,
        policy: { maxRetries: 0 },
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(calls).toBe(1);
  });

  it('should rethrow the original error when wrapping is disabled', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();
    const original = new ApiError('down', { status: 503 });

    await expect(
      scheduler.execute(async () => {
        throw original;
      }, {
        operationClass: 'http_request',
        operationId: 'op_unwrapped',
        sleep,
        random: HALF,
        policy: { maxRetries: 1 },
        wrapExhaustedError: false,
        deadLetterQueue: queue,
      }),
    ).rejects.toBe(original);

    // The failure is still recorded even though the error type is unchanged.
    expect(queue.list()).toHaveLength(1);
  });
});

describe('RetryScheduler non-retryable failures', () => {
  it('should not retry a permanent failure', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep, waits } = createFakeSleep();
    let calls = 0;

    await expect(
      scheduler.execute(async () => {
        calls += 1;
        throw new ApiError('validation failed', { status: 422 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_permanent',
        sleep,
        random: HALF,
        deadLetterQueue: queue,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('should dead-letter a permanent failure as non_retryable', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();

    await expect(
      scheduler.execute(async () => {
        throw new ApiError('unauthorized', { status: 403 });
      }, {
        operationClass: 'transaction',
        operationId: 'op_forbidden',
        sleep,
        random: HALF,
        deadLetterQueue: queue,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    const [record] = queue.list();

    expect(record.reason).toBe('non_retryable');
    expect(record.attemptsCount).toBe(1);
    expect(record.classification.status).toBe(403);
  });

  it('should not retry when the operation class is marked non-retryable', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep, waits } = createFakeSleep();
    let calls = 0;

    await expect(
      scheduler.execute(async () => {
        calls += 1;
        // Transient-looking, but the class forbids retrying.
        throw new ApiError('transient', { status: 503 });
      }, {
        operationClass: 'transaction',
        operationId: 'op_class_locked',
        sleep,
        random: HALF,
        policy: { retryable: false },
        deadLetterQueue: queue,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(queue.list()[0].reason).toBe('non_retryable');
  });

  it('should stop retrying mid-budget when a later error is permanent', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const scheduler = new RetryScheduler(queue);
    const { sleep } = createFakeSleep();
    let calls = 0;

    await expect(
      scheduler.execute(async (attempt) => {
        calls += 1;
        if (attempt === 0) throw new ApiError('transient', { status: 503 });
        throw new ApiError('now permanent', { status: 400 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_flips',
        sleep,
        random: HALF,
        policy: { maxRetries: 5 },
        deadLetterQueue: queue,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    // Stops at 2 attempts even though 5 retries were permitted.
    expect(calls).toBe(2);
    expect(queue.list()[0].reason).toBe('non_retryable');
  });
});

describe('RetryScheduler observers and non-throwing variant', () => {
  it('should report state transitions through to success', async () => {
    const { sleep } = createFakeSleep();
    const states: string[] = [];

    await new RetryScheduler().execute(
      async (attempt) => {
        if (attempt < 1) throw new ApiError('transient', { status: 500 });
        return 'ok';
      },
      {
        operationClass: 'http_request',
        operationId: 'op_states',
        sleep,
        random: HALF,
        onStateChange: (state) => states.push(state),
      },
    );

    expect(states[0]).toBe('running');
    expect(states).toContain('waiting');
    expect(states[states.length - 1]).toBe('succeeded');
  });

  it('should report a dead-letter id through onDeadLetter', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const { sleep } = createFakeSleep();
    let reported: string | undefined;

    await expect(
      new RetryScheduler(queue).execute(async () => {
        throw new ApiError('down', { status: 503 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_notify',
        sleep,
        random: HALF,
        policy: { maxRetries: 0 },
        onDeadLetter: (id) => {
          reported = id;
        },
        deadLetterQueue: queue,
      }),
    ).rejects.toThrow(RetryExhaustedError);

    expect(reported).toBeDefined();
    expect(queue.get(reported!)).not.toBeNull();
  });

  it('should return a failure result instead of throwing via attempt', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const { sleep } = createFakeSleep();

    const result = await new RetryScheduler(queue).attempt(
      async () => {
        throw new ApiError('down', { status: 503 });
      },
      {
        operationClass: 'http_request',
        operationId: 'op_attempt',
        sleep,
        random: HALF,
        policy: { maxRetries: 1 },
        deadLetterQueue: queue,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RetryExhaustedError);
      expect(result.deadLetterId).toBeDefined();
      expect(result.attempts).toBe(2);
    }
  });

  it('should return a success result via attempt', async () => {
    const { sleep } = createFakeSleep();

    const result = await new RetryScheduler().attempt(
      async () => 'value',
      { operationClass: 'http_request', operationId: 'op_attempt_ok', sleep, random: HALF },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.value).toBe('value');
      expect(result.result.attempts).toBe(1);
    }
  });

  it('should reject an unknown operation class', async () => {
    await expect(
      executeWithRetry(async () => 'x', {
        operationClass: 'nonsense' as OperationClass,
        operationId: 'op_bad',
      }),
    ).rejects.toThrow(/Unknown operation class/);
  });
});

describe('DeadLetterQueue maintainer visibility', () => {
  it('should hide resolved records from the default listing', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const classification = classifyError(new ApiError('down', { status: 503 }));

    const a = queue.record({
      operationClass: 'rpc', operationId: 'op_a', reason: 'retries_exhausted',
      classification, attempts: [],
    });
    const b = queue.record({
      operationClass: 'rpc', operationId: 'op_b', reason: 'retries_exhausted',
      classification, attempts: [],
    });

    queue.resolve(a.id, 'acknowledged', 'known issue');

    expect(queue.list().map((r) => r.operationId)).toEqual(['op_b']);
    expect(queue.list({ includeResolved: true })).toHaveLength(2);
    expect(b.resolution).toBeUndefined();
  });

  it('should refuse to resolve a record twice', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const record = queue.record({
      operationClass: 'sync', operationId: 'op_dup', reason: 'abandoned',
      classification: classifyError(new Error('x')), attempts: [],
    });

    queue.resolve(record.id, 'discarded');

    expect(() => queue.resolve(record.id, 'replayed')).toThrow(/already resolved/);
  });

  it('should filter by operation class, reason, and operation id', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const classification = classifyError(new Error('x'));

    queue.record({ operationClass: 'rpc', operationId: 'op_1', reason: 'retries_exhausted', classification, attempts: [] });
    queue.record({ operationClass: 'sync', operationId: 'op_2', reason: 'non_retryable', classification, attempts: [] });
    queue.record({ operationClass: 'rpc', operationId: 'op_3', reason: 'non_retryable', classification, attempts: [] });

    expect(queue.list({ operationClass: 'rpc' })).toHaveLength(2);
    expect(queue.list({ reason: 'non_retryable' })).toHaveLength(2);
    expect(queue.list({ operationId: 'op_1' })).toHaveLength(1);
  });

  it('should respect a limit on the listing', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const classification = classifyError(new Error('x'));

    for (let i = 0; i < 5; i += 1) {
      queue.record({
        operationClass: 'rpc', operationId: `op_${i}`, reason: 'retries_exhausted',
        classification, attempts: [],
      });
    }

    expect(queue.list({ limit: 2 })).toHaveLength(2);
  });

  it('should aggregate counts for a dashboard', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const classification = classifyError(new Error('x'));

    const a = queue.record({ operationClass: 'rpc', operationId: 'a', reason: 'retries_exhausted', classification, attempts: [] });
    queue.record({ operationClass: 'rpc', operationId: 'b', reason: 'non_retryable', classification, attempts: [] });
    queue.resolve(a.id, 'replayed');

    const stats = queue.stats();

    expect(stats.total).toBe(2);
    expect(stats.unresolved).toBe(1);
    expect(stats.resolved).toBe(1);
    expect(stats.byReason.retries_exhausted).toBe(1);
    expect(stats.byReason.non_retryable).toBe(1);
    expect(stats.byOperationClass.rpc).toBe(2);
  });

  it('should bound capacity and count evicted records rather than dropping silently', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(3));
    const classification = classifyError(new Error('x'));

    for (let i = 0; i < 6; i += 1) {
      queue.record({
        operationClass: 'rpc', operationId: `op_${i}`, reason: 'retries_exhausted',
        classification, attempts: [],
      });
    }

    expect(queue.stats().total).toBe(3);
    expect(queue.stats().dropped).toBe(3);
  });

  it('should evict resolved records before unresolved ones', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(2));
    const classification = classifyError(new Error('x'));
    const first = queue.record({
      operationClass: 'rpc', operationId: 'oldest', reason: 'retries_exhausted',
      classification, attempts: [],
    });

    queue.resolve(first.id, 'acknowledged');
    queue.record({ operationClass: 'rpc', operationId: 'live_1', reason: 'retries_exhausted', classification, attempts: [] });
    queue.record({ operationClass: 'rpc', operationId: 'live_2', reason: 'retries_exhausted', classification, attempts: [] });

    const remaining = queue.list({ includeResolved: true }).map((r) => r.operationId);

    expect(remaining).toContain('live_1');
    expect(remaining).toContain('live_2');
    expect(remaining).not.toContain('oldest');
  });

  it('should synthesise an attempt entry when none were recorded', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const record = queue.record({
      operationClass: 'rpc', operationId: 'op_no_attempts', reason: 'abandoned',
      classification: classifyError(new Error('x')), attempts: [],
    });

    expect(record.attemptsCount).toBe(1);
    expect(record.attempts[0].classification.reason).toBeDefined();
  });

  it('should return null when resolving an unknown id', () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));

    expect(queue.resolve('missing', 'replayed')).toBeNull();
  });

  it('should reject a non-positive capacity', () => {
    expect(() => new InMemoryDeadLetterStore(0)).toThrow(/positive/);
  });

  it('should expose a shared process-wide queue that is clearable', () => {
    const classification = classifyError(new Error('x'));
    deadLetterQueue.record({
      operationClass: 'rpc', operationId: 'shared', reason: 'abandoned',
      classification, attempts: [],
    });

    expect(deadLetterQueue.stats().total).toBeGreaterThan(0);

    deadLetterQueue.clear();

    expect(deadLetterQueue.stats().total).toBe(0);
  });
});

describe('Retry attempt records', () => {
  it('should carry the classification and wait for each attempt', async () => {
    const queue = new DeadLetterQueue(new InMemoryDeadLetterStore(10));
    const { sleep } = createFakeSleep();
    const seen: RetryAttempt[] = [];

    await expect(
      new RetryScheduler(queue).execute(async () => {
        throw new ApiError('down', { status: 503 });
      }, {
        operationClass: 'http_request',
        operationId: 'op_attempts',
        sleep,
        random: HALF,
        policy: { maxRetries: 1, jitter: 'none' },
        onAttempt: (attempt) => seen.push(attempt),
        deadLetterQueue: queue,
      }),
    ).rejects.toThrow(RetryExhaustedError);

    expect(seen).toHaveLength(2);
    expect(seen[0].waitedMs).toBe(1000);
    expect(seen[1].waitedMs).toBeUndefined();
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
