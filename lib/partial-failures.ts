import { z } from 'zod';
import {
  classifyError,
  computeBackoffDelay,
  deadLetterQueue,
  type DeadLetterReason,
  type JitterStrategy,
  type RetryAttempt,
} from '@/lib/retry';

/**
 * Partial failure dashboard for background and external integrations
 *
 * Features:
 * - Track operations stuck between internal state and external systems
 * - Group failures by type, severity, age, and retryability
 * - Automatic retry scheduling with exponential backoff
 * - Stale failure detection and alerting
 * - Manual intervention workflow support
 * - Comprehensive diagnostic data capture
 * - Dashboard reporting and analytics
 *
 * Usage:
 * 1. Record failures when operations fail
 * 2. System auto-detects retryable failures
 * 3. Retry scheduling with exponential backoff
 * 4. Dashboard shows stale, critical, and retryable failures
 * 5. Admins can retry, resolve, or mark for manual review
 */

export type FailureSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FailureStatus = 'unresolved' | 'retrying' | 'resolved' | 'manual_intervention';
export type OperationType = 'transaction' | 'sync' | 'webhook' | 'import' | 'export' | 'background_job';

export interface PartialFailure {
  id: string;
  operationType: OperationType;
  operationId: string;
  internalState: Record<string, unknown>;
  externalRefId?: string;
  errorMessage: string;
  severity: FailureSeverity;
  status: FailureStatus;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
  resolutionNotes?: string;
  canRetry: boolean;
  canIgnore: boolean;
  /**
   * Id of the dead-letter record created when this failure reached a terminal
   * state, or `undefined` while it is still retryable. Lets a maintainer jump
   * from a partial failure to its full attempt history and classification.
   */
  deadLetterId?: string;
  diagnosticData?: Record<string, unknown>;
}

export interface FailureGroup {
  operationType: OperationType;
  count: number;
  severity: FailureSeverity;
  oldest: string;
  newest: string;
  affectedResources: Set<string>;
  averageAge: number; // in milliseconds
}

export interface FailureReport {
  generatedAt: string;
  totalFailures: number;
  byStatus: Record<FailureStatus, number>;
  bySeverity: Record<FailureSeverity, number>;
  byOperationType: Record<OperationType, number>;
  groups: FailureGroup[];
  criticalFailures: PartialFailure[];
  staleFailures: PartialFailure[];
  retryableFailures: PartialFailure[];
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  /**
   * Shared with `lib/retry` so this tracker's backoff and `lib/api.ts` use one
   * algorithm. Previously this type had no `jitter` field and the delay was
   * computed locally, which is why every partial failure retried on exactly the
   * same schedule as every other one.
   */
  jitter: JitterStrategy;
}

export const PartialFailureSchema = z.object({
  id: z.string().min(1),
  operationType: z.enum(['transaction', 'sync', 'webhook', 'import', 'export', 'background_job']),
  operationId: z.string().min(1),
  internalState: z.record(z.unknown()),
  externalRefId: z.string().optional(),
  errorMessage: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['unresolved', 'retrying', 'resolved', 'manual_intervention']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastAttemptAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().positive(),
  nextRetryAt: z.string().datetime().optional(),
  resolutionNotes: z.string().optional(),
  canRetry: z.boolean(),
  canIgnore: z.boolean(),
  deadLetterId: z.string().optional(),
  diagnosticData: z.record(z.unknown()).optional(),
});

/**
 * Default retry policy configuration
 */
const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 60000, // 1 minute
  maxDelayMs: 24 * 60 * 60 * 1000, // 24 hours
  backoffMultiplier: 2,
  jitter: 'full',
};

/**
 * PartialFailureTracker: Manages partial failure tracking and recovery
 *
 * Key responsibilities:
 * - Recording failures when operations fail partially
 * - Detecting retry-able vs non-retryable failures
 * - Scheduling retries with exponential backoff
 * - Tracking stale failures for operator attention
 * - Providing failure dashboard and analytics
 * - Supporting manual intervention workflows
 */
class PartialFailureTracker {
  private failures: Map<string, PartialFailure> = new Map();
  private failuresByType: Map<OperationType, Set<string>> = new Map();
  private failuresByResource: Map<string, Set<string>> = new Map();
  private failuresByStatus: Map<FailureStatus, Set<string>> = new Map();
  private staleAfterMs: number = 7 * 24 * 60 * 60 * 1000; // 7 days
  private retryPolicy: RetryPolicy = defaultRetryPolicy;

  setStaleThreshold(ms: number): void {
    if (ms <= 0) {
      throw new Error('Stale threshold must be positive');
    }
    this.staleAfterMs = ms;
  }

  setRetryPolicy(policy: Partial<RetryPolicy>): void {
    this.retryPolicy = { ...this.retryPolicy, ...policy };

    // Validate policy
    if (this.retryPolicy.maxRetries <= 0) {
      throw new Error('Max retries must be positive');
    }
    if (this.retryPolicy.initialDelayMs <= 0) {
      throw new Error('Initial delay must be positive');
    }
  }

  /**
   * Drops all recorded failures and restores the default retry policy.
   *
   * The tracker is a module-level singleton, so without this every test in a file
   * observes failures recorded by the tests before it — which makes count-based
   * assertions depend on execution order. Call this from `beforeEach`.
   */
  reset(): void {
    this.failures.clear();
    this.failuresByType.clear();
    this.failuresByResource.clear();
    this.failuresByStatus.clear();
    this.retryPolicy = { ...defaultRetryPolicy };
  }

  recordFailure(
    operationType: OperationType,
    operationId: string,
    internalState: Record<string, unknown>,
    errorMessage: string,
    externalRefId?: string,
    severity: FailureSeverity = 'medium'
  ): PartialFailure {
    if (!operationType || !operationId || !errorMessage) {
      throw new Error('operationType, operationId, and errorMessage are required');
    }

    const now = new Date();
    const failureId = this.generateId();
    const failure: PartialFailure = {
      id: failureId,
      operationType,
      operationId,
      internalState: { ...internalState },
      externalRefId,
      errorMessage,
      severity,
      status: 'unresolved',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      retryCount: 0,
      maxRetries: this.retryPolicy.maxRetries,
      canRetry: this.isRetryable(operationType),
      canIgnore: this.isIgnorable(severity),
      diagnosticData: {
        environment: 'production',
        timestamp: now.getTime(),
      },
    };

    // Validate failure schema
    try {
      PartialFailureSchema.parse(failure);
    } catch (error) {
      throw new Error(`Invalid failure data: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Store failure
    this.failures.set(failureId, failure);

    // Track by type
    const typeFailures = this.failuresByType.get(operationType) || new Set();
    typeFailures.add(failureId);
    this.failuresByType.set(operationType, typeFailures);

    // Track by resource
    const resourceId = (internalState.resourceId as string) || 'unknown';
    const resourceFailures = this.failuresByResource.get(resourceId) || new Set();
    resourceFailures.add(failureId);
    this.failuresByResource.set(resourceId, resourceFailures);

    // Track by status
    const statusFailures = this.failuresByStatus.get('unresolved') || new Set();
    statusFailures.add(failureId);
    this.failuresByStatus.set('unresolved', statusFailures);

    return failure;
  }

  getFailure(failureId: string): PartialFailure | null {
    return this.failures.get(failureId) || null;
  }

  /**
   * Advances a failure by one retry.
   *
   * Both terminal conditions — budget exhausted and non-retryable class — now
   * write a dead-letter record before throwing. Previously they only threw, so a
   * failure that could never succeed left no durable trace and a maintainer had
   * no way to review it.
   */
  retryFailure(failureId: string): boolean {
    const failure = this.getFailure(failureId);
    if (!failure) {
      throw new Error('Failure not found');
    }

    if (failure.retryCount >= failure.maxRetries) {
      this.deadLetter(failure, 'retries_exhausted');
      throw new Error(`Max retries (${failure.maxRetries}) exceeded`);
    }

    if (!failure.canRetry) {
      this.deadLetter(failure, 'non_retryable');
      throw new Error('This failure cannot be retried');
    }

    failure.retryCount += 1;
    failure.status = 'retrying';
    failure.lastAttemptAt = new Date().toISOString();
    failure.updatedAt = new Date().toISOString();

    // Schedule next retry with exponential backoff plus jitter. Jitter is what
    // stops every failed operation from retrying on the same instant after a
    // shared outage.
    if (failure.retryCount < failure.maxRetries) {
      const backoffMs = computeBackoffDelay(failure.retryCount - 1, this.retryPolicy);
      const nextRetryTime = new Date(Date.now() + backoffMs);
      failure.nextRetryAt = nextRetryTime.toISOString();
    }

    return true;
  }

  /**
   * Writes a terminal-failure record to the dead-letter queue, once per failure.
   *
   * Guarded by `deadLetterId` so repeated `retryFailure` calls on an already
   * dead-lettered failure do not accumulate duplicate records.
   */
  private deadLetter(failure: PartialFailure, reason: DeadLetterReason): void {
    if (failure.deadLetterId) {
      return;
    }

    const classification = classifyError(new Error(failure.errorMessage));
    const attempts: RetryAttempt[] = Array.from({ length: Math.max(failure.retryCount, 1) }, (_, index) => ({
      attempt: index,
      startedAt: failure.lastAttemptAt ?? failure.updatedAt,
      durationMs: 0,
      classification,
    }));

    const record = deadLetterQueue.record({
      operationClass: failure.operationType,
      operationId: failure.operationId,
      reason,
      classification,
      attempts,
      context: { ...failure.internalState, failureId: failure.id, severity: failure.severity },
    });

    failure.deadLetterId = record.id;
    failure.updatedAt = new Date().toISOString();
  }

  markResolved(failureId: string, notes?: string): boolean {
    const failure = this.getFailure(failureId);
    if (!failure) {
      throw new Error('Failure not found');
    }

    failure.status = 'resolved';
    failure.resolutionNotes = notes;
    failure.updatedAt = new Date().toISOString();

    // Update status tracking
    const unresolvedSet = this.failuresByStatus.get('unresolved');
    if (unresolvedSet) {
      unresolvedSet.delete(failureId);
    }
    const resolvedSet = this.failuresByStatus.get('resolved') || new Set();
    resolvedSet.add(failureId);
    this.failuresByStatus.set('resolved', resolvedSet);

    return true;
  }

  markManualIntervention(failureId: string, notes?: string): boolean {
    const failure = this.getFailure(failureId);
    if (!failure) {
      throw new Error('Failure not found');
    }

    failure.status = 'manual_intervention';
    failure.resolutionNotes = notes || 'Marked for manual review';
    failure.updatedAt = new Date().toISOString();

    // Update status tracking
    const unresolvedSet = this.failuresByStatus.get('unresolved');
    if (unresolvedSet) {
      unresolvedSet.delete(failureId);
    }
    const manualSet = this.failuresByStatus.get('manual_intervention') || new Set();
    manualSet.add(failureId);
    this.failuresByStatus.set('manual_intervention', manualSet);

    return true;
  }

  ignoreFailure(failureId: string, reason?: string): boolean {
    const failure = this.getFailure(failureId);
    if (!failure) {
      throw new Error('Failure not found');
    }

    if (!failure.canIgnore) {
      throw new Error('Critical failures cannot be ignored');
    }

    failure.status = 'resolved';
    failure.resolutionNotes = reason || 'Ignored by operator';
    failure.updatedAt = new Date().toISOString();

    return true;
  }

  getFailuresByType(operationType: OperationType): PartialFailure[] {
    const failureIds = this.failuresByType.get(operationType) || new Set();
    return Array.from(failureIds)
      .map((id) => this.getFailure(id))
      .filter((failure): failure is PartialFailure => failure !== null);
  }

  getFailuresByStatus(status: FailureStatus): PartialFailure[] {
    const failureIds = this.failuresByStatus.get(status) || new Set();
    return Array.from(failureIds)
      .map((id) => this.getFailure(id))
      .filter((failure): failure is PartialFailure => failure !== null);
  }

  getFailuresByResource(resourceId: string): PartialFailure[] {
    const failureIds = this.failuresByResource.get(resourceId) || new Set();
    return Array.from(failureIds)
      .map((id) => this.getFailure(id))
      .filter((failure): failure is PartialFailure => failure !== null);
  }

  getCriticalFailures(): PartialFailure[] {
    return Array.from(this.failures.values()).filter(
      (failure) => failure.severity === 'critical' && failure.status !== 'resolved'
    );
  }

  getStaleFailures(beforeMs?: number): PartialFailure[] {
    const threshold = beforeMs || this.staleAfterMs;
    const now = Date.now();

    return Array.from(this.failures.values()).filter((failure) => {
      const age = now - new Date(failure.createdAt).getTime();
      return failure.status === 'unresolved' && age > threshold;
    });
  }

  getRetryableFailures(): PartialFailure[] {
    return Array.from(this.failures.values()).filter(
      (failure) =>
        failure.canRetry &&
        failure.retryCount < failure.maxRetries &&
        failure.status !== 'resolved'
    );
  }

  /**
   * Failures that reached a terminal state and have a dead-letter record.
   *
   * This is the maintainer triage view for operations that stopped retrying.
   */
  getDeadLetteredFailures(): PartialFailure[] {
    return Array.from(this.failures.values()).filter(
      (failure) => failure.deadLetterId !== undefined && failure.status !== 'resolved'
    );
  }

  /** Links a failure to its dead-letter record, or null while it is still retryable. */
  getDeadLetterId(failureId: string): string | null {
    return this.getFailure(failureId)?.deadLetterId ?? null;
  }

  generateReport(): FailureReport {
    const now = new Date();
    const failures = Array.from(this.failures.values());

    const byStatus: Record<FailureStatus, number> = {
      unresolved: 0,
      retrying: 0,
      resolved: 0,
      manual_intervention: 0,
    };

    const bySeverity: Record<FailureSeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    const byOperationType: Record<OperationType, number> = {
      transaction: 0,
      sync: 0,
      webhook: 0,
      import: 0,
      export: 0,
      background_job: 0,
    };

    failures.forEach((failure) => {
      byStatus[failure.status] += 1;
      bySeverity[failure.severity] += 1;
      byOperationType[failure.operationType] += 1;
    });

    // Group failures by type and severity
    const groups = this.groupFailures(failures);

    return {
      generatedAt: now.toISOString(),
      totalFailures: failures.length,
      byStatus,
      bySeverity,
      byOperationType,
      groups,
      criticalFailures: this.getCriticalFailures(),
      staleFailures: this.getStaleFailures(),
      retryableFailures: this.getRetryableFailures(),
    };
  }

  private groupFailures(failures: PartialFailure[]): FailureGroup[] {
    const groups = new Map<string, FailureGroup>();
    const now = Date.now();

    failures.forEach((failure) => {
      const key = `${failure.operationType}:${failure.severity}`;

      if (!groups.has(key)) {
        groups.set(key, {
          operationType: failure.operationType,
          count: 0,
          severity: failure.severity,
          oldest: failure.createdAt,
          newest: failure.updatedAt,
          affectedResources: new Set(),
          averageAge: 0,
        });
      }

      const group = groups.get(key)!;
      group.count += 1;

      if (failure.createdAt < group.oldest) {
        group.oldest = failure.createdAt;
      }
      if (failure.updatedAt > group.newest) {
        group.newest = failure.updatedAt;
      }

      const resourceId = (failure.internalState.resourceId as string) || 'unknown';
      group.affectedResources.add(resourceId);
    });

    // Calculate average age for each group
    groups.forEach((group) => {
      const groupFailures = failures.filter(
        (f) => f.operationType === group.operationType && f.severity === group.severity
      );
      if (groupFailures.length > 0) {
        const totalAge = groupFailures.reduce((sum, f) => sum + (now - new Date(f.createdAt).getTime()), 0);
        group.averageAge = Math.floor(totalAge / groupFailures.length);
      }
    });

    return Array.from(groups.values());
  }

  /**
   * Automatic-retry eligibility, deliberately narrower than
   * `DEFAULT_OPERATION_POLICIES`.
   *
   * The policy registry treats `import`, `export`, and `background_job` as
   * retryable because a caller that explicitly asks to retry them should get
   * one. This tracker will *schedule* retries on its own, so it holds to the
   * narrower set: an import or export may be long, expensive, and partially
   * applied, and re-running it unattended is a worse outcome than surfacing it
   * for a human. Callers that know an operation is safe to replay should drive
   * it through `RetryScheduler` instead of relying on this.
   */
  private isRetryable(operationType: OperationType): boolean {
    return ['transaction', 'sync', 'webhook'].includes(operationType);
  }

  private isIgnorable(severity: FailureSeverity): boolean {
    return ['low', 'medium'].includes(severity);
  }

  private generateId(): string {
    return `fail_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  getAllFailures(): PartialFailure[] {
    return Array.from(this.failures.values());
  }

  clearResolved(): number {
    const resolved: string[] = [];

    this.failures.forEach((failure, id) => {
      if (failure.status === 'resolved') {
        resolved.push(id);
      }
    });

    resolved.forEach((id) => {
      this.failures.delete(id);
      // Clean up from tracking maps
      const resolvedSet = this.failuresByStatus.get('resolved');
      if (resolvedSet) {
        resolvedSet.delete(id);
      }
    });

    return resolved.length;
  }
}

export const partialFailureTracker = new PartialFailureTracker();

// Exported helper functions

export function recordFailure(
  operationType: OperationType,
  operationId: string,
  internalState: Record<string, unknown>,
  errorMessage: string,
  externalRefId?: string,
  severity?: FailureSeverity
): PartialFailure {
  return partialFailureTracker.recordFailure(
    operationType,
    operationId,
    internalState,
    errorMessage,
    externalRefId,
    severity
  );
}

export function retryFailure(failureId: string): boolean {
  return partialFailureTracker.retryFailure(failureId);
}

export function markFailureResolved(failureId: string, notes?: string): boolean {
  return partialFailureTracker.markResolved(failureId, notes);
}

export function markFailureManualIntervention(failureId: string, notes?: string): boolean {
  return partialFailureTracker.markManualIntervention(failureId, notes);
}

export function ignoreFailure(failureId: string, reason?: string): boolean {
  return partialFailureTracker.ignoreFailure(failureId, reason);
}

export function getFailure(failureId: string): PartialFailure | null {
  return partialFailureTracker.getFailure(failureId);
}

export function getFailuresByType(operationType: OperationType): PartialFailure[] {
  return partialFailureTracker.getFailuresByType(operationType);
}

export function getFailuresByStatus(status: FailureStatus): PartialFailure[] {
  return partialFailureTracker.getFailuresByStatus(status);
}

export function getFailuresByResource(resourceId: string): PartialFailure[] {
  return partialFailureTracker.getFailuresByResource(resourceId);
}

export function getCriticalFailures(): PartialFailure[] {
  return partialFailureTracker.getCriticalFailures();
}

export function getStaleFailures(beforeMs?: number): PartialFailure[] {
  return partialFailureTracker.getStaleFailures(beforeMs);
}

export function getRetryableFailures(): PartialFailure[] {
  return partialFailureTracker.getRetryableFailures();
}

export function getFailureReport(): FailureReport {
  return partialFailureTracker.generateReport();
}
