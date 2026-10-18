import { diffJson, diffLines, Change } from 'diff';
import { ContractStateSchema } from '../types';

export interface SchemaDiffRlsult {
  hasChanges: boolean;
  hasBreakingChanges: boolean;
  changes: Change[];
}

/**
 * Compares two Soroban contract state schemas.
 * A breaking change in a schema is typically the REMOVAL of an existing field,
 * or a CHANGE in the type of an existing field. Adding new fields is usually safe.
 */
export const compareSchemas = (
  oldSchema: ContractStateSchema,
  newSchema: ContractStateSchema,
): SchemaDiffRlsult => {
  const differences = diffJson(oldSchema.fields, newSchema.fields);

  let hasChanges = false;
  let hasBreakingChanges = false;

  differences.forEach((part) => {
    if (part.added || part.removed) {
      hasChanges = true;
    }
    // If a field was removed from the old schema, it's a breaking change for existing state
    if (part.removed) {
      hasBreakingChanges = true;
    }
  });

  return {
    hasChanges,
    hasBreakingChanges,
    changes: differences
  };
};

export const compareText = (oldText: string, newText: string): Change[] => {
  return diffLines(oldText, newText);
};

// -----------------------------------------------------------------------------
// Operator-safe backfill tool: dry-run diff + resumable checkpoints
// -----------------------------------------------------------------------------

export interface BackfillRecord {
  id: string;
  [key: string]: unknown;
}

export interface BackfillCheckpoint {
  /** Identifier of the backfill job (e.g. name + version). */
  jobId: string;
  /** Id of the last record that was successfully processed. */
  lastProcessedId: string | null;
  /** Number of records successfully processed so far. */
  processedCount: number;
  /** Number of records skipped (validation or predicate failures). */
  skippedCount: number;
  /** Number of records that failed with an error. */
  failedCount: number;
  /** Ids that were skipped, for operator review. */
  skippedIds: string[];
  /** Ids that failed, with the error message. */
  failedIds: Array<{ id: string; error: string }>;
  /** Whether the job completed all records. */
  completed: boolean;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

export interface BackfillDiffEntry {
  id: string;
  kind: 'added' | 'removed' | 'unchanged' | 'changed';
  /** Human-readable description of the change. */
  description: string;
  /** The before value (if any). */
  before?: unknown;
  /** The after value (if any). */
  after?: unknown;
  /** Whether this change is considered breaking. */
  breaking: boolean;
}

export interface BackfillDiffResult {
  hasChanges: boolean;
  hasBreakingChanges: boolean;
  entries: BackfillDiffEntry[];
  /** Ids that would be written if the backfill were applied. */
  wouldWriteIds: string[];
  /** Ids that would be skipped. */
  wouldSkipIds: string[];
}

export interface BackfillOptions {
  /** When true, no writes are performed and only a diff is produced. */
  dryRun: boolean;
  /** Maximum number of records to process in this run. */
  limit?: number;
  /** Resume from a previous checkpoint. */
  checkpoint?: BackfillCheckpoint | null;
  /** Callback invoked after each record is processed. */
  onProgress?: (result: BackfillCheckpoint) => void;
  /** Callback invoked when a record is skipped. */
  onSkip?: (id: string, reason: string) => void;
  /** Callback invoked when a record fails. */
  onError?: (id: string, error: Error) => void;
}

export interface BackfillResult {
  checkpoint: BackfillCheckpoint;
  diff: BackfillDiffResult;
  /** Whether the run was a dry run. */
  dryRun: boolean;
  /** Whether the job completed all records. */
  completed: boolean;
}

export type BackfillWriter = (id: string, payload: unknown) => Promise<void>;

export type BackfillTransform = (record: BackfillRecord) => unknown;

export type BackfillPredicate = (record: BackfillRecord) => boolean;

export interface BackfillConfig {
  jobId: string;
  transform: BackfillTransform;
  /** Optional predicate; records that fail it are skipped. */
  shouldProcess?: BackfillPredicate;
  /** Optional validator; records that fail it are skipped. */
  validate?: (record: BackfillRecord) => boolean;
  /** Writer invoked for each processed record. */
  write: BackfillWriter;
}

export const createEmptyCheckpoint = (jobId: string): BackfillCheckpoint => ({
  jobId,
  lastProcessedId: null,
  processedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  skippedIds: [],
  failedIds: [],
  completed: false,
  updatedAt: new Date(0).toISOString(),
});

const cloneCheckpoint = (cp: BackfillCheckpoint): BackfillCheckpoint => ({
  ...cp,
  skippedIds: [...cp.skippedIds],
  failedIds: cp.failedIds.map((f) => ({ ...f })),
});

export const serializeCheckpoint = (cp: BackfillCheckpoint): string =>
  JSON.stringify(cp, null, 2);

export const deserializeCheckpoint = (raw: string): BackfillCheckpoint => {
  const parsed = JSON.parse(raw) as BackfillCheckpoint;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid checkpoint: expected an object');
  }
  if (typeof parsed.jobId !== 'string') {
    throw new Error('Invalid checkpoint: jobId must be a string');
  }
  return {
    jobId: parsed.jobId,
    lastProcessedId: parsed.lastProcessedId ?? null,
    processedCount: Number(parsed.processedCount ?? 0),
    skippedCount: Number(parsed.skippedCount ?? 0),
    failedCount: Number(parsed.failedCount ?? 0),
    skippedIds: Array.isArray(parsed.skippedIds) ? parsed.skippedIds.map(String) : [],
    failedIds: Array.isArray(parsed.failedIds)
      ? parsed.failedIds.map((f) => ({ id: String(f.id), error: String(f.error) }))
      : [],
    completed: Boolean(parsed.completed),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
};

/**
 * Compute a dry-run diff for a backfill job without performing any writes.
 * Respects an existing checkpoint so operators can preview the remaining work.
 */
export const computeBackfillDiff = (
  records: BackfillRecord[],
  config: BackfillConfig,
  options: BackfillOptions,
): BackfillDiffResult => {
  const checkpoint = options.checkpoint ?? createEmptyCheckpoint(config.jobId);
  const entries: BackfillDiffEntry[] = [];
  const wouldWriteIds: string[] = [];
  const wouldSkipIds: string[] = [];

  const startIndex = checkpoint.lastProcessedId
    ? records.findIndex((r) => r.id === checkpoint.lastProcessedId) + 1
    : 0;

  const slice = options.limit != null
    ? records.slice(startIndex, startIndex + options.limit)
    : records.slice(startIndex);

  for (const record of slice) {
    if (config.shouldProcess && !config.shouldProcess(record)) {
      wouldSkipIds.push(record.id);
      entries.push({
        id: record.id,
        kind: 'unchanged',
        description: 'skipped by predicate',
        breaking: false,
      });
      continue;
    }
    if (config.validate && !config.validate(record)) {
      wouldSkipIds.push(record.id);
      entries.push({
        id: record.id,
        kind: 'unchanged',
        description: 'skipped by validator',
        breaking: false,
      });
      continue;
    }

    const before = record;
    const after = config.transform(record);
    const diff = diffJson(before, after);
    const hasChange = diff.some((p) => p.added || p.removed);
    const breaking = diff.some((p) => Boolean(p.removed));

    if (hasChange) {
      wouldWriteIds.push(record.id);
      entries.push({
        id: record.id,
        kind: 'changed',
        description: `diff for ${record.id}`,
        before,
        after,
        breaking,
      });
    } else {
      entries.push({
        id: record.id,
        kind: 'unchanged',
        description: 'no change',
        breaking: false,
      });
    }
  }

  return {
    hasChanges: wouldWriteIds.length > 0,
    hasBreakingChanges: entries.some((e) => e.breaking),
    entries,
    wouldWriteIds,
    wouldSkipIds,
  };
};

/**
 * Run a backfill job with dry-run support and resumable checkpoints.
 *
 * - In dry-run mode the diff is computed but no writes are performed.
 * - In apply mode the writer is invoked for each changed or added record.
 * - Checkpoints are updated after each record so a failure can be resumed.
 * - Skipped and failed records are reported in the resulting checkpoint.
 */
export const runBackfill = async (
  records: BackfillRecord[],
  config: BackfillConfig,
  options: BackfillOptions,
): Promise<BackfillResult> => {
  const checkpoint = cloneCheckpoint(
    options.checkpoint ?? createEmptyCheckpoint(config.jobId),
  );

  if (checkpoint.jobId !== config.jobId) {
    throw new Error(
      `Checkpoint jobId ${checkpoint.jobId} does not match config jobId ${config.jobId}. Refusing to resume.`,
    );
  }

  const diff = computeBackfillDiff(records, config, { ...options, checkpoint });

  if (options.dryRun) {
    return {
      checkpoint,
      diff,
      dryRun: true,
      completed: false,
    };
  }

  const startIndex = checkpoint.lastProcessedId
    ? records.findIndex((r) => r.id === checkpoint.lastProcessedId) + 1
    : 0;

  const slice = options.limit != null
    ? records.slice(startIndex, startIndex + options.limit)
    : records.slice(startIndex);

  for (const record of slice) {
    try {
      if (config.shouldProcess && !config.shouldProcess(record)) {
        checkpoint.skippedCount += 1;
        checkpoint.skippedIds.push(record.id);
        options.onSkip?.(record.id, 'skipped by predicate');
        checkpoint.lastProcessedId = record.id;
        checkpoint.updatedAt = new Date().toISOString();
        options.onProgress?.(cloneCheckpoint(checkpoint));
        continue;
      }
      if (config.validate && !config.validate(record)) {
        checkpoint.skippedCount += 1;
        checkpoint.skippedIds.push(record.id);
        options.onSkip?.(record.id, 'skipped by validator');
        checkpoint.lastProcessedId = record.id;
        checkpoint.updatedAt = new Date().toISOString();
        options.onProgress?.(cloneCheckpoint(checkpoint));
        continue;
      }

      const payload = config.transform(record);
      const hasChange = diffJson(record, payload).some((p) => p.added || p.removed);
      if (hasChange) {
        await config.write(record.id, payload);
      }
      checkpoint.processedCount += 1;
      checkpoint.lastProcessedId = record.id;
      checkpoint.updatedAt = new Date().toISOString();
      options.onProgress?.(cloneCheckpoint(checkpoint));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      checkpoint.failedCount += 1;
      checkpoint.failedIds.push({ id: record.id, error: error.message });
      options.onError?.(record.id, error);
      // Do not advance lastProcessedId on failure so the record can be retried.
      checkpoint.updatedAt = new Date().toISOString();
      options.onProgress?.(cloneCheckpoint(checkpoint));
      break;
    }
  }

  const lastId = checkpoint.lastProcessedId;
  const lastIndex = lastId ? records.findIndex((r) => r.id === lastId) : -1;
  const completed = lastIndex >= records.length - 1 && checkpoint.failedCount === 0;
  checkpoint.completed = completed;
  checkpoint.updatedAt = new Date().toISOString();

  return {
    checkpoint,
    diff,
    dryRun: false,
    completed,
  };
};
