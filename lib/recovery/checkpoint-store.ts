/**
 * Checkpoint Store — Issue #54
 *
 * Two concrete implementations of CheckpointStore:
 *
 *   MemoryCheckpointStore   — unit tests and SSR paths
 *   LocalStorageCheckpointStore — browser sessions; survives page reload
 *
 * The localStorage implementation partitions keys with a stable prefix so it
 * never collides with wallet or idempotency keys.  Both implementations are
 * fully synchronous — no async I/O is needed because the data is small and
 * latency would hurt the hot path of the recovery engine.
 */

import type {
  CheckpointStore,
  RecoverableOperation,
  RecoveryCheckpoint,
} from './types';

// ─── Key helpers ──────────────────────────────────────────────────────────────

const OP_PREFIX  = 'trellis:recovery:op:';
const CP_PREFIX  = 'trellis:recovery:cp:';

function opKey(id: string): string {
  return `${OP_PREFIX}${id}`;
}

function cpKey(operationId: string, stepId: string): string {
  return `${CP_PREFIX}${operationId}:${stepId}`;
}

// ─── In-memory (tests / SSR) ──────────────────────────────────────────────────

export class MemoryCheckpointStore implements CheckpointStore {
  private ops   = new Map<string, RecoverableOperation>();
  private cps   = new Map<string, RecoveryCheckpoint>();

  saveOperation(op: RecoverableOperation): void {
    this.ops.set(op.id, { ...op, steps: op.steps.map(s => ({ ...s })) });
  }

  getOperation(id: string): RecoverableOperation | null {
    const op = this.ops.get(id);
    if (!op) return null;
    return { ...op, steps: op.steps.map(s => ({ ...s })) };
  }

  listOperations(): RecoverableOperation[] {
    return Array.from(this.ops.values()).map(op => ({
      ...op,
      steps: op.steps.map(s => ({ ...s })),
    }));
  }

  deleteOperation(id: string): void {
    this.ops.delete(id);
  }

  saveCheckpoint(cp: RecoveryCheckpoint): void {
    this.cps.set(cpKey(cp.operationId, cp.stepId), { ...cp });
  }

  getCheckpoint(operationId: string, stepId: string): RecoveryCheckpoint | null {
    return this.cps.get(cpKey(operationId, stepId)) ?? null;
  }

  listCheckpoints(operationId: string): RecoveryCheckpoint[] {
    const prefix = `${CP_PREFIX}${operationId}:`;
    return Array.from(this.cps.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => ({ ...v }));
  }

  clear(): void {
    this.ops.clear();
    this.cps.clear();
  }

  /** Test/support helper. */
  size(): { ops: number; checkpoints: number } {
    return { ops: this.ops.size, checkpoints: this.cps.size };
  }
}

// ─── localStorage (browser sessions) ─────────────────────────────────────────

export class LocalStorageCheckpointStore implements CheckpointStore {
  /** Lazy fallback for environments without localStorage (SSR, storage denied). */
  private readonly fallback = new MemoryCheckpointStore();

  private get storage(): Storage | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      // Quick write-test; private mode may expose the object but throw on set.
      window.localStorage.setItem('__trellis_check__', '1');
      window.localStorage.removeItem('__trellis_check__');
      return window.localStorage;
    } catch {
      return null;
    }
  }

  private readJson<T>(key: string): T | null {
    const storage = this.storage;
    if (!storage) return null;
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt entry — remove so the next attempt can proceed cleanly.
      storage.removeItem(key);
      return null;
    }
  }

  private writeJson(key: string, value: unknown): void {
    const storage = this.storage;
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // QuotaExceededError — degrade gracefully; in-memory fallback covers the
      // current tab but the checkpoint won't survive a reload.
    }
  }

  saveOperation(op: RecoverableOperation): void {
    if (!this.storage) {
      this.fallback.saveOperation(op);
      return;
    }
    this.writeJson(opKey(op.id), op);
  }

  getOperation(id: string): RecoverableOperation | null {
    if (!this.storage) return this.fallback.getOperation(id);
    return this.readJson<RecoverableOperation>(opKey(id));
  }

  listOperations(): RecoverableOperation[] {
    const storage = this.storage;
    if (!storage) return this.fallback.listOperations();

    const results: RecoverableOperation[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(OP_PREFIX)) {
        const op = this.readJson<RecoverableOperation>(key);
        if (op) results.push(op);
      }
    }
    return results;
  }

  deleteOperation(id: string): void {
    const storage = this.storage;
    if (!storage) {
      this.fallback.deleteOperation(id);
      return;
    }
    storage.removeItem(opKey(id));
    // Clean up all checkpoints for this operation too.
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(`${CP_PREFIX}${id}:`)) toRemove.push(key);
    }
    toRemove.forEach(k => storage.removeItem(k));
  }

  saveCheckpoint(cp: RecoveryCheckpoint): void {
    if (!this.storage) {
      this.fallback.saveCheckpoint(cp);
      return;
    }
    this.writeJson(cpKey(cp.operationId, cp.stepId), cp);
  }

  getCheckpoint(operationId: string, stepId: string): RecoveryCheckpoint | null {
    if (!this.storage) return this.fallback.getCheckpoint(operationId, stepId);
    return this.readJson<RecoveryCheckpoint>(cpKey(operationId, stepId));
  }

  listCheckpoints(operationId: string): RecoveryCheckpoint[] {
    const storage = this.storage;
    if (!storage) return this.fallback.listCheckpoints(operationId);

    const prefix = `${CP_PREFIX}${operationId}:`;
    const results: RecoveryCheckpoint[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) {
        const cp = this.readJson<RecoveryCheckpoint>(key);
        if (cp) results.push(cp);
      }
    }
    return results;
  }

  clear(): void {
    const storage = this.storage;
    if (!storage) {
      this.fallback.clear();
      return;
    }
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(OP_PREFIX) || key?.startsWith(CP_PREFIX)) {
        toRemove.push(key);
      }
    }
    toRemove.forEach(k => storage.removeItem(k));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _defaultStore: CheckpointStore = new LocalStorageCheckpointStore();

export function getCheckpointStore(): CheckpointStore {
  return _defaultStore;
}

/** Test/support helper: swap the default store. */
export function setCheckpointStore(store: CheckpointStore): void {
  _defaultStore = store;
}
