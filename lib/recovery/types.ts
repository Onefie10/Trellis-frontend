/**
 * Recovery Flow Types — Issue #54
 *
 * Multi-step operations (wallet transactions, agent minting, staking, import
 * pipelines) can be interrupted at any point: the wallet popup is dismissed,
 * the browser tab is closed, a network request times out, or a worker dies.
 *
 * This module defines the state machine and checkpoint contract that makes
 * those operations safely resumable without duplicate side effects.
 *
 * Design decisions:
 *   - Each operation has an ordered list of STEPS. Every step that produces
 *     an external side effect (on-chain submission, API write) is a checkpoint
 *     boundary.  Steps before the boundary are idempotent-safe to re-run;
 *     steps after are skipped on resume.
 *   - CHECKPOINTS are persisted immediately after a step succeeds, so a crash
 *     mid-step is treated as "step not yet complete" and the step retries.
 *   - An operation that has COMMITTED at least one checkpoint can always be
 *     resumed. An operation that is ABANDONED (no interaction for
 *     `abandonAfterMs`) shows a "needs your attention" banner with clear next
 *     steps rather than silently failing.
 *   - Completed and failed-terminal operations are kept for `retentionMs` so
 *     the diagnostics panel can surface them to maintainers.
 */

// ─── Step ────────────────────────────────────────────────────────────────────

/** Lifecycle of a single step within a multi-step operation. */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * A single step in a multi-step operation.
 *
 * `sideEffect` marks steps that touch external systems (chain, API, worker).
 * The recovery engine will NOT re-run a completed side-effect step; it skips
 * forward to the first non-completed step.
 */
export interface OperationStep {
  /** Stable identifier, unique within the operation. */
  id: string;
  /** Human-readable label shown in the recovery UI. */
  label: string;
  /** True when the step interacts with an external system. */
  sideEffect: boolean;
  status: StepStatus;
  /** ISO-8601 timestamp set when the step transitions to `in_progress`. */
  startedAt?: string;
  /** ISO-8601 timestamp set when the step reaches `completed` or `failed`. */
  finishedAt?: string;
  /** User-facing error message if the step failed. */
  error?: string;
  /** Arbitrary step-level output persisted for downstream steps (e.g. txHash). */
  output?: unknown;
}

// ─── Operation ───────────────────────────────────────────────────────────────

/** Top-level lifecycle of a multi-step operation. */
export type OperationStatus =
  | 'pending'      // Created, not yet started
  | 'in_progress'  // At least one step is running
  | 'paused'       // Interrupted — can be resumed
  | 'completed'    // All steps done successfully
  | 'failed'       // Terminal failure (not retryable)
  | 'abandoned';   // Timed-out without user interaction

/**
 * Well-known operation types that the recovery UI understands.
 * Extend this union as new multi-step flows are added.
 */
export type OperationType =
  | 'agent_mint'
  | 'stake'
  | 'unstake'
  | 'delegation_grant'
  | 'import_pipeline'
  | 'wallet_connect'
  | 'generic';

/** The full persistent record of a multi-step operation. */
export interface RecoverableOperation {
  /** Globally unique — use `crypto.randomUUID()`. */
  id: string;
  type: OperationType;
  /** Short description shown in the recovery banner. */
  label: string;
  status: OperationStatus;
  steps: OperationStep[];
  /** Index into `steps` of the step currently executing (0-based). */
  currentStepIndex: number;
  /** Wallet public key associated with this operation, if any. */
  walletPublicKey?: string;
  /** Arbitrary context the caller needs on resume (e.g. form values). */
  context?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Set when status transitions to `completed` or `failed`. */
  finishedAt?: string;
  /** Correlation ID for support diagnostics. */
  correlationId: string;
  /** How many times resumption has been attempted. */
  resumeCount: number;
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

/**
 * A snapshot written after each successful side-effect step.  Checkpoints are
 * the source-of-truth for "what has already happened" and make the recovery
 * engine idempotency-safe: any step whose checkpoint exists is skipped.
 */
export interface RecoveryCheckpoint {
  operationId: string;
  stepId: string;
  stepIndex: number;
  /** The step's output at the time of persistence. */
  output?: unknown;
  savedAt: string;
}

// ─── Recovery result ─────────────────────────────────────────────────────────

/** Returned by the recovery engine after a resume attempt. */
export interface RecoveryResult {
  operationId: string;
  /** True when the operation reached `completed` on this resume. */
  completed: boolean;
  /** The step the engine resumed from (skipping already-done steps). */
  resumedFromStepId?: string;
  /** Steps that were skipped because their checkpoint existed. */
  skippedSteps: string[];
  /** Steps that were re-executed on this resume. */
  executedSteps: string[];
  error?: string;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** Summary used by the maintainer diagnostics panel. */
export interface OperationDiagnostics {
  total: number;
  byStatus: Record<OperationStatus, number>;
  /** Operations that have been `paused` or `in_progress` for > abandonAfterMs. */
  stuck: RecoverableOperation[];
  /** Operations that reached `abandoned` status. */
  abandoned: RecoverableOperation[];
  generatedAt: string;
}

// ─── Store interface ─────────────────────────────────────────────────────────

export interface CheckpointStore {
  saveOperation(op: RecoverableOperation): void;
  getOperation(id: string): RecoverableOperation | null;
  listOperations(): RecoverableOperation[];
  deleteOperation(id: string): void;
  saveCheckpoint(cp: RecoveryCheckpoint): void;
  getCheckpoint(operationId: string, stepId: string): RecoveryCheckpoint | null;
  listCheckpoints(operationId: string): RecoveryCheckpoint[];
  clear(): void;
}

// ─── Manager options ─────────────────────────────────────────────────────────

export interface RecoveryManagerOptions {
  /** How long (ms) before an idle in-progress operation is considered abandoned. */
  abandonAfterMs?: number;
  /** How long (ms) to retain completed / failed operations for diagnostics. */
  retentionMs?: number;
  store?: CheckpointStore;
}

// ─── Step executor ───────────────────────────────────────────────────────────

/**
 * Caller-provided function that executes one step.
 * Receives the operation context and any outputs from previous steps.
 *
 * Must throw on failure — the manager catches the error and marks the step
 * as `failed`.  Must return a serialisable value (or undefined) as the step
 * output.
 */
export type StepExecutor = (
  step: OperationStep,
  context: Record<string, unknown>,
  previousOutputs: Record<string, unknown>,
) => Promise<unknown>;
