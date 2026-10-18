/**
 * Migration Runner — Issue #56
 *
 * Executes migrations with dry-run preview, post-migration validation, and
 * rollback note documentation.
 *
 * Key behaviours:
 *  - `dryRun: true` (default) clones the store, runs `up()` on the clone,
 *    runs `validate()` on the clone, and returns preview output — zero real
 *    writes occur.
 *  - Live run (`dryRun: false`) applies `up()` to the real store, then runs
 *    `validate()`.  If validation fails the run is marked
 *    `validation_failed`; the store is NOT automatically rolled back because
 *    automatic rollback can mask the root cause.  The rollbackNote tells the
 *    operator what to do manually.
 *  - `PostMigrationCheck`s run after the last live migration and assert
 *    global cross-migration invariants.
 *  - The runner remembers which migration IDs have already been applied (in
 *    the store itself, under the special entity type `_migration_runs`) and
 *    skips them on subsequent runs, making the runner idempotent.
 */

import type {
  Migration,
  MigrationStore,
  MigrationStoreSnapshot,
  MigrationUpResult,
  MigrationPreview,
  MigrationRunRecord,
  MigrationRunStatus,
  RunMigrationsOptions,
  RunMigrationsResult,
  PostMigrationCheck,
} from './types';

// ─── ID generation ────────────────────────────────────────────────────────────

function newRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── In-memory store ──────────────────────────────────────────────────────────

/** Default in-memory implementation; swap for a real adapter in production. */
export class MemoryMigrationStore implements MigrationStore {
  private data: Map<string, Map<string, Record<string, unknown>>> = new Map();

  private entityMap(entityType: string): Map<string, Record<string, unknown>> {
    if (!this.data.has(entityType)) this.data.set(entityType, new Map());
    return this.data.get(entityType)!;
  }

  getAll(entityType: string): Record<string, unknown>[] {
    return Array.from(this.entityMap(entityType).values()).map(r => ({ ...r }));
  }

  set(entityType: string, id: string, data: Record<string, unknown>): void {
    this.entityMap(entityType).set(id, JSON.parse(JSON.stringify(data)));
  }

  delete(entityType: string, id: string): void {
    this.entityMap(entityType).delete(id);
  }

  snapshot(): MigrationStoreSnapshot {
    const snap: MigrationStoreSnapshot = {};
    for (const [entityType, records] of this.data) {
      snap[entityType] = {};
      for (const [id, record] of records) {
        snap[entityType][id] = JSON.parse(JSON.stringify(record));
      }
    }
    return snap;
  }

  restore(snapshot: MigrationStoreSnapshot): void {
    this.data.clear();
    for (const [entityType, records] of Object.entries(snapshot)) {
      const map = new Map<string, Record<string, unknown>>();
      for (const [id, record] of Object.entries(records)) {
        map.set(id, JSON.parse(JSON.stringify(record)));
      }
      this.data.set(entityType, map);
    }
  }

  /** Test helper: number of records across all entity types. */
  totalRecords(): number {
    let n = 0;
    for (const map of this.data.values()) n += map.size;
    return n;
  }
}

// ─── Clone-store wrapper (for dry-run) ───────────────────────────────────────

class ClonedStore implements MigrationStore {
  private inner: MemoryMigrationStore;

  constructor(snapshot: MigrationStoreSnapshot) {
    this.inner = new MemoryMigrationStore();
    this.inner.restore(snapshot);
  }

  getAll(entityType: string) { return this.inner.getAll(entityType); }
  set(et: string, id: string, d: Record<string, unknown>) { this.inner.set(et, id, d); }
  delete(et: string, id: string) { this.inner.delete(et, id); }
  snapshot() { return this.inner.snapshot(); }
  restore(s: MigrationStoreSnapshot) { this.inner.restore(s); }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const RUNS_ENTITY = '_migration_runs';

export class MigrationRunner {
  private migrations:  Migration[]           = [];
  private postChecks:  PostMigrationCheck[]  = [];
  private store:       MigrationStore;

  constructor(store: MigrationStore) {
    this.store = store;
  }

  /** Register a migration (order matters — run in registration order). */
  register(migration: Migration): this {
    this.migrations.push(migration);
    return this;
  }

  /** Register a post-migration check. */
  addPostCheck(check: PostMigrationCheck): this {
    this.postChecks.push(check);
    return this;
  }

  // ─── Dry-run preview ────────────────────────────────────────────────────────

  /**
   * Run all pending migrations against an in-memory clone and return previews.
   * Does NOT modify the real store.
   */
  async preview(opts: { only?: string[]; skip?: string[] } = {}): Promise<MigrationPreview[]> {
    const pending = this._pending(opts.only, opts.skip);
    const previews: MigrationPreview[] = [];

    for (const migration of pending) {
      const cloned = new ClonedStore(this.store.snapshot());
      const previewedAt = nowIso();

      let simulated: MigrationUpResult = { created: 0, updated: 0, deleted: 0 };
      let validationErrors: string[] = [];

      try {
        simulated = await migration.up(cloned);
      } catch (e: unknown) {
        validationErrors.push(`up() threw: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (!validationErrors.length && migration.validate) {
        try {
          validationErrors = await migration.validate(cloned);
        } catch (e: unknown) {
          validationErrors.push(`validate() threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      previews.push({
        migrationId:              migration.id,
        version:                  migration.version,
        description:              migration.description,
        estimatedAffectedCount:   migration.estimatedAffectedCount,
        simulatedResult:          simulated,
        validationErrors,
        safe:                     validationErrors.length === 0,
        rollbackNote:             migration.rollbackNote,
        previewedAt,
      });
    }

    return previews;
  }

  // ─── Live run ───────────────────────────────────────────────────────────────

  /**
   * Execute all pending migrations against the real store (or dry-run if
   * `opts.dryRun` is true).
   *
   * Migrations that have already been applied (tracked in `_migration_runs`)
   * are skipped automatically, making the runner safe to call on every deploy.
   */
  async run(opts: RunMigrationsOptions = {}): Promise<RunMigrationsResult> {
    const dryRun      = opts.dryRun !== false; // safe default
    const pending     = this._pending(opts.only, opts.skip);
    const result: RunMigrationsResult = {
      dryRun,
      total:       pending.length,
      success:     0,
      failed:      0,
      skipped:     0,
      previews:    [],
      runs:        [],
      errors:      [],
      completedAt: '',
    };

    if (dryRun) {
      result.previews = await this.preview({ only: opts.only, skip: opts.skip });
      result.success  = result.previews.filter(p => p.safe).length;
      result.failed   = result.previews.filter(p => !p.safe).length;
      result.completedAt = nowIso();
      return result;
    }

    // Live run
    for (const migration of pending) {
      const startedAt  = nowIso();
      let runStatus: MigrationRunStatus = 'success';
      let upResult: MigrationUpResult  = { created: 0, updated: 0, deleted: 0 };
      let validationErrors: string[]   = [];
      let topError: string | undefined;

      try {
        upResult = await migration.up(this.store);
      } catch (e: unknown) {
        runStatus = 'error';
        topError  = e instanceof Error ? e.message : String(e);
        result.errors.push(`${migration.id}: ${topError}`);
      }

      if (runStatus === 'success' && migration.validate) {
        try {
          validationErrors = await migration.validate(this.store);
          if (validationErrors.length > 0) {
            runStatus = 'validation_failed';
            result.errors.push(
              `${migration.id} validation failed: ${validationErrors.join('; ')}`,
            );
          }
        } catch (e: unknown) {
          runStatus = 'validation_failed';
          topError  = e instanceof Error ? e.message : String(e);
          result.errors.push(`${migration.id} validate() threw: ${topError}`);
        }
      }

      const runRecord: MigrationRunRecord = {
        id:               newRunId(),
        migrationId:      migration.id,
        version:          migration.version,
        description:      migration.description,
        status:           runStatus,
        dryRun:           false,
        result:           upResult,
        validationErrors,
        error:            topError,
        rollbackNote:     migration.rollbackNote,
        startedAt,
        finishedAt:       nowIso(),
        correlationId:    opts.correlationId,
      };

      result.runs.push(runRecord);

      // Persist run record in the store so it won't run again.
      this.store.set(RUNS_ENTITY, migration.id, runRecord as unknown as Record<string, unknown>);

      if (runStatus === 'success') {
        result.success++;
      } else {
        result.failed++;
        // Stop on first failure to avoid cascading state corruption.
        result.completedAt = nowIso();
        return result;
      }
    }

    // Post-migration checks (live only)
    for (const check of this.postChecks) {
      const errors = await check.run(this.store);
      if (errors.length > 0) {
        result.errors.push(`Post-check '${check.id}': ${errors.join('; ')}`);
        result.failed++;
      }
    }

    result.completedAt = nowIso();
    return result;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Returns migrations not yet applied (not in `_migration_runs`). */
  private _pending(only?: string[], skip?: string[]): Migration[] {
    const applied = new Set(
      this.store.getAll(RUNS_ENTITY)
        .filter(r => (r as MigrationRunRecord).status === 'success')
        .map(r => (r as MigrationRunRecord).migrationId),
    );

    return this.migrations.filter(m => {
      if (applied.has(m.id)) return false;
      if (only && !only.includes(m.id)) return false;
      if (skip && skip.includes(m.id)) return false;
      return true;
    });
  }

  /** List all migration run records persisted in the store. */
  getRuns(): MigrationRunRecord[] {
    return this.store.getAll(RUNS_ENTITY) as unknown as MigrationRunRecord[];
  }

  /** True if a migration has already been successfully applied. */
  isApplied(migrationId: string): boolean {
    const records = this.getRuns();
    return records.some(
      r => r.migrationId === migrationId && r.status === 'success',
    );
  }
}
