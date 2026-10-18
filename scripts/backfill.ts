import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CheckpointFile,
  CheckpointRecord,
  createEmptyCheckpoint,
  createFileCheckpointStore,
} from './backfill/checkpoint';

export interface BackfillRecord {
  id: string;
  [key: string]: unknown;
}

export interface BackfillPlan {
  id: string;
  action: 'update' | 'skip' | 'fail';
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export interface BackfillAdapter {
  /** Load all records to consider, in a deterministic order. */
  loadRecords(): Promise<BackfillRecord[]>;
  /** Produce a plan for a single record. */
  plan(record: BackfillRecord): Promise<BackfillPlan>;
  /** Apply a plan. Must be idompotent. */
  apply(plan: BackfillPlan): Promise<void>;
}

export interface RunOptions {
  dryRun: boolean;
  checkpointPath: string;
  reportPath?: string;
  limit?: number;
  maxAttempts: number;
  resume: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  checkpointPath: string;
  reportPath?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export const buildPlanDiff = (before: unknown, after: unknown): { before: unknown; after: unknown } => {
  return { before, after };
};

export const formatPlanDiff = (plan: BackfillPlan): string => {
  if (plan.action === 'skip') {
    return `skip ${plan.id}: ${plan.reason ?? 'no changes'}`;
  }
  if (plan.action === 'fail') {
    return `fail ${plan.id}: ${plan.reason ?? 'unknown failure'}`;
  }
  const before = JSON.stringify(plan.before ?? null);
  const after = JSON.stringify(plan.after ?? null);
  return `update ${plan.id}: ${before} -> ${after}`;
};

export const runBackfill = async (
  adapter: BackfillAdapter,
  options: RunOptions,
): Promise<RunResult> => {
  const log = options.log ?? (() => {});
  const store = createFileCheckpointStore(options.checkpointPath);

  let checkpoint: CheckpointFile;
  if (options.resume) {
    const existing = await store.read();
    if (existing) {
      checkpoint = existing;
      log(`resuming from cursor ${checkpoint.cursor}`);
    } else {
      checkpoint = createEmptyCheckpoint();
    }
  } else {
    checkpoint = createEmptyCheckpoint();
  }

  const records = await adapter.loadRecords();
  const limit = options.limit ?? records.length;
  const slice = records.slice(checkpoint.cursor, limit);

  const report: Array<{ plan: BackfillPlan; status: CheckpointRecord['status']; error?: string }> = [];
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < slice.length; i++) {
    const record = slice[i];
    const id = record.id;
    const existing = checkpoint.records[id];
    if (existing && existing.status === 'success') {
      skipped += 1;
      report.push({ plan: { id, action: 'skip', reason: 'already applied' }, status: 'skipped' });
      checkpoint.cursor = checkpoint.cursor + 1;
      continue;
    }

    let plan: BackfillPlan;
    try {
      plan = await adapter.plan(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      checkpoint.records[id] = {
        id,
        status: 'failed',
        attempts: (existing ?? ({ attempts: 0 } as CheckpointRecord)).attempts + 1,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      report.push({ plan: { id, action: 'fail', reason: message }, status: 'failed', error: message });
      checkpoint.cursor = checkpoint.cursor + 1;
      continue;
    }

    if (plan.action === 'skip') {
      skipped += 1;
      checkpoint.records[id] = {
        id,
        status: 'skipped',
        attempts: (existing ?? ({ attempts: 0 } as CheckpointRecord)).attempts,
        updatedAt: new Date().toISOString(),
      };
      report.push({ plan, status: 'skipped' });
      checkpoint.cursor = checkpoint.cursor + 1;
      continue;
    }

    if (plan.action === 'fail') {
      failed += 1;
      checkpoint.records[id] = {
        id,
        status: 'failed',
        attempts: (existing ?? ({ attempts: 0 } as CheckpointRecord)).attempts + 1,
        error: plan.reason ?? 'planned failure',
        updatedAt: new Date().toISOString(),
      };
      report.push({ plan, status: 'failed', error: plan.reason });
      checkpoint.cursor = checkpoint.cursor + 1;
      continue;
    }

    // action === 'update'
    if (options.dryRun) {
      applied += 1;
      report.push({ plan, status: 'pending' });
      log(formatPlanDiff(plan));
      checkpoint.cursor = checkpoint.cursor + 1;
      continue;
    }

    const attempts = (existing ?? ({ attempts: 0 } as CheckpointRecord)).attempts + 1;
    try {
      await adapter.apply(plan);
      applied += 1;
      checkpoint.records[id] = {
        id,
        status: 'success',
        attempts,
        updatedAt: new Date().toISOString(),
      };
      report.push({ plan, status: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      checkpoint.records[id] = {
        id,
        status: 'failed',
        attempts,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      report.push({ plan, status: 'failed', error: message });
    }

    checkpoint.cursor = checkpoint.cursor + 1;
    await store.write(checkpoint);
  }

  await store.write(checkpoint);

  if (options.reportPath) {
    const abs = path.resolve(options.reportPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf-8');
  }

  return {
    total: slice.length,
    applied,
    skipped,
    failed,
    dryRun: options.dryRun,
    checkpointPath: options.checkpointPath,
    reportPath: options.reportPath,
  };
};

export const parseCliOptions = (argv: string[]): RunOptions => {
  const { values } = parseArgs(argv, {
    'dry-run': { type: 'boolean', default: true },
    apply: { type: 'boolean', default: false },
    checkpoint: { type: 'string', default: '.trellis/backfill-checkpoint.json' },
    report: { type: 'string' },
    limit: { type: 'string' },
    resume: { type: 'boolean', default: true },
    'max-attempts': { type: 'string', default: String(DEFAULT_MAX_ATTEMPTS ) },
  });

  const dryRun = values.apply ? false : values['dry-run'];
  const limit = values.limit ? Number(values.limit) : undefined;
  const maxAttempts = values['max-attempts'] ? Number(values['max-attempts']) : DEFAULT_MAX_ATTEMPTS;

  return {
    dryRun,
    checkpointPath: values.checkpoint,
    reportPath: values.report,
    limit,
    maxAttempts,
    resume: values.resume,
  };
};

export const main = async (argv = process.argv.slice(2)): Promise<void> => {
  const options = parseCliOptions(argv);
  const adapterPath = process.env.TRELLIS_BACKFILL_ADAPTER;
  if (!adapterPath) {
    throw new Error(
      'TRELLIS_BACKFILL_ADAPTER is required. Point it at a module that exports a default BackfillAdapter.',
    );
  }
  const mod = (await import(path.toFileURL(adapterPath))) as { default?: BackfillAdapter } & BackfillAdapter;
  const adapter = (mod.default ?? mod) as BackfillAdapter;
  if (!adapter || typeof adapter.loadRecords !== 'function') {
    throw new Error('Adapter must implement loadRecords, plan, and apply.');
  }

  const result = await runBackfill(adapter, {
    ...options,
    log: (line) => console.log(line),
  });

  console.log(JSON.stringify(result, null, 2));
};

if (import.meta.url === path.toFileURL(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
