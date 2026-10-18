/**
 * Offline submission queue + background sync tests.
 *
 * Covers queue serialization/deserialization, FIFO replay semantics
 * (success, poison 4xx, retryable 5xx, still-offline), and the sync triggers
 * wired into PWAManager.
 */

import PWAManager, {
  OFFLINE_QUEUE_CHANGE_EVENT,
  OFFLINE_QUEUE_FLUSHED_MESSAGE,
  OFFLINE_QUEUE_FLUSH_MESSAGE,
  OFFLINE_QUEUE_STORAGE_KEY,
  OFFLINE_QUEUE_SYNCED_EVENT,
  OFFLINE_QUEUE_SYNC_TAG,
  OFFLINE_SUBMISSION_MAX_ATTEMPTS,
  createLocalStorageQueueStorage,
  createMemoryQueueStorage,
  createOfflineQueue,
  deserializeOfflineQueue,
  flushOfflineQueue,
  serializeOfflineQueue,
  type OfflineQueueStorage,
  type OfflineSubmission,
} from '@/lib/pwa-utils';
import { subscribeDomainEvent } from '@/lib/domain-events';

const makeSubmission = (overrides: Partial<OfflineSubmission> = {}): OfflineSubmission => ({
  id: 'sub-1',
  url: '/api/bug-reports',
  method: 'POST',
  body: JSON.stringify({ title: 'Broken marketplace filter' }),
  headers: { 'Content-Type': 'application/json' },
  label: 'bug report',
  createdAt: '2026-01-01T00:00:00.000Z',
  attempts: 0,
  ...overrides,
});

/** Queue with deterministic ids/timestamps so replay assertions stay readable. */
const createTestQueue = (storage: OfflineQueueStorage = createMemoryQueueStorage()) => {
  let counter = 0;

  return createOfflineQueue(storage, {
    idFactory: () => `sub-${++counter}`,
    now: () => Date.parse('2026-02-02T10:00:00.000Z'),
  });
};

const jsonResponse = (status: number) => ({ status } as Response);

const readStoredQueue = () =>
  deserializeOfflineQueue(window.localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY));

const originalFetch: unknown = (global as any).fetch;

const restoreFetch = () => {
  (global as any).fetch = originalFetch;
};

const makeRegistration = (overrides: Record<string, unknown> = {}) => ({
  addEventListener: jest.fn(),
  active: null,
  installing: null,
  waiting: null,
  ...overrides,
});

const stubServiceWorker = (
  registration: Record<string, unknown>,
  swOverrides: Record<string, unknown> = {},
) => {
  const serviceWorker = {
    register: jest.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
    getRegistration: jest.fn().mockResolvedValue(registration),
    addEventListener: jest.fn(),
    controller: null,
    ...swOverrides,
  };

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: serviceWorker,
  });

  return serviceWorker;
};

/** PWAManager is a singleton, so tests that assert on registration state reset it. */
const createFreshManager = () => {
  (PWAManager as unknown as { instance?: PWAManager }).instance = undefined;
  return PWAManager.getInstance();
};

describe('offline queue serialization', () => {
  it('round-trips submissions', () => {
    const serialized = serializeOfflineQueue([
      makeSubmission(),
      makeSubmission({ id: 'sub-2', url: '/api/feedback', method: 'put', attempts: 2 }),
    ]);

    const restored = deserializeOfflineQueue(serialized);

    expect(restored).toHaveLength(2);
    expect(restored[0]).toEqual(makeSubmission());
    expect(restored[1]).toEqual(
      makeSubmission({ id: 'sub-2', url: '/api/feedback', method: 'PUT', attempts: 2 }),
    );
  });

  it('preserves a detected state conflict across refreshes', () => {
    const conflicted = makeSubmission({ status: 'conflict', lastError: 'HTTP 412' });
    expect(deserializeOfflineQueue(serializeOfflineQueue([conflicted]))).toEqual([conflicted]);
  });

  it('is tolerant of missing, empty or malformed payloads', () => {
    expect(deserializeOfflineQueue(null)).toEqual([]);
    expect(deserializeOfflineQueue(undefined)).toEqual([]);
    expect(deserializeOfflineQueue('')).toEqual([]);
    expect(deserializeOfflineQueue('not json at all')).toEqual([]);
    expect(deserializeOfflineQueue('{"id":"sub-1"}')).toEqual([]);
    expect(deserializeOfflineQueue('null')).toEqual([]);
  });

  it('drops corrupt entries but keeps the valid siblings', () => {
    const raw = JSON.stringify([
      makeSubmission(),
      null,
      42,
      { id: '', url: '/api/feedback', method: 'POST', body: '{}' },
      { id: 'sub-3', url: '', method: 'POST', body: '{}' },
      { id: 'sub-4', url: '/api/feedback', method: 'POST' },
    ]);

    expect(deserializeOfflineQueue(raw).map((item) => item.id)).toEqual(['sub-1']);
  });

  it('coerces attempt counters and backfills defaults for legacy entries', () => {
    const raw = JSON.stringify([
      { id: 'sub-a', url: '/api/feedback', method: 'POST', body: '{}', attempts: -3 },
      { id: 'sub-b', url: '/api/feedback', method: 'POST', body: '{}', attempts: 2.9 },
    ]);

    const restored = deserializeOfflineQueue(raw);

    expect(restored[0].attempts).toBe(0);
    expect(restored[1].attempts).toBe(2);
    expect(restored[1].label).toBe('submission');
    expect(restored[1].createdAt).toBe(new Date(0).toISOString());
    expect(restored[1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('never emits a non-array payload', () => {
    expect(serializeOfflineQueue(undefined as unknown as OfflineSubmission[])).toBe('[]');
    expect(deserializeOfflineQueue(serializeOfflineQueue([]))).toEqual([]);
  });
});

describe('offline queue operations', () => {
  it('enqueues and normalizes the queued request', async () => {
    const storage = createMemoryQueueStorage();
    const queue = createTestQueue(storage);

    const submission = await queue.enqueue({
      url: '/api/bug-reports',
      body: { title: 'Offline report' },
      label: 'bug report',
    });

    expect(submission.id).toBe('sub-1');
    expect(submission.method).toBe('POST');
    expect(submission.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(submission.body).toBe(JSON.stringify({ title: 'Offline report' }));
    expect(submission.label).toBe('bug report');
    expect(submission.attempts).toBe(0);
    expect(submission.createdAt).toBe('2026-02-02T10:00:00.000Z');
    expect(deserializeOfflineQueue(storage.read() as string)).toHaveLength(1);
  });

  it('rejects submissions without a url and uppercases custom methods', async () => {
    const queue = createTestQueue();

    await expect(queue.enqueue({ url: '', body: {} })).rejects.toThrow(
      'Offline submission requires a non-empty url',
    );

    const submission = await queue.enqueue({
      url: '/api/feedback',
      method: 'patch',
      body: 'raw-body',
      headers: { 'X-Request-Id': 'abc' },
    });

    expect(submission.method).toBe('PATCH');
    expect(submission.body).toBe('raw-body');
    expect(submission.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Request-Id': 'abc',
    });
  });

  it('keeps insertion order and supports size/remove/clear', async () => {
    const queue = createTestQueue();

    await queue.enqueue({ url: '/first', body: {} });
    await queue.enqueue({ url: '/second', body: {} });
    const third = await queue.enqueue({ url: '/third', body: {} });

    expect((await queue.list()).map((item) => item.url)).toEqual([
      '/first',
      '/second',
      '/third',
    ]);
    expect(await queue.size()).toBe(3);
    expect(await queue.remove('does-not-exist')).toBe(false);
    expect(await queue.remove(third.id)).toBe(true);
    expect((await queue.list()).map((item) => item.url)).toEqual(['/first', '/second']);

    await queue.clear();
    expect(await queue.size()).toBe(0);
  });

  it('does not lose entries when submissions are enqueued concurrently', async () => {
    const queue = createTestQueue();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) => queue.enqueue({ url: `/api/${index}`, body: {} })),
    );

    expect(await queue.size()).toBe(5);
    expect((await queue.list()).map((item) => item.url)).toEqual([
      '/api/0',
      '/api/1',
      '/api/2',
      '/api/3',
      '/api/4',
    ]);
  });

  it('updates the attempt counter without touching other fields', async () => {
    const queue = createTestQueue();
    const submission = await queue.enqueue({ url: '/api/feedback', body: {} });

    const updated = await queue.update(submission.id, { attempts: 3 });

    expect(updated?.attempts).toBe(3);
    expect(updated?.url).toBe('/api/feedback');
    expect(await queue.update('missing-id', { attempts: 1 })).toBeNull();
  });

  it('persists through localStorage so a reload keeps the queue', async () => {
    const queue = createOfflineQueue(createLocalStorageQueueStorage());
    await queue.enqueue({ url: '/api/bug-reports', body: { title: 'queued' } });

    // A brand new queue instance (as after a page reload) sees the payload.
    const reloaded = createOfflineQueue(createLocalStorageQueueStorage());
    expect(await reloaded.size()).toBe(1);
    expect((await reloaded.list())[0].url).toBe('/api/bug-reports');
  });
});

describe('offline queue replay', () => {
  it('replays submissions in order and removes them once accepted', async () => {
    const queue = createTestQueue();
    await queue.enqueue({ url: '/api/bug-reports', body: { title: 'one' } });
    await queue.enqueue({ url: '/api/feedback', body: { title: 'two' } });

    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(201));
    const result = await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/bug-reports');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'one' }),
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/feedback');
    expect(result).toEqual({ synced: ['sub-1', 'sub-2'], dropped: [], remaining: 0 });
    expect(await queue.size()).toBe(0);
  });

  it('drops poison 4xx payloads so they cannot block the queue', async () => {
    const queue = createTestQueue();
    await queue.enqueue({ url: '/api/rejected', body: {} });
    await queue.enqueue({ url: '/api/accepted', body: {} });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(422))
      .mockResolvedValueOnce(jsonResponse(200));

    const result = await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);

    expect(result.synced).toEqual(['sub-2']);
    expect(result.dropped).toEqual(['sub-1']);
    expect(result.remaining).toBe(0);
    expect(await queue.size()).toBe(0);
  });

  it('holds stale-state responses for an explicit retry or discard choice', async () => {
    const queue = createTestQueue();
    const submission = await queue.enqueue({
      url: '/api/loan/repay',
      headers: { 'If-Match': 'version-4' },
      body: { amount: '10' },
    });
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(412));

    const result = await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);
    const held = (await queue.list())[0];

    expect(result.remaining).toBe(1);
    expect(held).toMatchObject({ id: submission.id, status: 'conflict', attempts: 0 });
    expect(held.lastError).toContain('HTTP 412');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await queue.update(submission.id, { status: 'pending', attempts: 0, lastError: '' });
    const retryFetch = jest.fn().mockResolvedValue(jsonResponse(204));
    await flushOfflineQueue(queue, retryFetch as unknown as typeof fetch);
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(await queue.size()).toBe(0);
  });

  it('keeps the entry and stops the flush when the server fails', async () => {
    const queue = createTestQueue();
    await queue.enqueue({ url: '/api/bug-reports', body: {} });
    await queue.enqueue({ url: '/api/feedback', body: {} });

    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(503));
    const result = await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);

    // Order is preserved: the second submission is not attempted out of order.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ synced: [], dropped: [], remaining: 2 });
    expect((await queue.list())[0].attempts).toBe(1);
    expect((await queue.list())[1].attempts).toBe(0);
  });

  it(`drops entries after ${OFFLINE_SUBMISSION_MAX_ATTEMPTS} failed attempts`, async () => {
    const queue = createTestQueue();
    const submission = await queue.enqueue({ url: '/api/bug-reports', body: {} });
    await queue.update(submission.id, { attempts: OFFLINE_SUBMISSION_MAX_ATTEMPTS - 1 });

    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(500));
    const result = await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);

    expect(result.dropped).toEqual([submission.id]);
    expect(result.remaining).toBe(0);
  });

  it('leaves the queue untouched when the network is still unreachable', async () => {
    const queue = createTestQueue();
    await queue.enqueue({ url: '/api/bug-reports', body: {} });
    await queue.enqueue({ url: '/api/feedback', body: {} });

    const fetchMock = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ synced: [], dropped: [], remaining: 2 });
    expect((await queue.list()).every((item) => item.attempts === 0)).toBe(true);
  });

  it('sends no body for GET submissions', async () => {
    const queue = createTestQueue();
    await queue.enqueue({ url: '/api/analytics/refresh', method: 'GET', body: {} });

    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(204));
    await flushOfflineQueue(queue, fetchMock as unknown as typeof fetch);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('reports the backlog without calling fetch when fetch is unavailable', async () => {
    const queue = createTestQueue();
    await queue.enqueue({ url: '/api/bug-reports', body: {} });

    const result = await flushOfflineQueue(queue, undefined as unknown as typeof fetch);

    expect(result).toEqual({ synced: [], dropped: [], remaining: 1 });
  });
});

describe('PWAManager offline submissions', () => {
  beforeEach(() => {
    window.localStorage.clear();
    restoreFetch();
  });

  afterAll(() => {
    restoreFetch();
  });

  it('queues a submission, persists it and announces the new backlog', async () => {
    const changes: number[] = [];
    // Consumed through the versioned contract rather than a raw CustomEvent
    // cast: the payload is only delivered because it validated.
    const unsubscribe = subscribeDomainEvent('offline-queue-change', (payload) => {
      changes.push(payload.pending);
    });

    try {
      const manager = createFreshManager();
      const submission = await manager.queueOfflineSubmission({
        url: '/api/bug-reports',
        body: { title: 'Offline bug' },
        label: 'bug report',
      });

      expect(submission.url).toBe('/api/bug-reports');
      expect(await manager.getPendingSubmissionCount()).toBe(1);
      expect(readStoredQueue()).toHaveLength(1);
      expect(changes).toEqual([1]);
    } finally {
      unsubscribe();
    }
  });

  it('registers the background sync tag when the browser supports it', async () => {
    const register = jest.fn().mockResolvedValue(undefined);
    stubServiceWorker(makeRegistration({ sync: { register } }));

    const registered = await createFreshManager().registerBackgroundSync();

    expect(registered).toBe(true);
    expect(register).toHaveBeenCalledWith(OFFLINE_QUEUE_SYNC_TAG);
  });

  it('degrades gracefully when the Background Sync API is missing', async () => {
    stubServiceWorker(makeRegistration());

    await expect(createFreshManager().registerBackgroundSync()).resolves.toBe(false);
  });

  it('flushes the queue when the browser comes back online', async () => {
    stubServiceWorker(makeRegistration({ sync: { register: jest.fn() } }));

    const synced: string[][] = [];
    const unsubscribe = subscribeDomainEvent('offline-queue-synced', (payload) => {
      synced.push(payload.synced);
    });

    try {
      const manager = createFreshManager();
      await manager.queueOfflineSubmission({ url: '/api/bug-reports', body: {} });
      await manager.queueOfflineSubmission({ url: '/api/feedback', body: {} });

      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200));
      (global as any).fetch = fetchMock;

      manager.setupBackgroundSync();
      window.dispatchEvent(new Event('online'));

      // Let the queued flush settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(synced).toHaveLength(1);
      expect(synced[0]).toHaveLength(2);
      expect(await manager.getPendingSubmissionCount()).toBe(0);
      expect(readStoredQueue()).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('does not hit the network when there is nothing queued', async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    const result = await createFreshManager().flushOfflineSubmissions();

    expect(result).toEqual({ synced: [], dropped: [], remaining: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replays on a service worker sync request and acknowledges the outcome', async () => {
    const serviceWorker = stubServiceWorker(makeRegistration({ sync: { register: jest.fn() } }));
    const manager = createFreshManager();

    await manager.queueOfflineSubmission({ url: '/api/bug-reports', body: {} });

    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(202));
    (global as any).fetch = fetchMock;

    manager.setupBackgroundSync();

    const messageHandler = serviceWorker.addEventListener.mock.calls.find(
      ([type]) => type === 'message',
    )?.[1] as ((event: MessageEvent) => void) | undefined;

    expect(typeof messageHandler).toBe('function');

    const postMessage = jest.fn();
    messageHandler?.({
      data: { type: OFFLINE_QUEUE_FLUSH_MESSAGE },
      ports: [{ postMessage }],
    } as unknown as MessageEvent);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: OFFLINE_QUEUE_FLUSHED_MESSAGE,
      result: { synced: [expect.any(String)], dropped: [], remaining: 0 },
    });
    expect(await manager.getPendingSubmissionCount()).toBe(0);
  });
});

describe('PWAManager service worker lifecycle and update handling', () => {
  beforeEach(() => {
    window.localStorage.clear();
    restoreFetch();
  });

  afterAll(() => {
    restoreFetch();
  });

  it('detects a waiting worker on initialization and fires sw-update event', async () => {
    const waitingWorker = { postMessage: jest.fn() };
    const registration = makeRegistration({ waiting: waitingWorker });
    stubServiceWorker(registration, { controller: {} });

    const updates: boolean[] = [];
    const unsubscribe = subscribeDomainEvent('sw-update', (payload) => {
      updates.push(payload.available);
    });

    try {
      const manager = createFreshManager();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(updates).toEqual([true]);
      expect(manager.hasWaitingWorker()).toBe(true);
      expect(manager.getRegistration()).toBe(registration);
    } finally {
      unsubscribe();
    }
  });

  it('detects updatefound and transition to installed state when controller is present', async () => {
    const listeners: Record<string, Function[]> = {};
    const registration = {
      ...makeRegistration(),
      addEventListener: jest.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      installing: null as any,
    };
    stubServiceWorker(registration, { controller: {} });

    const updates: boolean[] = [];
    const unsubscribe = subscribeDomainEvent('sw-update', (payload) => {
      updates.push(payload.available);
    });

    try {
      createFreshManager();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate updatefound with installing worker
      const workerListeners: Record<string, Function[]> = {};
      const installingWorker = {
        state: 'installing',
        addEventListener: jest.fn((event: string, cb: Function) => {
          workerListeners[event] = workerListeners[event] || [];
          workerListeners[event].push(cb);
        }),
      };
      registration.installing = installingWorker;

      // Trigger updatefound
      listeners['updatefound']?.forEach((cb) => cb());

      // Worker transitions to installed
      installingWorker.state = 'installed';
      workerListeners['statechange']?.forEach((cb) => cb());

      expect(updates).toEqual([true]);
    } finally {
      unsubscribe();
    }
  });

  it('does not fire sw-update when installing worker reaches installed on first install (no controller)', async () => {
    const listeners: Record<string, Function[]> = {};
    const registration = {
      ...makeRegistration(),
      addEventListener: jest.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      installing: null as any,
    };
    // No controller on first install
    stubServiceWorker(registration, { controller: null });

    const updates: boolean[] = [];
    const unsubscribe = subscribeDomainEvent('sw-update', (payload) => {
      updates.push(payload.available);
    });

    try {
      createFreshManager();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const workerListeners: Record<string, Function[]> = {};
      const installingWorker = {
        state: 'installing',
        addEventListener: jest.fn((event: string, cb: Function) => {
          workerListeners[event] = workerListeners[event] || [];
          workerListeners[event].push(cb);
        }),
      };
      registration.installing = installingWorker;
      listeners['updatefound']?.forEach((cb) => cb());

      installingWorker.state = 'installed';
      workerListeners['statechange']?.forEach((cb) => cb());

      expect(updates).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('skipWaiting posts SKIP_WAITING to waiting worker', async () => {
    const postMessage = jest.fn();
    const waitingWorker = { postMessage };
    const registration = makeRegistration({ waiting: waitingWorker });
    stubServiceWorker(registration, { controller: {} });

    const manager = createFreshManager();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await manager.skipWaiting();
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('skipWaiting falls back to navigator.serviceWorker.getRegistration when waiting worker is not cached', async () => {
    const postMessage = jest.fn();
    const waitingWorker = { postMessage };
    const freshRegistration = makeRegistration({ waiting: waitingWorker });

    // Initial register returns registration without waiting worker
    const initialRegistration = makeRegistration({ waiting: null });
    const serviceWorker = stubServiceWorker(initialRegistration, {
      controller: {},
      getRegistration: jest.fn().mockResolvedValue(freshRegistration),
    });

    const manager = createFreshManager();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.hasWaitingWorker()).toBe(false);

    await manager.skipWaiting();
    expect(serviceWorker.getRegistration).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(manager.hasWaitingWorker()).toBe(true);
  });

  it('skipWaiting gracefully handles missing waiting worker without error', async () => {
    const registration = makeRegistration({ waiting: null });
    stubServiceWorker(registration, {
      controller: {},
      getRegistration: jest.fn().mockResolvedValue(registration),
    });

    const manager = createFreshManager();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(manager.skipWaiting()).resolves.not.toThrow();
  });
});

