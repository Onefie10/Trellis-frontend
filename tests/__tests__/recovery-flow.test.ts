/**
 * Recovery Flow Tests — Issue #54
 *
 * Covers:
 *  - Operation creation and persistence
 *  - Step-by-step execution with checkpoint writing
 *  - Resume after interruption: completed side-effect steps are SKIPPED
 *  - Resume after interruption: failed steps are RETRIED
 *  - Concurrent-tab guard (in_progress status blocks a second executor)
 *  - Abandonment sweep marks idle in-progress ops
 *  - Completed operation is NOT re-executed
 *  - Diagnostics report counts and stuck ops
 *  - Pruning removes expired completed ops
 */

import { OperationManager } from '@/lib/recovery/operation-manager';
import { MemoryCheckpointStore } from '@/lib/recovery/checkpoint-store';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function buildManager(opts: { abandonAfterMs?: number; retentionMs?: number } = {}) {
  const store   = new MemoryCheckpointStore();
  const manager = new OperationManager({
    store,
    abandonAfterMs: opts.abandonAfterMs ?? 5_000,
    retentionMs:    opts.retentionMs    ?? 10_000,
  });
  return { store, manager };
}

const STEPS = [
  { id: 'build',  label: 'Build transaction', sideEffect: false },
  { id: 'sign',   label: 'Sign transaction',  sideEffect: true  },
  { id: 'submit', label: 'Submit to network', sideEffect: true  },
  { id: 'notify', label: 'Send notification', sideEffect: false },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OperationManager — creation', () => {
  it('creates an operation with pending status', () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Mint Agent', STEPS);

    expect(op.status).toBe('pending');
    expect(op.steps).toHaveLength(4);
    expect(op.steps.every(s => s.status === 'pending')).toBe(true);
    expect(op.resumeCount).toBe(0);
    expect(op.correlationId).toBeTruthy();
  });

  it('persists the operation in the store', () => {
    const { manager, store } = buildManager();
    const op = manager.create('stake', 'Stake XLM', STEPS);

    const retrieved = store.getOperation(op.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(op.id);
  });
});

describe('OperationManager — successful execution', () => {
  it('executes all steps and marks operation completed', async () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Mint Agent', STEPS);

    const executor = jest.fn().mockResolvedValue('output');
    const result   = await manager.execute(op.id, executor);

    expect(result.completed).toBe(true);
    expect(result.executedSteps).toHaveLength(4);
    expect(result.skippedSteps).toHaveLength(0);
    expect(executor).toHaveBeenCalledTimes(4);

    const finished = manager.getOperation(op.id)!;
    expect(finished.status).toBe('completed');
  });

  it('writes checkpoints only for side-effect steps', async () => {
    const { manager, store } = buildManager();
    const op = manager.create('agent_mint', 'Mint Agent', STEPS);

    await manager.execute(op.id, jest.fn().mockResolvedValue('x'));

    const cps = store.listCheckpoints(op.id);
    const cpStepIds = cps.map(c => c.stepId);

    expect(cpStepIds).toContain('sign');
    expect(cpStepIds).toContain('submit');
    expect(cpStepIds).not.toContain('build');
    expect(cpStepIds).not.toContain('notify');
  });

  it('passes previous step outputs to subsequent steps', async () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Test', STEPS);

    const executor = jest.fn(async (_step: { id: string }, _ctx: Record<string, unknown>, prev: Record<string, unknown>) => {
      void prev; // prev is captured via mock.calls[3] below
      return `out:${_step.id}`;
    });

    await manager.execute(op.id, executor);

    // The 4th step (notify) should have seen the outputs of all 3 prior steps
    const lastCall = executor.mock.calls[3];
    const prevOutputs = lastCall[2] as Record<string, unknown>;
    expect(prevOutputs['build']).toBe('out:build');
    expect(prevOutputs['sign']).toBe('out:sign');
    expect(prevOutputs['submit']).toBe('out:submit');
  });
});

describe('OperationManager — interruption and resume', () => {
  it('pauses on step failure and retries from that step on next execute()', async () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Mint Agent', STEPS);

    let callCount = 0;
    const firstExecutor = jest.fn(async (step) => {
      callCount++;
      if (step.id === 'sign') throw new Error('Wallet rejected');
      return 'ok';
    });

    const firstRun = await manager.execute(op.id, firstExecutor);

    expect(firstRun.completed).toBe(false);
    expect(firstRun.error).toMatch(/Wallet rejected/);
    expect(manager.getOperation(op.id)!.status).toBe('paused');

    // Resume — 'build' already completed (no sideEffect checkpoint so status
    // is on the step), 'sign' failed, so resume retries from 'sign'.
    const secondExecutor = jest.fn().mockResolvedValue('ok');
    const secondRun = await manager.execute(op.id, secondExecutor);

    expect(secondRun.completed).toBe(true);
    // 'build' was already completed on first run — should be in skipped on second run
    expect(secondRun.skippedSteps).toContain('build');
    expect(secondRun.executedSteps).toContain('sign');
    expect(secondRun.executedSteps).toContain('submit');
    expect(secondRun.executedSteps).toContain('notify');
  });

  it('skips checkpointed side-effect steps on resume', async () => {
    const { manager, store } = buildManager();
    const op = manager.create('agent_mint', 'Mint Agent', STEPS);

    // Manually inject a checkpoint for 'sign' to simulate a crash after sign
    // but before the operation status was updated.
    store.saveCheckpoint({ operationId: op.id, stepId: 'sign', stepIndex: 1, output: 'signed-tx-hash', savedAt: new Date().toISOString() });

    let signCallCount = 0;
    const executor = jest.fn(async (step) => {
      if (step.id === 'sign') { signCallCount++; }
      if (step.id === 'submit') throw new Error('Network error');
      return 'ok';
    });

    await manager.execute(op.id, executor);

    // 'sign' must NOT have been called because its checkpoint exists
    expect(signCallCount).toBe(0);
  });

  it('increments resumeCount each time execute() is called', async () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Test', STEPS);

    const failingExecutor = jest.fn(async (step) => {
      if (step.id === 'sign') throw new Error('fail');
      return 'ok';
    });

    await manager.execute(op.id, failingExecutor); // resumeCount → 1
    await manager.execute(op.id, failingExecutor); // resumeCount → 2

    const retrieved = manager.getOperation(op.id)!;
    expect(retrieved.resumeCount).toBe(2);
  });
});

describe('OperationManager — concurrent tab guard', () => {
  it('blocks a second execute() while the first is in_progress', async () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Test', STEPS);

    // Manually set the operation to in_progress to simulate another tab
    const stored = manager.getOperation(op.id)!;
    const store  = new MemoryCheckpointStore();
    store.saveOperation({ ...stored, status: 'in_progress' });

    const mgr2 = new OperationManager({ store });
    const result = await mgr2.execute(op.id, jest.fn());

    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/already in progress/);
  });
});

describe('OperationManager — completed operation', () => {
  it('returns completed=true without re-running steps', async () => {
    const { manager } = buildManager();
    const op = manager.create('agent_mint', 'Test', STEPS);
    await manager.execute(op.id, jest.fn().mockResolvedValue('ok'));

    const executor2 = jest.fn().mockResolvedValue('ok');
    const result    = await manager.execute(op.id, executor2);

    expect(result.completed).toBe(true);
    expect(executor2).not.toHaveBeenCalled();
  });
});

describe('OperationManager — abandonment sweep', () => {
  it('marks idle in-progress operations as abandoned', async () => {
    const { manager, store } = buildManager({ abandonAfterMs: 100 });
    const op = manager.create('stake', 'Test', STEPS);

    // Force the op into paused with an old timestamp
    store.saveOperation({
      ...manager.getOperation(op.id)!,
      status:    'paused',
      updatedAt: new Date(Date.now() - 200).toISOString(),
    });

    const swept = manager.sweepAbandoned();
    expect(swept).toHaveLength(1);
    expect(swept[0].status).toBe('abandoned');
  });

  it('does not sweep recently updated operations', async () => {
    const { manager, store } = buildManager({ abandonAfterMs: 60_000 });
    const op = manager.create('stake', 'Test', STEPS);

    store.saveOperation({ ...manager.getOperation(op.id)!, status: 'paused' });

    const swept = manager.sweepAbandoned();
    expect(swept).toHaveLength(0);
  });
});

describe('OperationManager — diagnostics', () => {
  it('reports counts by status', async () => {
    const { manager } = buildManager();

    const op1 = manager.create('stake', 'Op1', STEPS);
    const op2 = manager.create('stake', 'Op2', STEPS);

    await manager.execute(op1.id, jest.fn().mockResolvedValue('ok'));
    await manager.execute(op2.id, jest.fn(async (step) => {
      if (step.id === 'sign') throw new Error('fail');
      return 'ok';
    }));

    const diag = manager.getDiagnostics();
    expect(diag.byStatus.completed).toBeGreaterThanOrEqual(1);
    expect(diag.byStatus.paused).toBeGreaterThanOrEqual(1);
    expect(diag.total).toBeGreaterThanOrEqual(2);
  });
});

describe('OperationManager — pruning', () => {
  it('prunes completed operations older than retentionMs', () => {
    const { manager, store } = buildManager({ retentionMs: 100 });
    const op = manager.create('stake', 'Test', STEPS);

    store.saveOperation({
      ...manager.getOperation(op.id)!,
      status:     'completed',
      finishedAt: new Date(Date.now() - 200).toISOString(),
    });

    const pruned = manager.pruneExpired();
    expect(pruned).toBe(1);
    expect(manager.getOperation(op.id)).toBeNull();
  });
});

describe('OperationManager — recovery listing', () => {
  it('listRecoverable() returns only paused operations', async () => {
    const { manager } = buildManager();

    const op1 = manager.create('stake', 'Will complete', STEPS);
    const op2 = manager.create('stake', 'Will fail',    STEPS);

    await manager.execute(op1.id, jest.fn().mockResolvedValue('ok'));
    await manager.execute(op2.id, jest.fn(async (step) => {
      if (step.id === 'sign') throw new Error('fail');
      return 'ok';
    }));

    const recoverable = manager.listRecoverable();
    expect(recoverable.every(o => o.status === 'paused')).toBe(true);
    expect(recoverable.some(o => o.id === op2.id)).toBe(true);
    expect(recoverable.some(o => o.id === op1.id)).toBe(false);
  });
});
