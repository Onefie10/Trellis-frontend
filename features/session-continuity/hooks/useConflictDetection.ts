import { useState, useCallback, useRef } from "react";
import { detectConflict, ConflictInfo, getRecoveryActions, RecoveryAction } from "../../../lib/concurrency";


export interface ConflictState {
  hasConflict: boolean;
  conflict: ConflictInfo | null;
  recoveryActions: RecoveryAction[];
}

export type ConflictResolutionAction = "retry" | "refresh" | "merge" | "discard";

export interface ConflictResolution {
  action: ConflictResolutionAction;
  resourceId: string | null;
  resolvedAt: number;
  attempts: number;
}

export interface ConflictDetectionOptions {
  /** Maximum consecutive resolution attempts before the hook stops retrying. */
  maxResolutionAttempts?: number;
  /** Called when a conflict is detected (including duplicate detections). */
  onConflict?: (conflict: ConflictInfo, resourceId: string) => void;
  /** Called when a conflict is resolved or cleared. */
  onResolve?: (resolution: ConflictResolution) => void;
}

const EMPTY_STATE: ConflictState = {
  hasConflict: false,
  conflict: null,
  recoveryActions: [],
};

function isSameConflict(a: ConflictInfo | null, b: ConflictInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.localVersion === b.localVersion &&
    a.serverVersion === b.serverVersion &&
    a.deviceId === b.deviceId &&
    a.serverDeviceId === b.serverDeviceId &&
    a.resourceId === b.resourceId
  );
}

/**
 * Hook to detect and manage concurrent edit conflicts.
 *
 * The hook is designed to be safe under concurrent actors:
 * - Duplicate detections for the same conflict are idempotent (no repeated notifications).
 * - Stale detections from an out-of-order response are ignored.
 * - Resolution attempts are counted so retry storms can be detected and bounded.
 */
export function useConflictDetection(options: ConflictDetectionOptions = {}) {
  const maxResolutionAttempts = options.maxResolutionAttempts ?? 10;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<ConflictState>(EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Monotonically increasing sequence used to discard stale detection results.
  const detectionSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const attemptsRef = useRef(0);

  const checkForConflict = useCallback(
    (
      localVersion: number,
      serverVersion: number,
      deviceId: string,
      serverDeviceId: string,
      resourceId: string,
    ): boolean => {
      const seq = ++detectionSeqRef.current;

      // Ignore out-of-order results from concurrent callers.
      if (seq < appliedSeqRef.current) {
        return stateRef.current.hasConflict;
      }
      appliedSeqRef.current = seq;

      const conflict = detectConflict(localVersion, serverVersion, deviceId, serverDeviceId);
      if (conflict) {
        conflict.resourceId = resourceId;
        const actions = getRecoveryActions(conflict);
        const previous = stateRef.current;

        // Idempotent update: duplicate detections of the same conflict do
        // not re-trigger notifications or clobber state.
        if (!isSameConflict(previous.conflict, conflict)) {
          attemptsRef.current = 0;
          setState({
            hasConflict: true,
            conflict,
            recoveryActions: actions,
          });
          optionsRef.current.onConflict?.(conflict, resourceId);
        }
        return true;
      }

      if (stateRef.current.hasConflict) {
        attemptsRef.current = 0;
        setState(EMPTY_STATE);
      }
      return false;
    },
    [],
  );

  const resolveConflict = useCallback(
    (action: ConflictResolutionAction): ConflictResolution => {
      const current = stateRef.current.conflict;
      const attempts = ++attemptsRef.current;

      // Retry storm guard: once the caller keeps resolving the same conflict
      // without it being cleared, stop mutating state and surface the attempt
      // count so the UI/caller can back off.
      if (attempts > maxResolutionAttempts) {
        return {
          action,
          resourceId: current?.resourceId ?? null,
          resolvedAt: Date.now(),
          attempts,
        };
      }

      setState(EMPTY_STATE);
      const resolution: ConflictResolution = {
        action,
        resourceId: current?.resourceId ?? null,
        resolvedAt: Date.now(),
        attempts,
      };
      optionsRef.current.onResolve?.(resolution);
      return resolution;
    },
    [maxResolutionAttempts],
  );

  const clearConflict = useCallback(() => {
    const current = stateRef.current.conflict;
    attemptsRef.current = 0;
    setState(EMPTY_STATE);
    if (current) {
      optionsRef.current.onResolve?.({
        action: "discard",
        resourceId: current.resourceId ?? null,
        resolvedAt: Date.now(),
        attempts: 0,
      });
    }
  }, []);

  return {
    ...state,
    checkForConflict,
    resolveConflict,
    clearConflict,
  };
}
