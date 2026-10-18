/**
 * Operation Manager — Issue #54
 *
 * Deterministic recovery for multi-step operations.
 *
 * Key guarantees:
 *  1. IDEMPOTENCY — a step whose checkpoint already exists is skipped
 *     unconditionally.  The executor is never called twice for the same step.
 *  2. FORWARD-ONLY — operations resume from the first non-completed step.
 *     There is no "undo" path; use the import pipeline's rollback guidance for
 *     that concern.
 *  3. SIDE-EFFECT FENCING — only steps marked `sideEffect: true` write a
 *     checkpoint.  Pure computation steps always re-run on resume (cheap, safe).
 *  4. ABANDONED DETECTION — operations that have not progressed for
 *     `abandonAfterMs` are surfaced by `getDiagnostics()` so maintainers can
 *     investigate without waiting for a user report.
 *  5. DUPLICATE PREVENTION — a `paused` operation that is resumed while
 *     another tab's resume is still in-flight is detected via the
 *     `in_progress` status, preventing double side effects across tabs.
 */

import type {
  RecoverableOperation,
  OperationStep,
  OperationStatus,
  OperationType,
  RecoveryResult,
  OperationDiagnostics,
  RecoveryManagerOptions,
  StepExecutor,
  CheckpointStore,
} from './types';
import { getCheckpointStore } from './checkpoint-store';
import {
  validateOperationTransition,
  validateStepTransition,
} from './state-machine';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ABANDON_AFTER_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_RETENTION_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function newCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `trellis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newOperationId(): string {
  return newCorrelationId();
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class OperationManager {
  private readonly store: CheckpointStore;
  private readonly abandonAfterMs: number;
  private readonly retentionMs: number;

  constructor(opts: RecoveryManagerOptions = {}) {
    this.store          = opts.store ?? getCheckpointStore();
    this.abandonAfterMs = opts.abandonAfterMs ?? DEFAULT_ABANDON_AFTER_MS;
    this.retentionMs    = opts.retentionMs    ?? DEFAULT_RETENTION_MS;
  }

  // ─── Creating operations ────────────────────────────────────────────────────

  /**
   * Register a new multi-step operation before executing any step.
   *
   * Returns the persisted operation so the caller can hand the ID to the UI
   * (for recovery banners, progress tracking, etc.).
   */
  create(
    type: OperationType,
    label: string,
    stepDefinitions: Array<{ id: string; label: string; sideEffect: boolean }>,
    opts: { walletPublicKey?: string; context?: Record<string, unknown> } = {},
  ): RecoverableOperation {
    const op: RecoverableOperation = {
      id:               newOperationId(),
      type,
      label,
      status:           'pending',
      steps:            stepDefinitions.map(s => ({
        id:          s.id,
        label:       s.label,
        sideEffect:  s.sideEffect,
        status:      'pending' as const,
      })),
      currentStepIndex:  0,
      walletPublicKey:   opts.walletPublicKey,
      context:           opts.context ?? {},
      createdAt:         nowIso(),
      updatedAt:         nowIso(),
      correlationId:     newCorrelationId(),
      resumeCount:       0,
    };
    this.store.saveOperation(op);
    return op;
  }

  // ─── Executing ──────────────────────────────────────────────────────────────

  /**
   * Execute (or resume) an operation by running each step in order.
   *
   * Steps that already have a checkpoint are skipped.
   * The executor is called only for pending/failed/skipped steps that have not
   * been checkpointed yet.
   *
   * @param operationId  - ID returned by `create()` or from a recovery banner
   * @param executor     - caller-provided async function that runs a step
   */
  async execute(
    operationId: string,
    executor: StepExecutor,
  ): Promise<RecoveryResult> {
    let op = this.store.getOperation(operationId);
    if (!op) {
      return {
        operationId,
        completed: false,
        skippedSteps: [],
        executedSteps: [],
        error: `Operation ${operationId} not found`,
      };
    }

    // Guard: prevent double-execution from concurrent tabs.
    if (op.status === 'in_progress') {
      return {
        operationId,
        completed: false,
        skippedSteps: [],
        executedSteps: [],
        error: 'Operation is already in progress in another context',
      };
    }

    if (op.status === 'completed') {
      return { operationId, completed: true, skippedSteps: [], executedSteps: [] };
    }

    if (op.status === 'failed') {
      return {
        operationId,
        completed: false,
        skippedSteps: [],
        executedSteps: [],
        error: 'Operation has permanently failed and cannot be resumed',
      };
    }

    // Mark as in_progress so a concurrent tab sees the guard above.
    op = this._updateOp(op, { status: 'in_progress', resumeCount: op.resumeCount + 1 });

    const result: RecoveryResult = {
      operationId,
      completed: false,
      skippedSteps: [],
      executedSteps: [],
    };

    // Collect all existing checkpoints so we can skip completed side-effect steps.
    const checkpointedStepIds = new Set(
      this.store.listCheckpoints(operationId).map(cp => cp.stepId),
    );

    // Accumulate outputs from all steps so later steps can reference them.
    const previousOutputs: Record<string, unknown> = {};
    // Pre-populate from existing checkpoints.
    for (const cp of this.store.listCheckpoints(operationId)) {
      if (cp.output !== undefined) previousOutputs[cp.stepId] = cp.output;
    }

    for (let i = 0; i < op.steps.length; i++) {
      const step = op.steps[i];

      // Skip already-completed side-effect steps (checkpoint exists).
      if (step.sideEffect && checkpointedStepIds.has(step.id)) {
        result.skippedSteps.push(step.id);
        if (result.resumedFromStepId === undefined) {
          // Keep scanning — the resume point is after all checkpointed steps.
        }
        continue;
      }

      // Skip already-completed non-side-effect steps (status flag).
      if (step.status === 'completed') {
        result.skippedSteps.push(step.id);
        continue;
      }

      // This is the first non-completed step — record where we resumed from.
      if (result.resumedFromStepId === undefined) {
        result.resumedFromStepId = step.id;
      }

      // Mark the step as in_progress.
      op = this._updateStep(op, i, { status: 'in_progress', startedAt: nowIso() });

      try {
        const output = await executor(step, op.context ?? {}, previousOutputs);

        // Persist checkpoint for side-effect steps BEFORE marking success,
        // so a crash between the two leaves the step re-runnable (step status
        // is still `in_progress`, but checkpoint will prevent a second side
        // effect on the next resume).
        if (step.sideEffect) {
          this.store.saveCheckpoint({
            operationId,
            stepId:     step.id,
            stepIndex:  i,
            output,
            savedAt:    nowIso(),
          });
        }

        if (output !== undefined) previousOutputs[step.id] = output;

        op = this._updateStep(op, i, {
          status:     'completed',
          finishedAt: nowIso(),
          output,
        });
        result.executedSteps.push(step.id);
        op = this._updateOp(op, { currentStepIndex: i + 1 });

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        op = this._updateStep(op, i, {
          status:     'failed',
          finishedAt: nowIso(),
          error:      message,
        });
        result.error = message;
        // Pause — not permanently failed — so the user can retry.
        op = this._updateOp(op, { status: 'paused' });
        return result;
      }
    }

    // All steps done.
    op = this._updateOp(op, { status: 'completed', finishedAt: nowIso() });
    result.completed = true;
    return result;
  }

  // ─── Querying ───────────────────────────────────────────────────────────────

  getOperation(id: string): RecoverableOperation | null {
    return this.store.getOperation(id);
  }

  /**
   * All operations that are `paused` (interrupted mid-flow) and therefore
   * eligible for user-initiated recovery.
   */
  listRecoverable(): RecoverableOperation[] {
    return this.store
      .listOperations()
      .filter(op => op.status === 'paused');
  }

  /**
   * All operations the user can see regardless of status (for history panels).
   */
  listAll(): RecoverableOperation[] {
    return this.store.listOperations();
  }

  // ─── Abandonment sweep ──────────────────────────────────────────────────────

  /**
   * Mark stale in-progress / paused operations as `abandoned`.
   * Call this on app init or on a periodic timer (e.g. every 5 minutes).
   */
  sweepAbandoned(): RecoverableOperation[] {
    const cutoff = Date.now() - this.abandonAfterMs;
    const ops    = this.store.listOperations();
    const swept: RecoverableOperation[] = [];

    for (const op of ops) {
      if (op.status !== 'paused' && op.status !== 'in_progress') continue;
      if (new Date(op.updatedAt).getTime() < cutoff) {
        const updated = this._updateOp(op, { status: 'abandoned' });
        swept.push(updated);
      }
    }
    return swept;
  }

  /**
   * Delete completed/failed/abandoned operations older than `retentionMs`.
   * Safe to call periodically to keep localStorage tidy.
   */
  pruneExpired(): number {
    const cutoff = Date.now() - this.retentionMs;
    const ops    = this.store.listOperations();
    let pruned   = 0;

    for (const op of ops) {
      if (!['completed', 'failed', 'abandoned'].includes(op.status)) continue;
      const finishTime = op.finishedAt
        ? new Date(op.finishedAt).getTime()
        : new Date(op.updatedAt).getTime();
      if (finishTime < cutoff) {
        this.store.deleteOperation(op.id);
        pruned++;
      }
    }
    return pruned;
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────────

  /**
   * Maintainer-facing summary: counts by status, list of stuck/abandoned ops.
   *
   * "Stuck" means `in_progress` or `paused` for longer than `abandonAfterMs`.
   */
  getDiagnostics(): OperationDiagnostics {
    this.sweepAbandoned();
    const ops     = this.store.listOperations();
    const cutoff  = Date.now() - this.abandonAfterMs;

    const byStatus = {
      pending:     0,
      in_progress: 0,
      paused:      0,
      completed:   0,
      failed:      0,
      abandoned:   0,
    } as Record<OperationStatus, number>;

    const stuck: RecoverableOperation[] = [];
    const abandoned: RecoverableOperation[] = [];

    for (const op of ops) {
      byStatus[op.status] = (byStatus[op.status] ?? 0) + 1;

      if (op.status === 'abandoned') {
        abandoned.push(op);
      } else if (
        (op.status === 'in_progress' || op.status === 'paused') &&
        new Date(op.updatedAt).getTime() < cutoff
      ) {
        stuck.push(op);
      }
    }

    return {
      total: ops.length,
      byStatus,
      stuck,
      abandoned,
      generatedAt: nowIso(),
    };
  }

  // ─── Lifecycle transition operations ────────────────────────────────────────

  /**
   * Explicitly transition an operation to terminal failed status.
   * Legal from `paused` or `abandoned` states.
   */
  abortOperation(operationId: string, reason?: string): RecoverableOperation {
    const op = this.store.getOperation(operationId);
    if (!op) throw new Error(`Operation ${operationId} not found`);
    return this._updateOp(op, {
      status: 'failed',
      finishedAt: nowIso(),
      context: { ...op.context, abortReason: reason },
    });
  }

  // ─── Mutation helpers ────────────────────────────────────────────────────────

  private _updateOp(
    op: RecoverableOperation,
    patch: Partial<RecoverableOperation>,
  ): RecoverableOperation {
    if (patch.status && patch.status !== op.status) {
      validateOperationTransition(op, patch.status);
    }
    const updated: RecoverableOperation = { ...op, ...patch, updatedAt: nowIso() };
    this.store.saveOperation(updated);
    return updated;
  }

  private _updateStep(
    op: RecoverableOperation,
    index: number,
    patch: Partial<OperationStep>,
  ): RecoverableOperation {
    const targetStep = op.steps[index];
    if (patch.status && targetStep && patch.status !== targetStep.status) {
      validateStepTransition(targetStep, patch.status);
    }
    const steps = op.steps.map((s, i) =>
      i === index ? { ...s, ...patch } : s,
    );
    return this._updateOp(op, { steps });
  }
}

// ─── Default singleton ────────────────────────────────────────────────────────

let _defaultManager: OperationManager | null = null;

export function getOperationManager(): OperationManager {
  if (!_defaultManager) _defaultManager = new OperationManager();
  return _defaultManager;
}

/** Test/support helper: replace the singleton. */
export function setOperationManager(manager: OperationManager): void {
  _defaultManager = manager;
}
