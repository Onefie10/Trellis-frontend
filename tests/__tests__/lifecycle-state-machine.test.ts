/**
 * Lifecycle State Machine Tests — Issue #252
 *
 * Exhaustive formal state machine testing for every terminal, recovery,
 * valid, and invalid state transition for operations and steps.
 */

import {
  InvalidStateTransitionError,
  OPERATION_TRANSITION_TABLE,
  STEP_TRANSITION_TABLE,
  TERMINAL_OPERATION_STATUSES,
  TERMINAL_STEP_STATUSES,
  RECOVERABLE_OPERATION_STATUSES,
  isTerminalOperationStatus,
  isTerminalStepStatus,
  isRecoverableOperationStatus,
  canTransitionOperation,
  canTransitionStep,
  validateOperationTransition,
  validateStepTransition,
  transitionOperation,
  transitionStep,
  getAllowedOperationTransitions,
  getAllowedStepTransitions,
} from '@/lib/recovery/state-machine';
import { OperationManager } from '@/lib/recovery/operation-manager';
import { MemoryCheckpointStore } from '@/lib/recovery/checkpoint-store';
import type { OperationStatus, StepStatus, RecoverableOperation, OperationStep } from '@/lib/recovery/types';

describe('Formal Lifecycle State Machine Suite', () => {
  const ALL_OPERATION_STATUSES: OperationStatus[] = [
    'pending',
    'in_progress',
    'paused',
    'completed',
    'failed',
    'abandoned',
  ];

  const ALL_STEP_STATUSES: StepStatus[] = [
    'pending',
    'in_progress',
    'completed',
    'failed',
    'skipped',
  ];

  function makeMockOperation(status: OperationStatus): RecoverableOperation {
    return {
      id: 'op-test-123',
      type: 'generic',
      label: 'Test Operation',
      status,
      steps: [
        { id: 'step-1', label: 'Step 1', sideEffect: false, status: 'pending' },
        { id: 'step-2', label: 'Step 2', sideEffect: true, status: 'pending' },
      ],
      currentStepIndex: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      correlationId: 'corr-123',
      resumeCount: 0,
    };
  }

  function makeMockStep(status: StepStatus): OperationStep {
    return {
      id: 'step-abc',
      label: 'Sample Step',
      sideEffect: true,
      status,
    };
  }

  // ─── 1. Exhaustive Operation Transition Matrix ─────────────────────────────

  describe('Operation Transition Matrix (All 36 Combinations)', () => {
    for (const fromStatus of ALL_OPERATION_STATUSES) {
      for (const toStatus of ALL_OPERATION_STATUSES) {
        const allowedTargets = OPERATION_TRANSITION_TABLE[fromStatus] || [];
        const isSelfTransition = fromStatus === toStatus;
        const isAllowed = isSelfTransition || allowedTargets.includes(toStatus);

        if (isAllowed) {
          it(`allows valid transition: ${fromStatus} -> ${toStatus}`, () => {
            const op = makeMockOperation(fromStatus);
            expect(() => validateOperationTransition(op, toStatus)).not.toThrow();
            expect(canTransitionOperation(fromStatus, toStatus) || isSelfTransition).toBe(true);

            const transitioned = transitionOperation(op, toStatus);
            expect(transitioned.status).toBe(toStatus);
          });
        } else {
          it(`fails deterministically on invalid transition: ${fromStatus} -> ${toStatus}`, () => {
            const op = makeMockOperation(fromStatus);
            expect(canTransitionOperation(fromStatus, toStatus)).toBe(false);

            expect(() => validateOperationTransition(op, toStatus)).toThrow(
              InvalidStateTransitionError
            );

            try {
              validateOperationTransition(op, toStatus);
              fail('Expected validateOperationTransition to throw');
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(InvalidStateTransitionError);
              const transErr = err as InvalidStateTransitionError;
              expect(transErr.entityType).toBe('operation');
              expect(transErr.entityId).toBe(op.id);
              expect(transErr.fromStatus).toBe(fromStatus);
              expect(transErr.toStatus).toBe(toStatus);
              expect(transErr.allowedTransitions).toEqual(allowedTargets);
              expect(transErr.message).toContain(`Invalid operation transition from '${fromStatus}' to '${toStatus}'`);
            }
          });
        }
      }
    }
  });

  // ─── 2. Exhaustive Step Transition Matrix ──────────────────────────────────

  describe('Step Transition Matrix (All 25 Combinations)', () => {
    for (const fromStatus of ALL_STEP_STATUSES) {
      for (const toStatus of ALL_STEP_STATUSES) {
        const allowedTargets = STEP_TRANSITION_TABLE[fromStatus] || [];
        const isSelfTransition = fromStatus === toStatus;
        const isAllowed = isSelfTransition || allowedTargets.includes(toStatus);

        if (isAllowed) {
          it(`allows valid step transition: ${fromStatus} -> ${toStatus}`, () => {
            const step = makeMockStep(fromStatus);
            expect(() => validateStepTransition(step, toStatus)).not.toThrow();
            expect(canTransitionStep(fromStatus, toStatus) || isSelfTransition).toBe(true);

            const transitioned = transitionStep(step, toStatus);
            expect(transitioned.status).toBe(toStatus);
          });
        } else {
          it(`fails deterministically on invalid step transition: ${fromStatus} -> ${toStatus}`, () => {
            const step = makeMockStep(fromStatus);
            expect(canTransitionStep(fromStatus, toStatus)).toBe(false);

            expect(() => validateStepTransition(step, toStatus)).toThrow(
              InvalidStateTransitionError
            );

            try {
              validateStepTransition(step, toStatus);
              fail('Expected validateStepTransition to throw');
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(InvalidStateTransitionError);
              const transErr = err as InvalidStateTransitionError;
              expect(transErr.entityType).toBe('step');
              expect(transErr.entityId).toBe(step.id);
              expect(transErr.fromStatus).toBe(fromStatus);
              expect(transErr.toStatus).toBe(toStatus);
              expect(transErr.allowedTransitions).toEqual(allowedTargets);
            }
          });
        }
      }
    }
  });

  // ─── 3. Terminal State Immutability ────────────────────────────────────────

  describe('Terminal State Immutability', () => {
    it('declares completed and failed as terminal operation statuses', () => {
      expect(isTerminalOperationStatus('completed')).toBe(true);
      expect(isTerminalOperationStatus('failed')).toBe(true);
      expect(isTerminalOperationStatus('in_progress')).toBe(false);
      expect(isTerminalOperationStatus('paused')).toBe(false);
      expect(isTerminalOperationStatus('pending')).toBe(false);
      expect(isTerminalOperationStatus('abandoned')).toBe(false);
      expect(TERMINAL_OPERATION_STATUSES.has('completed')).toBe(true);
    });

    it('guarantees completed operations cannot be transitioned to any other state', () => {
      const op = makeMockOperation('completed');
      expect(getAllowedOperationTransitions('completed')).toHaveLength(0);

      for (const target of ALL_OPERATION_STATUSES) {
        if (target === 'completed') continue;
        expect(() => validateOperationTransition(op, target)).toThrow(
          InvalidStateTransitionError
        );
      }
    });

    it('guarantees failed operations cannot be transitioned to any other state', () => {
      const op = makeMockOperation('failed');
      expect(getAllowedOperationTransitions('failed')).toHaveLength(0);

      for (const target of ALL_OPERATION_STATUSES) {
        if (target === 'failed') continue;
        expect(() => validateOperationTransition(op, target)).toThrow(
          InvalidStateTransitionError
        );
      }
    });

    it('declares completed and skipped as terminal step statuses', () => {
      expect(isTerminalStepStatus('completed')).toBe(true);
      expect(isTerminalStepStatus('skipped')).toBe(true);
      expect(isTerminalStepStatus('in_progress')).toBe(false);
      expect(isTerminalStepStatus('pending')).toBe(false);
      expect(isTerminalStepStatus('failed')).toBe(false);
    });

    it('guarantees completed steps cannot be revived or retried', () => {
      const step = makeMockStep('completed');
      expect(getAllowedStepTransitions('completed')).toHaveLength(0);

      for (const target of ALL_STEP_STATUSES) {
        if (target === 'completed') continue;
        expect(() => validateStepTransition(step, target)).toThrow(
          InvalidStateTransitionError
        );
      }
    });
  });

  // ─── 4. Recovery Transition Paths ──────────────────────────────────────────

  describe('Recovery Transition Paths', () => {
    it('identifies paused and abandoned as recoverable statuses', () => {
      expect(isRecoverableOperationStatus('paused')).toBe(true);
      expect(isRecoverableOperationStatus('abandoned')).toBe(true);
      expect(isRecoverableOperationStatus('completed')).toBe(false);
      expect(isRecoverableOperationStatus('failed')).toBe(false);
    });

    it('supports recovery resume path: paused -> in_progress', () => {
      const op = makeMockOperation('paused');
      expect(canTransitionOperation('paused', 'in_progress')).toBe(true);
      const resumed = transitionOperation(op, 'in_progress', { resumeCount: op.resumeCount + 1 });
      expect(resumed.status).toBe('in_progress');
      expect(resumed.resumeCount).toBe(1);
    });

    it('supports stale recovery intervention path: abandoned -> in_progress', () => {
      const op = makeMockOperation('abandoned');
      expect(canTransitionOperation('abandoned', 'in_progress')).toBe(true);
      const recovered = transitionOperation(op, 'in_progress');
      expect(recovered.status).toBe('in_progress');
    });

    it('supports user or operator abort path: paused -> failed', () => {
      const op = makeMockOperation('paused');
      expect(canTransitionOperation('paused', 'failed')).toBe(true);
      const aborted = transitionOperation(op, 'failed');
      expect(aborted.status).toBe('failed');
    });

    it('supports stale cleanup abort path: abandoned -> failed', () => {
      const op = makeMockOperation('abandoned');
      expect(canTransitionOperation('abandoned', 'failed')).toBe(true);
      const aborted = transitionOperation(op, 'failed');
      expect(aborted.status).toBe('failed');
    });

    it('supports step recovery path: failed step -> in_progress for retry', () => {
      const step = makeMockStep('failed');
      expect(canTransitionStep('failed', 'in_progress')).toBe(true);
      const retrying = transitionStep(step, 'in_progress');
      expect(retrying.status).toBe('in_progress');
    });

    it('supports skipping a failed step during recovery bypass: failed -> skipped', () => {
      const step = makeMockStep('failed');
      expect(canTransitionStep('failed', 'skipped')).toBe(true);
      const skipped = transitionStep(step, 'skipped');
      expect(skipped.status).toBe('skipped');
    });
  });

  // ─── 5. Integration with OperationManager ──────────────────────────────────

  describe('OperationManager Formal Enforcement', () => {
    let store: MemoryCheckpointStore;
    let manager: OperationManager;

    beforeEach(() => {
      store = new MemoryCheckpointStore();
      manager = new OperationManager({ store });
    });

    it('enforces state machine through abortOperation', () => {
      const op = manager.create('generic', 'Abortable Op', [
        { id: 's1', label: 'Step 1', sideEffect: false },
      ]);

      // Transition to paused via simulated failure
      const pausedOp = (manager as any)._updateOp(op, { status: 'in_progress' });
      (manager as any)._updateOp(pausedOp, { status: 'paused' });

      const aborted = manager.abortOperation(op.id, 'User manually cancelled flow');
      expect(aborted.status).toBe('failed');
      expect((aborted.context as any).abortReason).toBe('User manually cancelled flow');
    });

    it('throws InvalidStateTransitionError if trying to abort an already completed operation', async () => {
      const op = manager.create('generic', 'Completed Op', [
        { id: 's1', label: 'Step 1', sideEffect: false },
      ]);

      await manager.execute(op.id, async () => ({ ok: true }));
      const completedOp = manager.getOperation(op.id);
      expect(completedOp?.status).toBe('completed');

      expect(() => manager.abortOperation(op.id, 'Too late to abort')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('throws InvalidStateTransitionError on direct illegal status mutation', () => {
      const op = manager.create('generic', 'Strict Op', [
        { id: 's1', label: 'Step 1', sideEffect: false },
      ]);

      // Direct illegal transition: pending -> completed without going through in_progress
      expect(() => {
        (manager as any)._updateOp(op, { status: 'completed' });
      }).toThrow(InvalidStateTransitionError);
    });

    it('throws InvalidStateTransitionError on direct illegal step status mutation', () => {
      const op = manager.create('generic', 'Step Op', [
        { id: 's1', label: 'Step 1', sideEffect: false },
      ]);

      // Direct illegal step transition: pending -> completed without in_progress
      expect(() => {
        (manager as any)._updateStep(op, 0, { status: 'completed' });
      }).toThrow(InvalidStateTransitionError);
    });
  });
});
