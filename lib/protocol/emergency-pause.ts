/**
 * Emergency pause and scoped resume controls (#177).
 *
 * Maintainers need to halt specific risky operations — a payout path, a
 * governance action — without taking the whole system down. This module is the
 * frontend half of that control plane:
 *
 *   - **Scopes by operation and environment.** A pause targets one operation
 *     (`transfer_funds`, `claim_payout`, …) in one environment, optionally for
 *     one subject (a specific wallet or agent). Unrelated operations, and the
 *     same operation in another environment, keep working.
 *
 *   - **Enforcement at the boundary.** `assertOperationAllowed` is the gate the
 *     execution boundary (API route handler, transaction composer) calls before
 *     doing anything irreversible. Paused operations are rejected with a
 *     consistent, user-safe error (`OPERATION_PAUSED`) that never leaks who
 *     paused it or why internally.
 *
 *   - **Audited resume.** Pausing and resuming append immutable entries to an
 *     audit log with reason, actor and timestamps. Resuming requires the actor
 *     to hold `manage_security`-level privileges (`role: 'admin' | 'maintainer'`
 *     on the `security` tier) — an unauthorized resume attempt is recorded and
 *     refused, and the pause stays in effect.
 *
 * Everything is pure and injectable (clock, store, role check), so tests are
 * deterministic and the module can back a future server route unchanged.
 */

import type { ProtocolActor, ProtocolEnvironment, ProtocolOperation } from './operations';

/** What a pause covers. */
export interface PauseScope {
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  /**
   * Optional narrowing: only this wallet/agent id is paused. `undefined` pauses
   * the operation for everyone.
   */
  readonly subjectId?: string;
}

/** A pause that is or was in effect. */
export interface PauseRecord extends PauseScope {
  readonly id: string;
  readonly reason: string;
  readonly pausedBy: ProtocolActor;
  readonly pausedAt: number;
  /** Set when the pause is lifted. */
  readonly resumedAt?: number;
  readonly resumedBy?: ProtocolActor;
  readonly resumeReason?: string;
}

/** An entry in the pause/resume audit log. */
export interface PauseAuditEntry {
  readonly id: string;
  readonly action: 'pause' | 'resume' | 'resume_denied';
  readonly scope: PauseScope;
  readonly reason: string;
  readonly actor: ProtocolActor;
  readonly at: number;
}

/** Pluggable persistence so tests use a map and a server route uses its DB. */
export interface PauseStore {
  list(): readonly PauseRecord[];
  add(record: PauseRecord): void;
  update(record: PauseRecord): void;
}

export class MemoryPauseStore implements PauseStore {
  private readonly records: PauseRecord[] = [];

  list(): readonly PauseRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  add(record: PauseRecord): void {
    this.records.push({ ...record });
  }

  update(record: PauseRecord): void {
    const index = this.records.findIndex((entry) => entry.id === record.id);
    if (index >= 0) this.records[index] = { ...record };
  }
}

export class InMemoryPauseAuditLog {
  private readonly entries: PauseAuditEntry[] = [];

  append(entry: PauseAuditEntry): void {
    this.entries.push({ ...entry });
  }

  all(): readonly PauseAuditEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  forScope(scope: PauseScope): readonly PauseAuditEntry[] {
    return this.all().filter(
      (entry) =>
        entry.scope.operation === scope.operation &&
        entry.scope.environment === scope.environment &&
        entry.scope.subjectId === scope.subjectId,
    );
  }

  get size(): number {
    return this.entries.length;
  }
}

/** Roles allowed to pause and to resume. Resuming is deliberately stricter. */
const PAUSE_ROLES: readonly ProtocolActor['role'][] = ['admin', 'maintainer'];
const RESUME_ROLES: readonly ProtocolActor['role'][] = ['admin'];

export function canPause(actor: ProtocolActor): boolean {
  return PAUSE_ROLES.includes(actor.role);
}

export function canResume(actor: ProtocolActor): boolean {
  return RESUME_ROLES.includes(actor.role);
}

export interface PauseManagerOptions {
  store?: PauseStore;
  auditLog?: InMemoryPauseAuditLog;
  now?: () => number;
  /** Monotonic id source; injectable for deterministic tests. The prefix is advisory. */
  generateId?: (prefix?: string) => string;
}

/** Rejection returned when an operation hits an active pause. */
export interface PausedRejection {
  readonly code: 'OPERATION_PAUSED';
  /** User-safe explanation; no actor/reason internals. */
  readonly message: string;
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  /** Present when the pause is narrowed to a specific subject. */
  readonly subjectId?: string;
}

/** Thrown by the enforcement gate when the requested operation is paused. */
export class OperationPausedError extends Error {
  readonly code = 'OPERATION_PAUSED' as const;
  readonly rejection: PausedRejection;

  constructor(rejection: PausedRejection) {
    super(rejection.message);
    this.name = 'OperationPausedError';
    this.rejection = rejection;
  }
}

let idCounter = 0;

function defaultGenerateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(16).padStart(8, '0')}`;
}

/**
 * Pause manager: create/restore pauses, enforce them, and audit every
 * transition. One instance per deployment; state lives in the store so it can
 * be pre-loaded from a snapshot.
 */
export class PauseManager {
  private readonly store: PauseStore;
  private readonly auditLog: InMemoryPauseAuditLog;
  private readonly now: () => number;
  /** Injectable id source; the prefix argument is advisory. */
  private readonly generateId: (prefix?: string) => string;

  constructor(options: PauseManagerOptions = {}) {
    this.store = options.store ?? new MemoryPauseStore();
    this.auditLog = options.auditLog ?? new InMemoryPauseAuditLog();
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? (() => defaultGenerateId('pause'));
  }

  /** Pause one operation scope. Idempotent for an identical active pause. */
  pause(params: {
    scope: PauseScope;
    reason: string;
    actor: ProtocolActor;
  }): PauseRecord {
    const { scope, reason, actor } = params;
    if (!canPause(actor)) {
      throw new Error('Only maintainers and admins may pause operations');
    }
    if (!reason.trim()) {
      throw new Error('A pause requires a non-empty reason');
    }

    const existing = this.findActivePause(scope);
    if (existing) return existing;

    const record: PauseRecord = {
      ...scope,
      id: this.generateId(),
      reason,
      pausedBy: actor,
      pausedAt: this.now(),
    };
    this.store.add(record);
    this.auditLog.append({
      id: this.generateId('audit'),
      action: 'pause',
      scope,
      reason,
      actor,
      at: record.pausedAt,
    });
    return record;
  }

  /**
   * Lift a pause. Admin-only; records a `resume_denied` audit entry and leaves
   * the pause untouched when the actor lacks permission.
   */
  resume(params: {
    scope: PauseScope;
    reason: string;
    actor: ProtocolActor;
  }): { resumed: boolean; record: PauseRecord | null } {
    const { scope, reason, actor } = params;

    if (!canResume(actor)) {
      this.auditLog.append({
        id: this.generateId('audit'),
        action: 'resume_denied',
        scope,
        reason: reason || 'no reason given',
        actor,
        at: this.now(),
      });
      return { resumed: false, record: null };
    }

    const record = this.findActivePause(scope);
    if (!record) return { resumed: false, record: null };

    const resumedAt = this.now();
    const resumeReason = reason || 'no reason given';
    const resumed: PauseRecord = {
      ...record,
      resumedAt,
      resumedBy: actor,
      resumeReason,
    };
    this.store.update(resumed);
    this.auditLog.append({
      id: this.generateId('audit'),
      action: 'resume',
      scope,
      reason: resumeReason,
      actor,
      at: resumedAt,
    });
    return { resumed: true, record: resumed };
  }

  /**
   * The enforcement gate. Returns `null` when the operation may proceed;
   * throws `OperationPausedError` when it is paused. Subject-less scopes match
   * every subject; subject-scoped pauses match only that subject.
   */
  assertOperationAllowed(params: {
    operation: ProtocolOperation;
    environment: ProtocolEnvironment;
    subjectId?: string;
  }): void {
    const rejection = this.evaluateOperation(params);
    if (rejection) throw new OperationPausedError(rejection);
  }

  /** Non-throwing variant for UI checks and preflight integration (#175). */
  evaluateOperation(params: {
    operation: ProtocolOperation;
    environment: ProtocolEnvironment;
    subjectId?: string;
  }): PausedRejection | null {
    for (const record of this.store.list()) {
      if (record.resumedAt !== undefined) continue;
      if (record.operation !== params.operation) continue;
      if (record.environment !== params.environment) continue;
      if (record.subjectId && record.subjectId !== params.subjectId) continue;
      return {
        code: 'OPERATION_PAUSED',
        message: userSafePauseMessage(record),
        operation: params.operation,
        environment: params.environment,
        subjectId: record.subjectId,
      };
    }
    return null;
  }

  /** Active pauses, optionally filtered by operation. */
  activePauses(operation?: ProtocolOperation): readonly PauseRecord[] {
    return this.store
      .list()
      .filter((record) => record.resumedAt === undefined)
      .filter((record) => !operation || record.operation === operation);
  }

  /** Full pause/resume audit trail (pauses, resumes, denied resumes). */
  audit(): readonly PauseAuditEntry[] {
    return this.auditLog.all();
  }

  private findActivePause(scope: PauseScope): PauseRecord | null {
    return (
      this.store
        .list()
        .find(
          (record) =>
            record.resumedAt === undefined &&
            record.operation === scope.operation &&
            record.environment === scope.environment &&
            record.subjectId === scope.subjectId,
        ) ?? null
    );
  }
}

function userSafePauseMessage(record: PauseRecord): string {
  const subject = record.subjectId ? ` for ${record.subjectId}` : '';
  return (
    `${record.operation} is temporarily unavailable${subject} ` +
    `in ${record.environment}. Please try again later.`
  );
}
