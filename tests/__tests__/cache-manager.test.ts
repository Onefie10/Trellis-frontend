if (typeof crypto === 'undefined' || !crypto.subtle) {
  const { webcrypto } = require('crypto');
  Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true, writable: true });
}
if (typeof window !== 'undefined' && (!window.crypto || !window.crypto.subtle)) {
  Object.defineProperty(window, 'crypto', { value: (global as any).crypto, configurable: true, writable: true });
}

if (typeof Request === 'undefined') {
  global.Request = class Request {
    url: string;
    method: string;
    headers: Map<string, string>;
    constructor(input: string | Request, init?: RequestInit) {
      this.url = typeof input === 'string' ? input : input.url;
      this.method = init?.method || 'GET';
      this.headers = new Map(Object.entries(init?.headers || {}));
    }
  } as any;
}

if (typeof Response === 'undefined') {
  global.Response = class Response {
    private body: any;
    headers: Map<string, string>;
    status: number;
    statusText: string;
    constructor(body?: any, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status || 200;
      this.statusText = init?.statusText || 'OK';
      this.headers = new Map(Object.entries(init?.headers || {}));
    }
    get ok() {
      return this.status >= 200 && this.status < 300;
    }
    clone() {
      return new (global as any).Response(this.body, {
        status: this.status,
        statusText: this.statusText,
        headers: Object.fromEntries(this.headers),
      });
    }
    async json() {
      return typeof this.body === 'string' ? JSON.parse(this.body) : this.body;
    }
    async text() {
      return typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
    }
  } as any;
}

if (typeof (global as any).caches === 'undefined') {
  const cacheStorage = new Map<string, Map<string, any>>();
  (global as any).caches = {
    open: jest.fn(async (cacheName: string) => {
      if (!cacheStorage.has(cacheName)) {
        cacheStorage.set(cacheName, new Map());
      }
      const store = cacheStorage.get(cacheName)!;
      return {
        put: jest.fn(async (request: any, response: any) => {
          const url = typeof request === 'string' ? request : request.url;
          store.set(url, response);
        }),
        match: jest.fn(async (request: any) => {
          const url = typeof request === 'string' ? request : request.url;
          return store.get(url) || null;
        }),
        delete: jest.fn(async (request: any) => {
          const url = typeof request === 'string' ? request : request.url;
          return store.delete(url);
        }),
        keys: jest.fn(async () => {
          return Array.from(store.keys()).map(url => new (global as any).Request(url));
        }),
      };
    }),
    delete: jest.fn(async (cacheName: string) => {
      return cacheStorage.delete(cacheName);
    }),
    keys: jest.fn(async () => {
      return Array.from(cacheStorage.keys());
    }),
  };
}

if (typeof navigator !== 'undefined' && !navigator.storage) {
  (navigator as any).storage = {
    estimate: jest.fn().mockResolvedValue({ usage: 0, quota: 1000000000 }),
  };
}

if (typeof (global as any).fetch === 'undefined') {
  (global as any).fetch = jest.fn();
}

class MockIDBCursor {
  private index = 0;
  constructor(
    private entries: Array<[IDBValidKey, unknown]>,
    private req: any
  ) {}
  get key(): IDBValidKey {
    return this.entries[this.index][0];
  }
  get value(): unknown {
    return this.entries[this.index][1];
  }
  continue(): void {
    this.index++;
    setTimeout(() => {
      this.req.result = this.index < this.entries.length ? this : null;
      this.req.onsuccess?.({ target: this.req });
    }, 0);
  }
}

class MockIDBObjectStore {
  constructor(public name: string, private data: Map<IDBValidKey, unknown>) {}
  put(value: unknown, key?: IDBValidKey) {
    const k = key !== undefined ? key : (value as any)?.id ?? String(this.data.size + 1);
    this.data.set(k, value);
    const req: any = { onsuccess: null, onerror: null, result: k };
    setTimeout(() => req.onsuccess?.({ target: req }), 0);
    return req;
  }
  get(key: IDBValidKey) {
    const result = this.data.get(key);
    const req: any = { onsuccess: null, onerror: null, result };
    setTimeout(() => req.onsuccess?.({ target: req }), 0);
    return req;
  }
  delete(key: IDBValidKey) {
    this.data.delete(key);
    const req: any = { onsuccess: null, onerror: null };
    setTimeout(() => req.onsuccess?.({ target: req }), 0);
    return req;
  }
  clear() {
    this.data.clear();
    const req: any = { onsuccess: null, onerror: null };
    setTimeout(() => req.onsuccess?.({ target: req }), 0);
    return req;
  }
  openCursor() {
    const req: any = { onsuccess: null, onerror: null, result: null };
    const entries = Array.from(this.data.entries());
    setTimeout(() => {
      if (entries.length > 0) {
        req.result = new MockIDBCursor(entries, req);
      }
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  }
  openKeyCursor() {
    return this.openCursor();
  }
}

class MockIDBTransaction {
  public oncomplete: (() => void) | null = null;
  public onerror: ((err: any) => void) | null = null;
  constructor(private db: MockIDBDatabase, private storeNames: string[], public mode: string) {
    setTimeout(() => this.oncomplete?.(), 0);
  }
  objectStore(name: string) {
    const store = this.db._getStore(name);
    if (!store) throw new Error(`NotFoundError: store ${name} not found`);
    return store;
  }
}

class MockIDBDatabase {
  private stores = new Map<string, Map<IDBValidKey, unknown>>();
  constructor(public name: string, public version: number) {}
  get objectStoreNames(): any {
    const names = Array.from(this.stores.keys());
    (names as any).contains = (n: string) => this.stores.has(n);
    return names;
  }
  createObjectStore(name: string) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return new MockIDBObjectStore(name, this.stores.get(name)!);
  }
  transaction(storeNames: string | string[], mode = 'readonly') {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new MockIDBTransaction(this, names, mode);
  }
  _getStore(name: string) {
    if (!this.stores.has(name)) return null;
    return new MockIDBObjectStore(name, this.stores.get(name)!);
  }
  close() {}
}

const mockDatabases = new Map<string, MockIDBDatabase>();

const mockIndexedDB = {
  open: (name: string, version?: number) => {
    const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
    setTimeout(() => {
      let db = mockDatabases.get(name);
      const isNew = !db;
      const targetVersion = version || (db ? db.version : 1);
      if (!db) {
        db = new MockIDBDatabase(name, targetVersion);
        mockDatabases.set(name, db);
      }
      req.result = db;
      if (isNew || (version && version > db.version)) {
        db.version = targetVersion;
        req.onupgradeneeded?.({ target: req });
      }
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },
  databases: async () => {
    return Array.from(mockDatabases.values()).map(d => ({ name: d.name, version: d.version }));
  },
};

if (typeof (global as any).indexedDB === 'undefined') {
  (global as any).indexedDB = mockIndexedDB;
}
if (typeof window !== 'undefined' && typeof window.indexedDB === 'undefined') {
  (window as any).indexedDB = mockIndexedDB;
}

import CacheManager, {
  getOrFetchCachedValue,
  setVerifiedMetadata,
  getVerifiedMetadata,
  subscribeToCachedValue,
  exportDatabaseSnapshot,
  restoreDatabaseSnapshot,
  validateSnapshotSchema,
  saveOfflineDraft,
  getOfflineDraft,
  listOfflineDrafts,
  deleteOfflineDraft,
  logTelemetryEvent,
  getTelemetryLogs,
  clearTelemetryLogs,
  DRAFTS_STORE,
  METADATA_STORE,
  TELEMETRY_STORE,
} from "@/lib/cache-manager";

describe("CacheManager LRU Eviction", () => {
  let cacheManager: CacheManager;

  beforeEach(async () => {
    cacheManager = CacheManager.getInstance();
    await cacheManager.clearCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    cacheManager.destroy();
  });

  describe("LRU eviction", () => {
    it("evicts least recently used items when cache exceeds maxEntries", async () => {
      const cache = await caches.open("Trellis-api");
      const maxEntries = 100;

      for (let i = 0; i < maxEntries + 5; i++) {
        const request = new Request(`https://example.com/api/item${i}`);
        const response = new Response(JSON.stringify({ id: i }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
        await cacheManager["recordAccess"]("api", request.url);
      }

      const keys = await cache.keys();
      expect(keys.length).toBeLessThanOrEqual(maxEntries);
    });

    it("evicts the least recently accessed entry first", async () => {
      const cache = await caches.open("Trellis-api");
      const maxEntries = 5;
      cacheManager["cacheConfigs"].get("api")!.maxEntries = maxEntries;

      const urls = [
        "https://example.com/api/a",
        "https://example.com/api/b",
        "https://example.com/api/c",
        "https://example.com/api/d",
        "https://example.com/api/e",
      ];

      for (const url of urls) {
        const request = new Request(url);
        const response = new Response(JSON.stringify({ url }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
      }

      await cacheManager["recordAccess"]("api", urls[0]);
      await cacheManager["recordAccess"]("api", urls[0]);
      await cacheManager["recordAccess"]("api", urls[1]);

      for (let i = 5; i < 8; i++) {
        const request = new Request(`https://example.com/api/new${i}`);
        const response = new Response(JSON.stringify({ id: i }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
        await cacheManager["recordAccess"]("api", request.url);
      }

      const keys = await cache.keys();
      expect(keys.length).toBeLessThanOrEqual(maxEntries);
    });

    it("does not evict when entries are under maxEntries", async () => {
      const cache = await caches.open("Trellis-api");
      await cacheManager["recordAccess"]("api", "https://example.com/api/test");
      const keys = await cache.keys();
      expect(keys.length).toBeLessThanOrEqual(100);
    });
  });

  describe("Storage quota monitoring", () => {
    it("returns storage quota when navigator.storage.estimate is available", async () => {
      const mockEstimate = { usage: 800000000, quota: 1000000000 };
      (navigator.storage.estimate as jest.Mock).mockResolvedValue(mockEstimate);

      const quota = await cacheManager.getStorageQuota();
      expect(quota).toBeTruthy();
      expect(quota?.usage).toBe(800000000);
      expect(quota?.quota).toBe(1000000000);
      expect(quota?.percentage).toBeCloseTo(0.8);
    });

    it("returns null when navigator.storage is not available", async () => {
      const originalStorage = (global as any).navigator.storage;
      (global as any).navigator.storage = undefined;

      const quota = await cacheManager.getStorageQuota();
      expect(quota).toBeNull();

      (global as any).navigator.storage = originalStorage;
    });

    it("detects when storage exceeds 80% quota threshold", async () => {
      const mockEstimate = { usage: 850000000, quota: 1000000000 };
      (navigator.storage.estimate as jest.Mock).mockResolvedValue(mockEstimate);

      const onQuotaExceeded = jest.fn();
      cacheManager.onQuotaExceeded = onQuotaExceeded;

      await cacheManager["checkStorageQuota"]();
      expect(cacheManager["storageQuota"]?.percentage).toBeGreaterThanOrEqual(0.8);
    });

    it("does not trigger quota exceeded below 80%", async () => {
      const mockEstimate = { usage: 500000000, quota: 1000000000 };
      (navigator.storage.estimate as jest.Mock).mockResolvedValue(mockEstimate);

      const onQuotaExceeded = jest.fn();
      cacheManager.onQuotaExceeded = onQuotaExceeded;

      await cacheManager["checkStorageQuota"]();
      expect(onQuotaExceeded).not.toHaveBeenCalled();
    });
  });

  describe("Cache pruning", () => {
    it("prunes half of the cache entries for a given type", async () => {
      const cache = await caches.open("Trellis-api");
      for (let i = 0; i < 10; i++) {
        const request = new Request(`https://example.com/api/prune${i}`);
        const response = new Response(JSON.stringify({ id: i }), {
          headers: { "sw-cached-at": Date.now().toString() },
        });
        await cache.put(request, response);
        await cacheManager["recordAccess"]("api", request.url);
      }

      const pruned = await cacheManager.pruneCache("api");
      expect(pruned).toBeGreaterThan(0);
    });

    it("returns 0 when no entries exist to prune", async () => {
      const pruned = await cacheManager.pruneCache("Trellis-static");
      expect(pruned).toBe(0);
    });
  });

  describe("Stale-while-revalidate responses", () => {
    it("returns a stale response before refreshing and notifies subscribers", async () => {
      const request = new Request("https://example.com/api/stale-rpc");
      const cache = await caches.open("Trellis-api");
      await cache.put(request, new Response(JSON.stringify({ version: 1 }), {
        headers: { "sw-cached-at": (Date.now() - 25 * 60 * 60 * 1000).toString() },
      }));
      const updatedResponse = new Response(JSON.stringify({ version: 2 }));
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(updatedResponse);
      let unsubscribe = () => {};
      const updateReceived = new Promise<number>(resolve => {
        unsubscribe = cacheManager.subscribeToCachedResponse("api", request, response => {
          void response.json().then(value => resolve(value.version));
        });
      });

      const staleResponse = await cacheManager.getCachedResponse("api", request);

      expect(await staleResponse?.json()).toEqual({ version: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(updateReceived).resolves.toBe(2);

      unsubscribe();
      fetchMock.mockRestore();
    });
  });
});

describe("Cache freshness diagnostics", () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    cacheManager = CacheManager.getInstance();
  });

  afterEach(async () => {
    await cacheManager.clearCache();
  });

  it("reports stale entries without exposing their URLs", async () => {
    const now = Date.now();
    const cache = await caches.open("Trellis-api");
    await cache.put(new Request("https://example.com/private?token=secret"), new Response("x", {
      headers: { "sw-cached-at": String(now - 25 * 60 * 60 * 1000) },
    }));
    await cache.put(new Request("https://example.com/unverified"), new Response("y"));

    const diagnostic = (await cacheManager.diagnoseCaches(now)).find((item) => item.type === "api");
    expect(diagnostic).toMatchObject({ entries: 2, staleEntries: 1, entriesWithoutTimestamp: 1 });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(diagnostic?.recommendation).toMatch(/remove stale/i);
  });

  it("removes proven-stale entries while retaining entries with unknown timestamps", async () => {
    const now = Date.now();
    const cache = await caches.open("Trellis-api");
    const stale = new Request("https://example.com/stale");
    const unknown = new Request("https://example.com/unknown");
    await cache.put(stale, new Response("stale", { headers: { "sw-cached-at": String(now - 25 * 60 * 60 * 1000) } }));
    await cache.put(unknown, new Response("unknown"));

    await expect(cacheManager.repairStaleCacheEntries("api", now)).resolves.toBe(1);
    expect(await cache.match(stale)).toBeUndefined();
    expect(await cache.match(unknown)).toBeDefined();
  });
});

describe("Stale-while-revalidate metadata cache", () => {
  it("returns stale metadata immediately and notifies subscribers after background refresh", async () => {
    const key = `swr-test-${Date.now()}`;
    const cachedValue = { version: 1 };
    const updatedValue = { version: 2 };
    let resolveRefresh!: (value: typeof updatedValue) => void;
    const fetcher = jest.fn(() => new Promise<typeof updatedValue>(resolve => {
      resolveRefresh = resolve;
    }));
    const onUpdate = jest.fn();
    await setVerifiedMetadata(key, cachedValue);
    const updateReceived = new Promise<void>(resolve => {
      const unsubscribe = subscribeToCachedValue(key, value => {
        onUpdate(value);
        unsubscribe();
        resolve();
      });
    });
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);

    const result = await getOrFetchCachedValue(key, fetcher, { staleTime: 0, cacheTime: 60_000 });

    expect(result).toEqual(cachedValue);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();

    resolveRefresh(updatedValue);
    await updateReceived;

    expect(onUpdate).toHaveBeenCalledWith(updatedValue);
    jest.restoreAllMocks();
  });
});

describe("IndexedDB database snapshot exporter and restore tool", () => {
  const passphrase = "secure-trellis-password-456";

  beforeEach(() => {
    jest.useRealTimers();
  });

  it("should export IndexedDB stores to encrypted JSON with passphrase", async () => {
    const metaKey = `meta-test-${Date.now()}`;
    const metaVal = { agentId: "agent-007", name: "Bond Agent", version: "2.1.0" };
    await setVerifiedMetadata(metaKey, metaVal);

    const draftId = `draft-${Date.now()}`;
    const draftContent = { title: "Offline Grant Application", amount: 5000, network: "stellar-testnet" };
    await saveOfflineDraft(draftId, draftContent);

    const telemetryId = `telem-${Date.now()}`;
    const telemetryEvent = { type: "PAGE_VIEW", path: "/marketplace/agent-007", durationMs: 1420 };
    await logTelemetryEvent(telemetryId, telemetryEvent);

    const exportedJson = await exportDatabaseSnapshot({ passphrase });

    expect(typeof exportedJson).toBe("string");
    const parsed = JSON.parse(exportedJson);

    expect(parsed.version).toBe(1);
    expect(parsed.encrypted).toBe(true);
    expect(parsed.algorithm).toBe("AES-GCM-256");
    expect(typeof parsed.payload).toBe("string");
    expect(typeof parsed.checksum).toBe("string");
    expect(parsed.checksum.length).toBeGreaterThan(0);
  });

  it("should restore an encrypted snapshot and reinstate offline drafts and cached state accurately", async () => {
    const metaKey = `meta-restore-${Date.now()}`;
    const metaVal = { token: "XLM", contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2" };
    await setVerifiedMetadata(metaKey, metaVal);

    const draftId = `draft-restore-${Date.now()}`;
    const draftVal = { title: "DAO Treasury Allocation", votesNeeded: 3 };
    await saveOfflineDraft(draftId, draftVal);

    const telemetryId = `telem-restore-${Date.now()}`;
    const telemetryVal = { event: "VOTE_CAST", proposalId: "prop-42" };
    await logTelemetryEvent(telemetryId, telemetryVal);

    // Export with encryption
    const exportedJson = await exportDatabaseSnapshot({ passphrase });

    // Mutate state: delete the draft and verify it is gone
    await deleteOfflineDraft(draftId);
    expect(await getOfflineDraft(draftId)).toBeNull();

    // Restore the snapshot
    const result = await restoreDatabaseSnapshot(exportedJson, { passphrase, overwrite: true });

    expect(result.success).toBe(true);
    expect(result.restoredDatabases).toBeGreaterThanOrEqual(1);
    expect(result.restoredStores).toBeGreaterThanOrEqual(1);
    expect(result.restoredRecords).toBeGreaterThanOrEqual(1);

    // Reinstated offline draft fidelity check
    const restoredDraft = await getOfflineDraft<typeof draftVal>(draftId);
    expect(restoredDraft).toEqual(draftVal);

    // Reinstated verified metadata check
    const restoredMeta = await getVerifiedMetadata<typeof metaVal>(metaKey);
    expect(restoredMeta).toEqual(metaVal);

    // Reinstated telemetry log check
    const telemetryLogs = await getTelemetryLogs();
    const foundLog = telemetryLogs.find(l => l.id === telemetryId);
    expect(foundLog?.event).toEqual(telemetryVal);
  });

  it("should export and restore unencrypted snapshot accurately when no passphrase is provided", async () => {
    const draftId = `draft-unenc-${Date.now()}`;
    const draftData = { title: "Unencrypted Draft", notes: "No passphrase used" };
    await saveOfflineDraft(draftId, draftData);

    const exportedJson = await exportDatabaseSnapshot();
    const parsed = JSON.parse(exportedJson);

    expect(parsed.version).toBe(1);
    expect(parsed.app).toBe("trellis");
    expect(parsed.encrypted).toBeUndefined();
    expect(Array.isArray(parsed.databases)).toBe(true);

    // Delete draft and restore
    await deleteOfflineDraft(draftId);
    expect(await getOfflineDraft(draftId)).toBeNull();

    const restoreResult = await restoreDatabaseSnapshot(exportedJson);
    expect(restoreResult.success).toBe(true);

    const restored = await getOfflineDraft(draftId);
    expect(restored).toEqual(draftData);
  });

  it("should validate snapshot schema and reject invalid structures", () => {
    expect(validateSnapshotSchema(null).valid).toBe(false);
    expect(validateSnapshotSchema("not an object").valid).toBe(false);
    expect(validateSnapshotSchema({ version: 2, app: "trellis", databases: [] }).valid).toBe(false);
    expect(validateSnapshotSchema({ version: 1, app: "invalid-app", databases: [] }).valid).toBe(false);
    expect(validateSnapshotSchema({ version: 1, app: "trellis", databases: "not-array" }).valid).toBe(false);
    expect(
      validateSnapshotSchema({
        version: 1,
        app: "trellis",
        databases: [{ name: "db1", version: 1, stores: [{ name: "store1", records: [{ value: 1 }] }] }],
      }).valid
    ).toBe(true);
  });

  it("should reject restore if corrupted JSON is supplied", async () => {
    await expect(restoreDatabaseSnapshot("invalid-json{")).rejects.toThrow("Failed to parse snapshot JSON");
  });

  it("should reject restore if encrypted snapshot is restored without passphrase", async () => {
    const exportedJson = await exportDatabaseSnapshot({ passphrase });
    await expect(restoreDatabaseSnapshot(exportedJson)).rejects.toThrow(
      "Snapshot is encrypted. Passphrase is required for restoration."
    );
  });

  it("should reject restore if encrypted snapshot is restored with wrong passphrase", async () => {
    const exportedJson = await exportDatabaseSnapshot({ passphrase });
    await expect(restoreDatabaseSnapshot(exportedJson, { passphrase: "wrong-password" })).rejects.toThrow(
      "Decryption failed. Incorrect passphrase or corrupted data."
    );
  });

  it("should reject restore if snapshot integrity checksum has been tampered with", async () => {
    const exportedJson = await exportDatabaseSnapshot();
    const parsed = JSON.parse(exportedJson);

    // Tamper with records while keeping original checksum
    parsed.databases[0].stores[0].records.push({ key: "tampered-key", value: "hacked" });

    await expect(restoreDatabaseSnapshot(JSON.stringify(parsed))).rejects.toThrow(
      "Snapshot integrity check failed: checksum mismatch or corrupted data."
    );
  });

  it("should list and delete offline drafts accurately", async () => {
    const idA = `list-draft-a-${Date.now()}`;
    const idB = `list-draft-b-${Date.now()}`;
    await saveOfflineDraft(idA, { title: "Draft A" });
    await saveOfflineDraft(idB, { title: "Draft B" });

    const drafts = await listOfflineDrafts();
    expect(drafts.some(d => d.id === idA)).toBe(true);
    expect(drafts.some(d => d.id === idB)).toBe(true);

    await deleteOfflineDraft(idA);
    const updatedDrafts = await listOfflineDrafts();
    expect(updatedDrafts.some(d => d.id === idA)).toBe(false);
    expect(updatedDrafts.some(d => d.id === idB)).toBe(true);
  });

  it("should log, list and clear telemetry events accurately", async () => {
    const telemId = `telem-log-${Date.now()}`;
    await logTelemetryEvent(telemId, { level: "INFO", message: "User signed in" });

    const logs = await getTelemetryLogs();
    expect(logs.some(l => l.id === telemId)).toBe(true);

    await clearTelemetryLogs();
    const clearedLogs = await getTelemetryLogs();
    expect(clearedLogs.length).toBe(0);
  });
});

