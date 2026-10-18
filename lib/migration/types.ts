/**
 * Migration Safety Framework Types — Issue #56
 *
 * Schema and data migrations need guardrails:
 *   1. Dry-run / preview — show what will change before writing anything
 *   2. Post-migration validation — detect incomplete or inconsistent results
 *   3. Rollback / forward-fix documentation — clear recovery procedure
 *
 * Design decisions:
 *   - A Migration is a plain object with `up()` and optional `validate()`
 *     functions.  No class hierarchy — keeps implementations testable in
 *     isolation.
 *   - The runner is the only place that calls `up()`; it always calls
 *     `validate()` afterwards (unless `dryRun === true`).
 *   - Dry-run mode runs the migration against an in-memory clone of the data
 *     and reports the diff without touching the real store.
 *   - Every run produces a MigrationRunRecord that can be stored alongside the
 *     application data for audit purposes.
 */

// ─── Core migration definition ────────────────────────────────────────────────

/**
 * A single migration unit.
 *
 * `id`      — stable across environments; never change after first use
 * `version` — semantic version of the schema after this migration runs
 * `up()`    — applies the change to `store`; must be idempotent
 * `validate()` — asserts the store is in a consistent post-migration state;
 *                returns a list of errors (empty = success)
 * `rollbackNote` — prose description of how to undo or forward-fix if needed
 */
export interface Migration {
  id: string;
  version: string;
  description: string;
  /** Estimated number of records affected (for preview UX). */
  estimatedAffectedCount?: number;
  up(store: MigrationStore): Promise<MigrationUpResult>;
  validate?(store: MigrationStore): Promise<string[]>;
  /** Human-readable rollback procedure. */
  rollbackNote: string;
}

// ─── Store interface ──────────────────────────────────────────────────────────

/**
 * Minimal storage interface the migration runner operates against.
 *
 * `snapshot()` returns a deep clone of all records so the dry-run runner can
 * execute `up()` against the clone without touching the real store.
 *
 * Implementations: MemoryMigrationStore (tests), any real adapter for prod.
 */
export interface MigrationStore {
  /** Return all records for a given entity type. */
  getAll(entityType: string): Record<string, unknown>[];
  /** Overwrite or create a record. */
  set(entityType: string, id: string, data: Record<string, unknown>): void;
  /** Delete a record. */
  delete(entityType: string, id: string): void;
  /** Return a deep-cloned snapshot of the entire store. */
  snapshot(): MigrationStoreSnapshot;
  /** Replace the entire store contents from a snapshot (used by dry-run). */
  restore(snapshot: MigrationStoreSnapshot): void;
}

export type MigrationStoreSnapshot = Record<string, Record<string, Record<string, unknown>>>;

// ─── Up result ────────────────────────────────────────────────────────────────

/** Returned by `Migration.up()` to give the runner per-migration statistics. */
export interface MigrationUpResult {
  /** Records created during this migration. */
  created: number;
  /** Records updated during this migration. */
  updated: number;
  /** Records deleted during this migration. */
  deleted: number;
  /** Arbitrary key-value notes (e.g. which IDs were changed). */
  notes?: Record<string, unknown>;
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/**
 * What a dry-run produces before any real writes happen.
 * Shown to the operator in the migration preview UI.
 */
export interface MigrationPreview {
  migrationId: string;
  version: string;
  description: string;
  estimatedAffectedCount?: number;
  /** Simulated statistics from running `up()` on the cloned store. */
  simulatedResult: MigrationUpResult;
  /** Errors from running `validate()` on the post-dry-run clone. */
  validationErrors: string[];
  /** True when the dry-run and validation both passed. */
  safe: boolean;
  rollbackNote: string;
  previewedAt: string;
}

// ─── Run record ───────────────────────────────────────────────────────────────

export type MigrationRunStatus =
  | 'success'
  | 'validation_failed'
  | 'error';

/**
 * Persisted record of one migration execution.
 * Store these alongside your application data so maintainers can audit the
 * full migration history.
 */
export interface MigrationRunRecord {
  id: string;
  migrationId: string;
  version: string;
  description: string;
  status: MigrationRunStatus;
  /** dryRun: true means no real writes were performed. */
  dryRun: boolean;
  result?: MigrationUpResult;
  /** Validation errors found after the migration ran. */
  validationErrors: string[];
  /** Top-level error message if the migration itself threw. */
  error?: string;
  rollbackNote: string;
  startedAt: string;
  finishedAt: string;
  /** Correlation ID linking this run to a user action or deployment. */
  correlationId?: string;
}

// ─── Runner options & result ──────────────────────────────────────────────────

export interface RunMigrationsOptions {
  /** Default true — safe default; set to false to apply real writes. */
  dryRun?: boolean;
  /** Only run migrations whose IDs are in this list. */
  only?: string[];
  /** Skip migrations whose IDs are in this list. */
  skip?: string[];
  correlationId?: string;
}

export interface RunMigrationsResult {
  dryRun: boolean;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  previews: MigrationPreview[];       // populated during dry-run
  runs: MigrationRunRecord[];          // populated during live run
  errors: string[];
  completedAt: string;
}

// ─── Post-check interface ─────────────────────────────────────────────────────

/**
 * A post-migration validation check.
 *
 * Register these with `MigrationRunner.addPostCheck()` to run after every live
 * migration batch.  Checks are independent of individual migrations so they can
 * assert global invariants (e.g. "no orphaned records").
 */
export interface PostMigrationCheck {
  id: string;
  description: string;
  run(store: MigrationStore): Promise<string[]>;
}
