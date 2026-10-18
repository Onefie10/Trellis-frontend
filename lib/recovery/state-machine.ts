/**
 * Formal Lifecycle State Machine — Issue #252
 *
 * Enforces explicit transition rules for multi-step recoverable operations
 * and their constituent steps.
 *
 * Key guarantees:
 *  1. EXPLICIT TRANSITIONS — Every valid transition is defined in an immutable table.
 *  2. DETERMINISTIC REJECTION — Invalid or out-of-order transitions throw
 *     an `InvalidStateTransitionError` containing source, target, and allowed states.
 *  3. TERMINAL IMMUTABILITY — Terminal states (`completed`, `failed`) can never transition.
 *  4. EXPLICIT RECOVERY PATHS — Recovery transitions (`paused -> in_progress`,
 *     `abandoned -> in_progress`) are explicitly governed and verified.
 */

import type { OperationStatus, StepStatus, RecoverableOperation, OperationStep } from './types';

// ─── Error Definition ─────────────────────────────────────────────────────────

export interface TransitionErrorDetails {
  entityType: 'operation' | 'step';
  entityId: string;
  fromStatus: string;
  toStatus: string;
  allowedTransitions: readonly string[];
}

export class InvalidStateTransitionError extends Error {
  public readonly entityType: 'operation' | 'step';
  public readonly entityId: string;
  public readonly fromStatus: string;
  public readonly toStatus: string;
  public readonly allowedTransitions: readonly string[];

  constructor(details: TransitionErrorDetails) {
    const allowedMsg =
      details.allowedTransitions.length > 0
        ? `Legal target states: [${details.allowedTransitions.join(', ')}]`
        : 'Terminal state: no further transitions permitted';

    super(
      `Invalid ${details.entityType} transition from '${details.fromStatus}' to '${details.toStatus}' for ${details.entityType} '${details.entityId}'. ${allowedMsg}.`
    );

    this.name = 'InvalidStateTransitionError';
    this.entityType = details.entityType;
    this.entityId = details.entityId;
    this.fromStatus = details.fromStatus;
    this.toStatus = details.toStatus;
    this.allowedTransitions = details.allowedTransitions;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidStateTransitionError);
    }
  }
}

// ─── Transition Matrices ──────────────────────────────────────────────────────

/**
 * Valid transitions for top-level RecoverableOperation lifecycle.
 */
export const OPERATION_TRANSITION_TABLE: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = Object.freeze({
  pending: Object.freeze(['in_progress', 'abandoned'] as const),
  in_progress: Object.freeze(['paused', 'completed', 'failed', 'abandoned'] as const),
  paused: Object.freeze(['in_progress', 'abandoned', 'failed'] as const),
  abandoned: Object.freeze(['in_progress', 'failed'] as const),
  completed: Object.freeze([] as const), // Terminal
  failed: Object.freeze([] as const),    // Terminal
});

/**
 * Valid transitions for individual OperationStep lifecycle.
 */
export const STEP_TRANSITION_TABLE: Readonly<Record<StepStatus, readonly StepStatus[]>> = Object.freeze({
  pending: Object.freeze(['in_progress', 'skipped'] as const),
  in_progress: Object.freeze(['completed', 'failed', 'skipped'] as const),
  failed: Object.freeze(['in_progress', 'skipped'] as const), // Retry or skip
  completed: Object.freeze([] as const), // Terminal
  skipped: Object.freeze([] as const),   // Terminal
});

/**
 * Terminal statuses for operations.
 */
export const TERMINAL_OPERATION_STATUSES: ReadonlySet<OperationStatus> = new Set<OperationStatus>([
  'completed',
  'failed',
]);

/**
 * Terminal statuses for individual steps.
 */
export const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'completed',
  'skipped',
]);

/**
 * Statuses from which an interrupted operation can be recovered.
 */
export const RECOVERABLE_OPERATION_STATUSES: ReadonlySet<OperationStatus> = new Set<OperationStatus>([
  'paused',
  'abandoned',
]);

// ─── Query Helpers ───────────────────────────────────────────────────────────

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return TERMINAL_OPERATION_STATUSES.has(status);
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

export function isRecoverableOperationStatus(status: OperationStatus): boolean {
  return RECOVERABLE_OPERATION_STATUSES.has(status);
}

export function getAllowedOperationTransitions(status: OperationStatus): readonly OperationStatus[] {
  return OPERATION_TRANSITION_TABLE[status] ?? [];
}

export function getAllowedStepTransitions(status: StepStatus): readonly StepStatus[] {
  return STEP_TRANSITION_TABLE[status] ?? [];
}

export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  const allowed = OPERATION_TRANSITION_TABLE[from];
  return Boolean(allowed && allowed.includes(to));
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  const allowed = STEP_TRANSITION_TABLE[from];
  return Boolean(allowed && allowed.includes(to));
}

// ─── Validation & Transition Functions ────────────────────────────────────────

/**
 * Asserts that transitioning an operation from its current status to `targetStatus` is legal.
 * Throws `InvalidStateTransitionError` if the transition is prohibited.
 */
export function validateOperationTransition(
  operation: Pick<RecoverableOperation, 'id' | 'status'>,
  targetStatus: OperationStatus
): void {
  if (operation.status === targetStatus) return; // Idempotent no-op

  if (!canTransitionOperation(operation.status, targetStatus)) {
    throw new InvalidStateTransitionError({
      entityType: 'operation',
      entityId: operation.id,
      fromStatus: operation.status,
      toStatus: targetStatus,
      allowedTransitions: getAllowedOperationTransitions(operation.status),
    });
  }
}

/**
 * Asserts that transitioning a step from its current status to `targetStatus` is legal.
 * Throws `InvalidStateTransitionError` if the transition is prohibited.
 */
export function validateStepTransition(
  step: Pick<OperationStep, 'id' | 'status'>,
  targetStatus: StepStatus
): void {
  if (step.status === targetStatus) return; // Idempotent no-op

  if (!canTransitionStep(step.status, targetStatus)) {
    throw new InvalidStateTransitionError({
      entityType: 'step',
      entityId: step.id,
      fromStatus: step.status,
      toStatus: targetStatus,
      allowedTransitions: getAllowedStepTransitions(step.status),
    });
  }
}

/**
 * Pure transition function: returns a new operation instance with validated target status.
 */
export function transitionOperation(
  operation: RecoverableOperation,
  targetStatus: OperationStatus,
  patch: Partial<RecoverableOperation> = {}
): RecoverableOperation {
  validateOperationTransition(operation, targetStatus);
  return {
    ...operation,
    ...patch,
    status: targetStatus,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Pure transition function: returns a new step instance with validated target status.
 */
export function transitionStep(
  step: OperationStep,
  targetStatus: StepStatus,
  patch: Partial<OperationStep> = {}
): OperationStep {
  validateStepTransition(step, targetStatus);
  return {
    ...step,
    ...patch,
    status: targetStatus,
  };
}
