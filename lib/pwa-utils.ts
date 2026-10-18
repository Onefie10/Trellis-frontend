import { createWindowDelivery, publishDomainEvent } from './domain-events';

interface PWAInstallPrompt {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Offline submission queue.
 *
 * Mutations that happen while the browser is offline (bug reports, feedback,
 * governance comments, ...) are serialized into a durable queue so they can be
 * replayed once connectivity returns. The queue is intentionally free of any
 * IndexedDB dependency: it is persisted as a versioned JSON payload through a
 * small storage adapter, which makes it usable from the page, from a service
 * worker message handler, and from unit tests without a browser.
 *
 * The service worker is only responsible for *waking the page up* through the
 * Background Sync API (see `public/sw.js`); the actual replay happens in the
 * page, which is the only context that can build authenticated requests.
 */
export const OFFLINE_QUEUE_STORAGE_KEY = 'trellis.offline-submissions.v1';
export const OFFLINE_QUEUE_SYNC_TAG = 'offline-submissions';
export const OFFLINE_QUEUE_FLUSH_MESSAGE = 'SYNC_OFFLINE_QUEUE';
export const OFFLINE_QUEUE_FLUSHED_MESSAGE = 'OFFLINE_QUEUE_FLUSHED';
/**
 * Event names are kept here as exported constants for existing consumers, but
 * they are also registry keys. `tests/__tests__/domain-events.test.ts` asserts
 * each constant still matches its catalog entry, so the two cannot drift.
 */
export const OFFLINE_QUEUE_CHANGE_EVENT = 'offline-queue-change';
export const OFFLINE_QUEUE_SYNCED_EVENT = 'offline-queue-synced';
export const OFFLINE_SUBMISSION_MAX_ATTEMPTS = 5;

/** Stamped onto every envelope this module publishes. */
const PWA_EVENT_SOURCE = 'pwa-utils';

/**
 * Validate a payload against its registered schema and only then dispatch it.
 *
 * This is the producer-side guarantee: an event that does not match its schema
 * is never delivered, so `OfflineBanner` and `usePWA` can read the payload
 * without defensive checks. The `typeof window` guard is kept from the
 * previous implementation so the module stays importable during SSR.
 */
function publishPwaEvent<TName extends Parameters<typeof publishDomainEvent>[0]>(
  name: TName,
  payload: Parameters<typeof publishDomainEvent<TName>>[1],
): void {
  if (typeof window === 'undefined') {
    return;
  }

  publishDomainEvent(name, payload, { delivery: createWindowDelivery(), source: PWA_EVENT_SOURCE });
}

export interface OfflineSubmission {
  id: string;
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  label: string;
  createdAt: string;
  attempts: number;
  /** A 409/412 response means the captured state is stale and needs a choice. */
  status?: 'pending' | 'conflict';
  lastError?: string;
}

export interface OfflineSubmissionInput {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  label?: string;
}

export interface OfflineQueueStorage {
  read(): string | null | Promise<string | null>;
  write(value: string | null): void | Promise<void>;
}

export interface OfflineQueue {
  enqueue(input: OfflineSubmissionInput): Promise<OfflineSubmission>;
  list(): Promise<OfflineSubmission[]>;
  size(): Promise<number>;
  update(id: string, patch: { attempts?: number; status?: 'pending' | 'conflict'; lastError?: string }): Promise<OfflineSubmission | null>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface FlushOfflineQueueResult {
  /** Ids that were accepted by the server and removed from the queue. */
  synced: string[];
  /** Ids that were discarded (poison payload or too many attempts). */
  dropped: string[];
  /** How many submissions are still queued. */
  remaining: number;
}

function defaultIdFactory(): string {
  const cryptoRef =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = { 'Content-Type': 'application/json' };

  if (!headers) {
    return normalized;
  }

  Object.keys(headers).forEach((key) => {
    const value = headers[key];
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  });

  return normalized;
}

function normalizeSubmission(
  input: OfflineSubmissionInput,
  id: string,
  now: number,
): OfflineSubmission {
  if (!input || typeof input.url !== 'string' || input.url.trim().length === 0) {
    throw new Error('Offline submission requires a non-empty url');
  }

  const method = (input.method || 'POST').toUpperCase();
  const body =
    typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {});

  return {
    id,
    url: input.url,
    method,
    body,
    headers: normalizeHeaders(input.headers),
    label:
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : 'submission',
    createdAt: new Date(now).toISOString(),
    attempts: 0,
  };
}

/**
 * Rebuild a submission from unknown persisted data. Returns `null` for entries
 * that cannot be replayed so a corrupt payload can never block the queue.
 */
function coerceSubmission(value: unknown): OfflineSubmission | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.id !== 'string' || record.id.length === 0) {
    return null;
  }
  if (typeof record.url !== 'string' || record.url.length === 0) {
    return null;
  }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    return null;
  }
  if (typeof record.body !== 'string') {
    return null;
  }

  const attempts =
    typeof record.attempts === 'number' && Number.isFinite(record.attempts)
      ? Math.max(0, Math.floor(record.attempts))
      : 0;

  return {
    id: record.id,
    url: record.url,
    method: record.method.toUpperCase(),
    body: record.body,
    headers: normalizeHeaders(record.headers as Record<string, string> | undefined),
    label: typeof record.label === 'string' && record.label ? record.label : 'submission',
    createdAt:
      typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    attempts,
    ...(record.status === 'conflict' ? { status: 'conflict' as const } : {}),
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
  };
}

export function serializeOfflineQueue(items: OfflineSubmission[]): string {
  const safeItems = Array.isArray(items) ? items : [];
  const serializable = safeItems
    .map((item) => coerceSubmission(item))
    .filter((item): item is OfflineSubmission => item !== null);

  return JSON.stringify(serializable);
}

export function deserializeOfflineQueue(raw: string | null | undefined): OfflineSubmission[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => coerceSubmission(item))
      .filter((item): item is OfflineSubmission => item !== null);
  } catch {
    return [];
  }
}

/** In-memory storage, used as a fallback (private mode / SSR) and in tests. */
export function createMemoryQueueStorage(initialValue: string | null = null): OfflineQueueStorage {
  let value = initialValue;

  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

/**
 * localStorage-backed storage. Reads and writes never throw: a browser with
 * storage disabled simply degrades to an empty queue instead of breaking the
 * submission flow.
 */
export function createLocalStorageQueueStorage(storage?: Storage): OfflineQueueStorage {
  const resolve = (): Storage | null => {
    if (storage) {
      return storage;
    }

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage;
      }
    } catch {
      // Access to localStorage can throw in restricted browsing modes.
    }

    return null;
  };

  return {
    read: () => {
      const target = resolve();
      if (!target) {
        return null;
      }

      try {
        return target.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    write: (value) => {
      const target = resolve();
      if (!target) {
        return;
      }

      try {
        if (value === null) {
          target.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
        } else {
          target.setItem(OFFLINE_QUEUE_STORAGE_KEY, value);
        }
      } catch {
        // Quota exceeded or storage disabled - the queue stays best-effort.
      }
    },
  };
}

/**
 * FIFO queue. Every operation is serialized through an internal promise chain so
 * concurrent submissions cannot interleave read-modify-write cycles.
 */
export function createOfflineQueue(
  storage: OfflineQueueStorage,
  options: { now?: () => number; idFactory?: () => string } = {},
): OfflineQueue {
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;

  let chain: Promise<unknown> = Promise.resolve();

  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const read = async (): Promise<OfflineSubmission[]> =>
    deserializeOfflineQueue(await storage.read());

  const write = async (items: OfflineSubmission[]): Promise<void> => {
    await storage.write(serializeOfflineQueue(items));
  };

  return {
    enqueue: (input) =>
      withLock(async () => {
        const items = await read();
        const submission = normalizeSubmission(input, idFactory(), now());
        await write([...items, submission]);
        return submission;
      }),
    list: () => withLock(read),
    size: () =>
      withLock(async () => {
        const items = await read();
        return items.length;
      }),
    update: (id, patch) =>
      withLock(async () => {
        const items = await read();
        const index = items.findIndex((item) => item.id === id);

        if (index === -1) {
          return null;
        }

        const attempts =
          typeof patch.attempts === 'number' && Number.isFinite(patch.attempts)
            ? Math.max(0, Math.floor(patch.attempts))
            : items[index].attempts;

        const next = [...items];
        next[index] = {
          ...items[index],
          attempts,
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        };
        await write(next);

        return next[index];
      }),
    remove: (id) =>
      withLock(async () => {
        const items = await read();
        const next = items.filter((item) => item.id !== id);

        if (next.length === items.length) {
          return false;
        }

        await write(next);
        return true;
      }),
    clear: () =>
      withLock(async () => {
        await write([]);
      }),
  };
}

/**
 * Replay queued submissions in FIFO order.
 *
 * - 2xx/3xx: the submission is accepted and removed.
 * - 4xx: the payload can never succeed, so it is dropped instead of blocking
 *   every later submission forever.
 * - 5xx or a network failure: the attempt counter is bumped and the flush stops,
 *   preserving order for the next reconnect.
 */
export async function flushOfflineQueue(
  queue: OfflineQueue,
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
  options: { maxAttempts?: number } = {},
): Promise<FlushOfflineQueueResult> {
  const maxAttempts = options.maxAttempts ?? OFFLINE_SUBMISSION_MAX_ATTEMPTS;

  const result: FlushOfflineQueueResult = { synced: [], dropped: [], remaining: 0 };

  if (typeof fetchImpl !== 'function') {
    result.remaining = await queue.size();
    return result;
  }

  const pending = await queue.list();

  for (const submission of pending) {
    if (submission.status === 'conflict') break;
    let response: Response | null = null;

    try {
      response = await fetchImpl(submission.url, {
        method: submission.method,
        headers: submission.headers,
        body:
          submission.method === 'GET' || submission.method === 'HEAD'
            ? undefined
            : submission.body,
      });
    } catch {
      // Still offline (or the request was blocked) - keep the entry queued.
      break;
    }

    if (response && response.status >= 200 && response.status < 400) {
      await queue.remove(submission.id);
      result.synced.push(submission.id);
      continue;
    }

    if (response && (response.status === 409 || response.status === 412)) {
      await queue.update(submission.id, {
        status: 'conflict',
        lastError: `Server state changed (HTTP ${response.status}). Review current state before retrying.`,
      });
      break;
    }

    if (response && response.status >= 400 && response.status < 500) {
      await queue.remove(submission.id);
      result.dropped.push(submission.id);
      continue;
    }

    const attempts = submission.attempts + 1;

    if (attempts >= maxAttempts) {
      await queue.remove(submission.id);
      result.dropped.push(submission.id);
    } else {
      await queue.update(submission.id, { attempts });
    }

    break;
  }

  result.remaining = await queue.size();
  return result;
}

class PWAManager {
  private static instance: PWAManager;
  private installPrompt: PWAInstallPrompt | null = null;
  private swRegistration: ServiceWorkerRegistration | null = null;
  private deferredPrompt: any = null;
  private offlineQueue: OfflineQueue | null = null;
  private backgroundSyncListenersBound = false;

  private constructor() {
    this.initializeServiceWorker();
    this.setupInstallPrompt();
  }

  public static getInstance(): PWAManager {
    if (!PWAManager.instance) {
      PWAManager.instance = new PWAManager();
    }
    return PWAManager.instance;
  }

  private async initializeServiceWorker(): Promise<void> {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        });

        this.swRegistration = registration;
        console.log('[PWA] Service worker registered successfully');

        if (registration) {
          // Check if an updated worker is already waiting
          if (registration.waiting && navigator.serviceWorker.controller) {
            this.onServiceWorkerUpdate();
          }

          // Listen for updates
          if (typeof registration.addEventListener === 'function') {
            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing;
              if (newWorker && typeof newWorker.addEventListener === 'function') {
                newWorker.addEventListener('statechange', () => {
                  if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    // New content is available
                    this.onServiceWorkerUpdate();
                  }
                });
              }
            });
          }

          // Check for existing updates
          if (registration.active) {
            registration.active.postMessage({ type: 'CHECK_UPDATE' });
          }
        }

      } catch (error) {
        console.error('[PWA] Service worker registration failed:', error);
      }
    }
  }

  private setupInstallPrompt(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredPrompt = e;
        this.onInstallPromptAvailable();
      });

      window.addEventListener('appinstalled', () => {
        console.log('[PWA] App was installed');
        this.onAppInstalled();
      });
    }
  }

  private onServiceWorkerUpdate(): void {
    publishPwaEvent('sw-update', { available: true });
  }

  private onInstallPromptAvailable(): void {
    publishPwaEvent('pwa-install-available', { available: true });
  }

  private onAppInstalled(): void {
    publishPwaEvent('pwa-installed', { installed: true });
  }

  public async promptInstall(): Promise<boolean> {
    if (!this.deferredPrompt) {
      console.log('[PWA] Install prompt not available');
      return false;
    }

    try {
      await this.deferredPrompt.prompt();
      const { outcome } = await this.deferredPrompt.userChoice;
      
      this.deferredPrompt = null;

      if (outcome === 'accepted') {
        console.log('[PWA] User accepted install prompt');
        return true;
      } else {
        console.log('[PWA] User dismissed install prompt');
        return false;
      }
    } catch (error) {
      console.error('[PWA] Error during install prompt:', error);
      return false;
    }
  }

  public async updateServiceWorker(): Promise<void> {
    if (!this.swRegistration) {
      console.log('[PWA] No service worker registration found');
      return;
    }

    try {
      await this.swRegistration.update();
      console.log('[PWA] Service worker update triggered');
    } catch (error) {
      console.error('[PWA] Error updating service worker:', error);
    }
  }

  public async skipWaiting(): Promise<void> {
    if (!this.swRegistration?.waiting) {
      if (typeof window !== 'undefined' && 'serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistration === 'function') {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg?.waiting) {
            this.swRegistration = reg;
          }
        } catch {
          // ignore
        }
      }
    }

    if (!this.swRegistration || !this.swRegistration.waiting) {
      console.log('[PWA] No waiting service worker found');
      return;
    }

    try {
      this.swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
      console.log('[PWA] Skip waiting message sent');
    } catch (error) {
      console.error('[PWA] Error sending skip waiting message:', error);
    }
  }

  public getRegistration(): ServiceWorkerRegistration | null {
    return this.swRegistration;
  }

  public hasWaitingWorker(): boolean {
    return Boolean(this.swRegistration?.waiting);
  }

  public isInstallPromptAvailable(): boolean {
    return this.deferredPrompt !== null;
  }

  public isServiceWorkerSupported(): boolean {
    return typeof window !== 'undefined' && 'serviceWorker' in navigator;
  }

  public async getCacheStats(): Promise<any> {
    if (!this.isServiceWorkerSupported()) {
      return null;
    }

    try {
      const messageChannel = new MessageChannel();
      const promise = new Promise((resolve) => {
        messageChannel.port1.onmessage = (event) => {
          resolve(event.data);
        };
      });

      if (this.swRegistration?.active) {
        this.swRegistration.active.postMessage(
          { type: 'GET_CACHE_STATS' },
          [messageChannel.port2]
        );
      }

      return await promise;
    } catch (error) {
      console.error('[PWA] Error getting cache stats:', error);
      return null;
    }
  }

  public async clearCache(): Promise<void> {
    if (!this.isServiceWorkerSupported()) {
      return;
    }

    try {
      if (this.swRegistration?.active) {
        this.swRegistration.active.postMessage({ type: 'CLEAR_CACHE' });
      }
    } catch (error) {
      console.error('[PWA] Error clearing cache:', error);
    }
  }

  public async preloadCriticalAssets(): Promise<void> {
    if (!this.isServiceWorkerSupported()) {
      return;
    }

    try {
      if (this.swRegistration?.active) {
        this.swRegistration.active.postMessage({ type: 'PRELOAD_ASSETS' });
      }
    } catch (error) {
      console.error('[PWA] Error preloading assets:', error);
    }
  }

  public getConnectionStatus(): {
    online: boolean;
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  } {
    if (typeof window === 'undefined' || !(navigator as any).connection) {
      return { online: navigator.onLine };
    }

    const connection = (navigator as any).connection;
    return {
      online: navigator.onLine,
      effectiveType: connection.effectiveType,
      downlink: connection.downlink,
      rtt: connection.rtt,
      saveData: connection.saveData,
    };
  }

  public setupConnectionListeners(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.addEventListener('online', () => {
      console.log('[PWA] Connection restored');
      publishPwaEvent('connection-change', { online: true });
    });

    window.addEventListener('offline', () => {
      console.log('[PWA] Connection lost');
      publishPwaEvent('connection-change', { online: false });
    });

    // Listen for connection quality changes
    if ((navigator as any).connection) {
      const connection = (navigator as any).connection;
      connection.addEventListener('change', () => {
        publishPwaEvent('connection-quality-change', this.getConnectionStatus());
      });
    }
  }

  public async requestNotificationPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'denied';
    }

    if (Notification.permission === 'default') {
      return await Notification.requestPermission();
    }

    return Notification.permission;
  }

  public async showNotification(
    title: string,
    options?: NotificationOptions
  ): Promise<void> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }

    if (Notification.permission === 'granted') {
      try {
        await new Notification(title, {
          icon: '/icons/icon-192x192.png',
          badge: '/icons/icon-192x192.png',
          // Cast vibrate for broader compatibility with lib defs
          vibrate: [100, 50, 100] as any,
          ...options,
        } as any);
      } catch (error) {
        console.error('[PWA] Error showing notification:', error);
      }
    }
  }

  /**
   * The durable offline submission queue. Falls back to in-memory storage when
   * localStorage is unavailable so submissions are never lost silently within a
   * session.
   */
  public getOfflineQueue(): OfflineQueue {
    if (!this.offlineQueue) {
      this.offlineQueue = createOfflineQueue(createLocalStorageQueueStorage());
    }

    return this.offlineQueue;
  }

  public async getPendingSubmissionCount(): Promise<number> {
    try {
      return await this.getOfflineQueue().size();
    } catch (error) {
      console.error('[PWA] Error reading offline queue size:', error);
      return 0;
    }
  }

  public async getConflictedSubmissions(): Promise<OfflineSubmission[]> {
    return (await this.getOfflineQueue().list()).filter((item) => item.status === 'conflict');
  }

  /** Explicitly return a conflicted operation to the FIFO replay queue. */
  public async retryConflictedSubmission(id: string): Promise<boolean> {
    const updated = await this.getOfflineQueue().update(id, {
      status: 'pending',
      attempts: 0,
      lastError: '',
    });
    if (!updated) return false;
    await this.emitQueueChange();
    await this.registerBackgroundSync();
    return true;
  }

  /** Explicitly discard a conflicted operation after the user reviews it. */
  public async discardConflictedSubmission(id: string): Promise<boolean> {
    const item = (await this.getOfflineQueue().list()).find((entry) => entry.id === id);
    if (!item || item.status !== 'conflict') return false;
    const removed = await this.getOfflineQueue().remove(id);
    if (removed) await this.emitQueueChange();
    return removed;
  }

  private async emitQueueChange(): Promise<number> {
    const pending = await this.getPendingSubmissionCount();

    publishPwaEvent('offline-queue-change', { pending });

    return pending;
  }

  /**
   * Queue a mutation performed while offline and ask the service worker to
   * schedule a background sync for it.
   */
  public async queueOfflineSubmission(
    input: OfflineSubmissionInput,
  ): Promise<OfflineSubmission> {
    const submission = await this.getOfflineQueue().enqueue(input);
    await this.emitQueueChange();
    await this.registerBackgroundSync();
    return submission;
  }

  /**
   * Replay every queued submission. Emits `offline-queue-synced` with the
   * outcome so the UI can report what was delivered.
   */
  public async flushOfflineSubmissions(): Promise<FlushOfflineQueueResult> {
    if ((await this.getPendingSubmissionCount()) === 0) {
      return { synced: [], dropped: [], remaining: 0 };
    }

    const result = await flushOfflineQueue(this.getOfflineQueue());

    publishPwaEvent('offline-queue-synced', result);

    await this.emitQueueChange();
    return result;
  }

  /**
   * Register a Background Sync tag. Returns `false` on browsers without the
   * Background Sync API (Safari, Firefox) - the queue still flushes on the next
   * `online` event there.
   */
  public async registerBackgroundSync(): Promise<boolean> {
    if (typeof window === 'undefined' || !this.isServiceWorkerSupported()) {
      return false;
    }

    let registration: ServiceWorkerRegistration | null = this.swRegistration;

    if (!registration) {
      try {
        registration = await (navigator.serviceWorker as any).ready;
        this.swRegistration = registration;
      } catch {
        return false;
      }
    }

    const syncManager = (registration as any)?.sync;

    if (!syncManager || typeof syncManager.register !== 'function') {
      return false;
    }

    try {
      await syncManager.register(OFFLINE_QUEUE_SYNC_TAG);
      console.log('[PWA] Background sync registered for offline submissions');
      return true;
    } catch (error) {
      console.error('[PWA] Error registering background sync:', error);
      return false;
    }
  }

  /**
   * Flush the queue whenever connectivity returns, when the tab becomes visible
   * again, or when the service worker requests a replay through a `sync` event.
   * A service-worker initiated replay is acknowledged over the transferred
   * port so the browser can retry the sync when the flush could not complete.
   */
  public setupBackgroundSync(): void {
    if (typeof window === 'undefined' || this.backgroundSyncListenersBound) {
      return;
    }

    this.backgroundSyncListenersBound = true;

    const flushWhenOnline = async (): Promise<FlushOfflineQueueResult | null> => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return null;
      }

      return this.flushOfflineSubmissions();
    };

    window.addEventListener('online', () => {
      void flushWhenOnline();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void flushWhenOnline();
      }
    });

    if (this.isServiceWorkerSupported()) {
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type !== OFFLINE_QUEUE_FLUSH_MESSAGE) {
          return;
        }

        console.log('[PWA] Service worker requested an offline queue flush');

        const port = (event as MessageEvent & { ports?: MessagePort[] }).ports?.[0];

        void flushWhenOnline().then((result) => {
          if (!result || !port) {
            return;
          }

          port.postMessage({ type: OFFLINE_QUEUE_FLUSHED_MESSAGE, result });
        });      });
    }
  }
}

export default PWAManager;
