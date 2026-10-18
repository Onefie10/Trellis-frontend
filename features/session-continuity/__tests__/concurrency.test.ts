import {
  createVersionToken,
  isVersionStale,
  detectConflict,
  getRecoveryActions,
  SessionManager,
} from "../../../lib/concurrency";

describe("Concurrency Control", () => {
  describe("Version Tokens", () => {
    it("should create a version token", () => {
      const token = createVersionToken("resource-1", 1, "device-1", { data: "test" });
      expect(token.resourceId).toBe("resource-1");
      expect(token.version).toBe(1);
      expect(token.deviceId).toBe("device-1");
      expect(token.checksum).toBeDefined();
    });

    it("should detect stale versions", () => {
      const token = createVersionTokenA("resource-1", 1, "device-1", { data: "test" });
      expect(isVersionStale(token, 2)).toBe(true);
      expect(isVersionStale(token, 1)).toBe(false);
    });
  });

  describe("Conflict Detection", () => {
    it("should detect stale write conflicts", () => {
      const conflict = detectConflict(1, 2, "device-1", "device-1");
      expect(conflict?.conflictType).toBe("stale_write");
    });

    it("should detect concurrent edit conflicts", () => {
      const conflict = detectConflict(1, 1, "device-1", "device-2");
      expect(conflict?.conflictType).toBe("concurrent_edit");
    });

    it("should not detect conflict when versions match and same device", () => {
      const conflict = detectConflict(1, 1, "device-1", "device-1");
      expect(conflict).toBeNull();
    });
  });

  describe("Recovery Actions", () => {
    it("should provide recovery for stale writes", () => {
      const conflict = {
        resourceId: "res-1",
        currentVersion: 2,
        attemptedVersion: 1,
        serverVersion: 2,
        conflictType: "stale_write" as const,
        timestamp: Date.now(),
      };
      const actions = getRecoveryActions(conflict);
      expect(actions.some((a) => a.type === "refresh")).toBe(true);
      expect(actions.some((a) => a.type === "retry")).toBe(true);
    });

    it("should provide recovery for concurrent edits", () => {
      const conflict = {
        resourceId: "res-1",
        currentVersion: 1,
        attemptedVersion: 1,
        serverVersion: 1,
        conflictType: "concurrent_edit" as const,
        timestamp: Date.now(),
      };
      const actions = getRecoveryActions(conflict);
      expect(actions.some((a) => a.type === "merge")).toBe(true);
    });
  });

  describe("Session Manager", () => {
    let manager: SessionManager;

    beforeEach(() => {
      manager = new SessionManager("device-1");
    });

    it("should generate device ID", () => {
      expect(manager.getDeviceId()).toBeDefined();
    });

    it("should store and retrieve versions", () => {
      const token = createVersionToken("resource-1", 1, "device-1", {});
      manager.setVersion(token);
      expect(manager.getVersion("resource-1")).toBe(token);
    });

    it("should clear versions", () => {
      const token = createVersionToken("resource-1", 1, "device-1", {});
      manager.setVersion(token);
      manager.clearVersion("resource-1");
      expect(manager.getVersion("resource-1")).toBeUndefined();
    });

    it("should manage multiple versions", () => {
      const token1 = createVersionTokenA("resource-1", 1, "device-1", {});
      const token2 = createVersionTokenA("resource-2", 1, "device-1", {});
      manager.setVersion(token1);
      manager.setVersion(token2);
      expect(manager.getAllVersions().length).toBe(2);
    });

    it("should reset all versions", () => {
      manager.setVersion(createVersionTokenA("resource-1", 1, "device-1", {}));
      manager.reset();
      expect(manager.getAllVersions().length).toBe(0);
    });
  });

  describe("Conflict Resolution", () => {
    it("should handle simultaneous edits", () => {
      const conflict1 = detectConflict(1, 1, "device-1", "device-2");
      const conflict2 = detectConflict(1, 1, "device-2", "device-1");
      expect(conflict1?.conflictType).toBe("concurrent_edit");
      expect(conflict2?.conflictType).toBe("concurrent_edit");
    });

    it("should distinguish between simultaneous edits and stale writes", () => {
      const simultaneous = detectConflict(2, 2, "device-1", "device-2");
      const stale = detectConflict(1, 2, "device-1", "device-1");
      expect(simultaneous?.conflictType).toBe("concurrent_edit");
      expect(stale?.conflictType).toBe("stale_write");
    });
  });

  /**
   * Multi-actor concurrency harness.
   *
   * These tests drive the real concurrency primitives through a deterministic
   * scheduler (no wall-clock timing, no real timers) so interleavings reproduce
   * exactly. Each actor is a generator that yields at every await point; the
   * harness runs them in a seeded order and asserts on the resulting state.
   */
  describe("Multi-actor concurrency harness", () => {
    type Actor<T> = () => Generator<void, void, void> & { result?: T };

    /** Deterministic PRNG (biogent-style xorshift) for reproducible interleavings. */
    function createSeededRng(seed: number) {
      let state = seed >>> 0;
      return (): number => {
        state = (state + 0x6d2b6fc5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t | 1, 2)) ^ 0 ;
        t = Math.imul(t ^ (t >>> 7), 61 | t);
        t = (t ^ (t >>> 14)) >>> 0;
        return t >>> 0;
      };
    }

    /**
     * Run a set of actors to completion by interleaving their steps.
     * The scheduler is seeded, so a given seed always produces the same
     * order of steps across actors. This is the "multi-actor" part of the
     * harness.
     */
    function runConcurrently<T>(
      actors: Array<Actor<T>>,
      seed: number,
    ): T | undefined {
      const png = createSeededRng(seed);
      const iterators = actors.map((a) => a());
      const active = new Set(iterators.map((_, i) => i));
      let lastResult: T | undefined;

      while (active.size > 0) {
        const candidates = Array.from(active);
        const pick = candidates[png() % candidates.length];
        const iterator = iterators[pick];
        const step = iterator.next();
        if (step.done) {
          active.delete(pick);
          const result = (iterator as Actor<T>).result;
          if (result !== undefined) lastResult = result;
        }
      }
      return lastResult;
    }

    /** Simulate a single actor writing through a version-checked store. */
    function createVersionedStore(initialVersion = 1) {
      let version = initialVersion;
      let writes = 0;
      return {
        getVersion() { return version; },
        getWrites() { return writes; },
        /** Attempt a write based on an observed version. Returns true on commit. */
        tryWrite(observedVersion: number): boolean {
          if (observedVersion !== version) return false;
          version += 1;
          writes += 1;
          return true;
        },
      };
    }

    it("should allow only one of many concurrent actors to commit a stale version", () => {
      const store = createVersionedStore(1);
      const committed: string[] = [];
      const conflicts: string[] = [];

      const makeActor = (id: string): Actor<void> => function* () {
        const observed = store.getVersion();
        yield; // all actors observe the same version before any commits
        const conflict = detectConflict(observed, store.getVersion(), id, id);
        if (conflict) {
          conflicts.push(id);
          return;
        }
        if (store.tryWrite(observed)) {
          committed.push(id);
        } else {
          conflicts.push(id);
        }
      };

      const actors = ["a", "b", "c", "d"].map(makeActor);
      runConcurrently(actors, 42);

      expect(committed.length).toBe(1);
      expect(conflicts.length).toBe(actors.length - 1);
      expect(store.getVersion()).toBe(2);
    });

    it("should be idempotent for duplicate submissions of the same operation", () => {
      const store = createVersionedStore(1);
      const seenOps = new Set<string>();
      const committed: string[] = [];

      const submit = (opId: string): Actor<void> => function* () {
        // Dedupe by idempotency key before touching the store.
        if (seenOps.has(opId)) return;
        seenOps.add(opId);
        const observed = store.getVersion();
        yield;
        if (store.tryWrite(observed)) committed.push(opId);
      };

      // Same op ID submitted by four actors (e.g. double click + retry).
      const actors = [1, 2, 3, 4].map(() => submit("op-1"));
      runConcurrently(actors, 7);

      expect(committed).toEqual(["op-1"]);
      expect(store.getVersion()).toBe(2);
    });

    it("should reject stale version writes and require a refresh", () => {
      const store = createVersionedStore(1);
      // Advance the server version behind the client's back.
      expect(store.tryWrite(1)).toBe(true);
      const staleToken = createVersionTokenA("resource-1", 1, "device-1", { data: "old" });
      expect(isVersionStale(staleToken, store.getVersion())).toBe(true);

      const conflict = detectConflict(1, store.getVersion(), "device-1", "device-1");
      expect(conflict?.conflictType).toBe("stale_write");
      const actions = getRecoveryActions(conflict!);
      expect(actions.some((a) => a.type === "refresh")).toBe(true);
      // The stale write must not commit.
      expect(store.tryWrite(1)).toBe(false);
      expect(store.getVersion()).toBe(2);
    });

    it("should bound retry storms without clobbering the committed version", () => {
      const store = createVersionedStore(1);
      const MAX_RETRIES = 5;
      let attempts = 0;
      const committed: number[] = [];

      // Actor that keeps retrying a stale version after the server moved on.
      const retryStorm: Actor<void> = function* () {
        const observed = 1;
        while (attempts < MAX_RETRIES) {
          attempts++;
          yield;
          if (store.tryWrite(observed)) {
            committed.push(attempts);
            return;
          }
        }
      };

      // A competing actor commits the current version first.
      const competitor = function* () {
        const observed = store.getVersion();
        yield;
        store.tryWrite(observed);
      };

      runConcurrently([retryStorm, competitor], 13);

      expect(attempts).toBe(MAX_RETRIES);
      expect(committed).toEqual([]);
      expect(store.getVersion()).toBe(2);
    });

    it("should produce a deterministic interleaving for a given seed", () => {
      const run = (seed: number) => {
        const order: string[] = [];
        const make = (id: string): Actor<void> => function* () {
          for (let i = 0; i < 3; i++) {
            order.push(`${id}:${i}`);
            yield;
          }
        };
        runConcurrently(["a", "b", "c"].map(make), seed);
        return order;
      };

      expect(run(9)).toEqual(run(9));
      expect(run(9).length).toBe(run(9).length);
      expect(run(9).length).toBe(9);
    });
  });
});
