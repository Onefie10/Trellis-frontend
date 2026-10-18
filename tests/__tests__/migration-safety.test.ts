/**
 * Migration Safety Framework Tests — Issue #56
 *
 * Covers:
 *  - Dry-run: zero writes to the real store
 *  - Dry-run: simulated result reflects what up() would do
 *  - Dry-run: validation errors are surfaced without writes
 *  - Live run: migration is applied and records are persisted
 *  - Live run: already-applied migrations are skipped (idempotency)
 *  - Live run: stops on first failure and reports error
 *  - Live run: validation failure marks run as validation_failed
 *  - Post-migration checks run after all migrations
 *  - rollbackNote is present in every preview and run record
 *  - preview() returns safe:false when validate() fails
 *  - Runner.isApplied() reflects applied state
 *  - Partial run with `only` filter
 *  - Partial run with `skip` filter
 */

import { MigrationRunner, MemoryMigrationStore } from '@/lib/migration/runner';
import type { Migration, PostMigrationCheck } from '@/lib/migration/types';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function buildRunner() {
  const store  = new MemoryMigrationStore();
  const runner = new MigrationRunner(store);
  return { store, runner };
}

/** A migration that adds a `schemaVersion` field to every `agents` record. */
const migrationV1: Migration = {
  id:          'agents-v1-add-schema-version',
  version:     '1.0',
  description: 'Add schemaVersion field to all agent records',
  estimatedAffectedCount: 3,
  rollbackNote: 'Delete the schemaVersion field from all agent records, then re-run with dryRun: false.',
  async up(store) {
    const agents = store.getAll('agents');
    for (const agent of agents) {
      store.set('agents', agent.id as string, { ...agent, schemaVersion: '1.0' });
    }
    return { created: 0, updated: agents.length, deleted: 0 };
  },
  async validate(store) {
    const errors: string[] = [];
    for (const agent of store.getAll('agents')) {
      if (agent.schemaVersion !== '1.0') {
        errors.push(`Agent ${agent.id} missing schemaVersion`);
      }
    }
    return errors;
  },
};

/** A migration that intentionally throws. */
const failingMigration: Migration = {
  id:          'breaking-migration',
  version:     '2.0',
  description: 'This migration always throws',
  rollbackNote: 'No rollback needed — migration never ran.',
  async up() {
    throw new Error('Intentional failure');
  },
};

/** A migration whose validate() always fails. */
const invalidatingMigration: Migration = {
  id:          'invalidating-migration',
  version:     '3.0',
  description: 'Migration that fails validation',
  rollbackNote: 'Restore the snapshot taken before migration.',
  async up(store) {
    store.set('agents', 'bad', { id: 'bad' });
    return { created: 1, updated: 0, deleted: 0 };
  },
  async validate() {
    return ['Record "bad" violates schema'];
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MigrationRunner — dry-run', () => {
  it('does not modify the real store during dry-run', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });
    store.set('agents', 'ag-2', { id: 'ag-2', name: 'Beta' });

    runner.register(migrationV1);

    const before = store.getAll('agents').map(a => ({ ...a }));
    await runner.run({ dryRun: true });
    const after = store.getAll('agents');

    // Real store must be unchanged
    expect(after).toHaveLength(2);
    expect(after.every(a => (a as any).schemaVersion === undefined)).toBe(true);
    expect(after).toEqual(before);
  });

  it('dry-run result reflects simulated changes', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });
    runner.register(migrationV1);

    const result = await runner.run({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.previews).toHaveLength(1);
    expect(result.previews[0].simulatedResult.updated).toBe(1);
    expect(result.previews[0].validationErrors).toHaveLength(0);
    expect(result.previews[0].safe).toBe(true);
  });

  it('dry-run surfaces validation errors when validate() fails', async () => {
    const { runner } = buildRunner();
    runner.register(invalidatingMigration);

    const result = await runner.run({ dryRun: true });

    expect(result.previews[0].safe).toBe(false);
    expect(result.previews[0].validationErrors.length).toBeGreaterThan(0);
  });

  it('every preview contains a rollbackNote', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });
    runner.register(migrationV1);

    const result = await runner.run({ dryRun: true });

    for (const preview of result.previews) {
      expect(preview.rollbackNote).toBeTruthy();
    }
  });
});

describe('MigrationRunner — live run', () => {
  it('applies migration and persists changes', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });
    runner.register(migrationV1);

    const result = await runner.run({ dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);

    const updated = store.getAll('agents').find(a => a.id === 'ag-1');
    expect(updated?.schemaVersion).toBe('1.0');
  });

  it('is idempotent — skips already-applied migrations', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });

    runner.register(migrationV1);

    await runner.run({ dryRun: false }); // First run
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' }); // Reset data

    const secondResult = await runner.run({ dryRun: false }); // Second run
    expect(secondResult.total).toBe(0);   // Nothing to run
    expect(secondResult.success).toBe(0);

    // isApplied() reflects state
    expect(runner.isApplied('agents-v1-add-schema-version')).toBe(true);
  });

  it('stops on first failure and reports error', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1' });

    runner.register(failingMigration);
    runner.register(migrationV1);

    const result = await runner.run({ dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.errors.some(e => e.includes('Intentional failure'))).toBe(true);
    // migrationV1 should not have run
    expect(runner.isApplied('agents-v1-add-schema-version')).toBe(false);
  });

  it('marks run as validation_failed when validate() fails', async () => {
    const { runner } = buildRunner();
    runner.register(invalidatingMigration);

    const result = await runner.run({ dryRun: false });

    expect(result.failed).toBe(1);
    const runRecord = result.runs[0];
    expect(runRecord.status).toBe('validation_failed');
    expect(runRecord.validationErrors.length).toBeGreaterThan(0);
  });

  it('every run record contains a rollbackNote', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1' });
    runner.register(migrationV1);

    const result = await runner.run({ dryRun: false });

    for (const run of result.runs) {
      expect(run.rollbackNote).toBeTruthy();
    }
  });
});

describe('MigrationRunner — post-migration checks', () => {
  it('runs post checks after successful live migrations', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });

    runner.register(migrationV1);

    const checkMock = jest.fn(async () => []);
    const postCheck: PostMigrationCheck = {
      id:          'all-agents-have-schema-version',
      description: 'Every agent must have a schemaVersion',
      run:         checkMock,
    };
    runner.addPostCheck(postCheck);

    await runner.run({ dryRun: false });

    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('reports post-check failures in result.errors', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1' });
    runner.register(migrationV1);

    const failingCheck: PostMigrationCheck = {
      id:          'failing-check',
      description: 'Always fails',
      run:         async () => ['Post-check failure'],
    };
    runner.addPostCheck(failingCheck);

    const result = await runner.run({ dryRun: false });

    expect(result.errors.some(e => e.includes('Post-check failure'))).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
  });

  it('does NOT run post checks during dry-run', async () => {
    const { runner } = buildRunner();
    runner.register(migrationV1);

    const checkMock = jest.fn(async () => []);
    runner.addPostCheck({ id: 'check', description: 'd', run: checkMock });

    await runner.run({ dryRun: true });
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe('MigrationRunner — filtering', () => {
  it('runs only migrations in the `only` list', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1' });
    runner.register(migrationV1);
    runner.register(invalidatingMigration);

    const result = await runner.run({ dryRun: false, only: ['agents-v1-add-schema-version'] });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].migrationId).toBe('agents-v1-add-schema-version');
    expect(runner.isApplied('invalidating-migration')).toBe(false);
  });

  it('skips migrations in the `skip` list', async () => {
    const { store, runner } = buildRunner();
    store.set('agents', 'ag-1', { id: 'ag-1' });
    runner.register(migrationV1);
    runner.register(invalidatingMigration);

    const result = await runner.run({ dryRun: false, skip: ['invalidating-migration'] });

    expect(result.runs.every(r => r.migrationId !== 'invalidating-migration')).toBe(true);
  });
});

describe('MemoryMigrationStore', () => {
  it('snapshot and restore produce an exact clone', () => {
    const store = new MemoryMigrationStore();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Alpha' });
    store.set('agents', 'ag-2', { id: 'ag-2', name: 'Beta' });

    const snap = store.snapshot();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'MUTATED' });
    store.restore(snap);

    const restored = store.getAll('agents').find(a => a.id === 'ag-1');
    expect(restored?.name).toBe('Alpha');
  });

  it('modifications to the snapshot do not affect the store', () => {
    const store = new MemoryMigrationStore();
    store.set('agents', 'ag-1', { id: 'ag-1', name: 'Original' });

    const snap = store.snapshot();
    snap['agents']['ag-1'].name = 'Mutated via snapshot';

    const record = store.getAll('agents').find(a => a.id === 'ag-1');
    expect(record?.name).toBe('Original');
  });
});
