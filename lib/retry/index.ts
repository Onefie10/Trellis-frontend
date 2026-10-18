/**
 * Centralised retry, backoff, and dead-letter handling.
 *
 * Import from `@/lib/retry` rather than the individual modules so the retry
 * surface has one entry point. See `docs/retry-and-dead-letter.md` for the
 * policy table and operator runbook.
 */

export {
  ApiError,
  NonRetryableError,
  RetryExhaustedError,
  classifyError,
  type ApiErrorInit,
  type ErrorClassification,
  type FailureKind,
} from './errors';

export {
  DEFAULT_OPERATION_POLICIES,
  OPERATION_CLASSES,
  computeBackoffDelay,
  isOperationClass,
  plannedBackoffSchedule,
  resolvePolicy,
  type JitterStrategy,
  type OperationClass,
  type OperationPolicy,
  type RetryPolicy,
} from './policy';

export {
  DeadLetterQueue,
  InMemoryDeadLetterStore,
  deadLetterQueue,
  type DeadLetterQuery,
  type DeadLetterReason,
  type DeadLetterRecord,
  type DeadLetterResolution,
  type DeadLetterStore,
  type RetryAttempt,
} from './dead-letter';

export {
  RetryScheduler,
  executeWithRetry,
  type ExecuteOptions,
  type ExecuteResult,
  type RetryObserver,
  type RetryState,
} from './scheduler';
