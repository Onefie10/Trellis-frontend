/**
 * Typed errors and retryability classification for Trellis operations.
 *
 * Why this exists: retrying is only safe when the caller can tell a *transient*
 * failure (worth another attempt) from a *permanent* one (retrying burns quota
 * and hides the real defect). Before this module every call site classified
 * errors with its own string matching, so an identical 500 could be retried in
 * one place and dead-ended in another. Classification now lives in one place and
 * both the scheduler and `lib/partial-failures.ts` consume it.
 *
 * Scope: classification only. Scheduling bounds live in `./policy`, terminal
 * records live in `./dead-letter`.
 */

/**
 * Transient HTTP statuses. The request may succeed unchanged on a later attempt.
 * 425/429 cover proxy and rate-limit backpressure, which must be honoured rather
 * than retried immediately.
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Permanent HTTP statuses. Retrying cannot change the outcome, so these are
 * dead-lettered on the first failure instead of consuming the retry budget.
 */
const PERMANENT_HTTP_STATUS = new Set([
  400, 401, 403, 404, 405, 406, 409, 410, 415, 422,
]);

/**
 * Transport-level failures. These never reach an HTTP status, so they are
 * matched on message text. `AbortError` is deliberately absent: a caller-initiated
 * cancellation is permanent, not transient.
 */
const TRANSIENT_MESSAGE_PATTERN =
  /network|timeout|timed out|econnreset|econnrefused|econnaborted|enotfound|epipe|socket hang up|failed to fetch|load failed|rate limit|too many requests|service unavailable|gateway timeout|internal server error|overloaded/i;

/** Message fragments that mean "this will never succeed", regardless of class. */
const PERMANENT_MESSAGE_PATTERN =
  /invalid|validation|unauthorized|unauthenticated|forbidden|not authorized|not permitted|insufficient balance|underfunded|user rejected|user declined|not found|already exists|conflict|unsupported|expired|bad request/i;

export type FailureKind = 'retryable' | 'permanent';

export interface ErrorClassification {
  kind: FailureKind;
  /** Convenience mirror of `kind === 'retryable'`. */
  retryable: boolean;
  /** HTTP status when the failure carried one. */
  status?: number;
  /** Human-readable justification, surfaced in dead-letter records. */
  reason: string;
}

export interface ApiErrorInit {
  status: number;
  statusText?: string;
  body?: unknown;
  url?: string;
  cause?: unknown;
}

/**
 * An HTTP failure that preserves the status and parsed body.
 *
 * `lib/api.ts` previously threw `new Error("API error: <statusText>")`, which
 * discarded the status code and body. Without the status there is no way to tell
 * a retryable 503 from a permanent 422, so classification had to guess from the
 * status text alone.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
  readonly url?: string;

  constructor(message: string, init: ApiErrorInit) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.statusText = init.statusText ?? '';
    this.body = init.body;
    this.url = init.url;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

/**
 * Marks an error as permanently failing even when its status or message would
 * otherwise look transient. Use for domain rules that a retry cannot satisfy,
 * e.g. a Stellar transaction that failed simulation for a structural reason.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'NonRetryableError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Raised when a retryable operation used its entire budget without succeeding. */
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly operationClass: string;
  readonly operationId: string;
  /** Id of the dead-letter record created for this failure, when one was queued. */
  readonly deadLetterId?: string;
  readonly cause?: unknown;

  constructor(init: {
    attempts: number;
    operationClass: string;
    operationId: string;
    deadLetterId?: string;
    cause?: unknown;
  }) {
    super(
      `Retry budget exhausted for ${init.operationClass} ${init.operationId} after ${init.attempts} attempt(s)`,
    );
    this.name = 'RetryExhaustedError';
    this.attempts = init.attempts;
    this.operationClass = init.operationClass;
    this.operationId = init.operationId;
    this.deadLetterId = init.deadLetterId;
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

/** Extracts an HTTP status from the shapes Trellis actually throws. */
function readStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;

  const candidate = error as
    | { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
    | null
    | undefined;
  if (!candidate || typeof candidate !== 'object') return undefined;

  const raw =
    (typeof candidate.status === 'number' && candidate.status) ||
    (typeof candidate.statusCode === 'number' && candidate.statusCode) ||
    (typeof candidate.response?.status === 'number' && candidate.response.status) ||
    undefined;

  return raw && raw > 0 ? raw : undefined;
}

/**
 * Decides whether a failure is worth another attempt.
 *
 * Precedence is deliberate and deny-biased, so a caller cannot accidentally turn
 * a permanent failure into an infinite retry:
 *   1. `NonRetryableError` is always permanent.
 *   2. An explicit abort/cancellation is always permanent.
 *   3. A known HTTP status decides, transient or permanent.
 *   4. Message text decides for transport failures.
 *   5. Anything unrecognised is treated as retryable, matching the existing
 *      convention in `lib/soroban/errors.ts`. This is safe only because the
 *      scheduler enforces a bounded `maxRetries`; an unbounded retry loop over
 *      unclassified errors would not be.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof NonRetryableError) {
    return {
      kind: 'permanent',
      retryable: false,
      reason: `Marked non-retryable: ${error.message}`,
    };
  }

  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || /abort|cancel/i.test(name)) {
    return {
      kind: 'permanent',
      retryable: false,
      reason: 'Operation was aborted or cancelled by the caller',
    };
  }

  const status = readStatus(error);
  if (status !== undefined) {
    if (RETRYABLE_HTTP_STATUS.has(status)) {
      return {
        kind: 'retryable',
        retryable: true,
        status,
        reason: `Transient HTTP ${status}`,
      };
    }
    if (PERMANENT_HTTP_STATUS.has(status)) {
      return {
        kind: 'permanent',
        retryable: false,
        status,
        reason: `Permanent HTTP ${status}`,
      };
    }
    // 5xx outside the allow-list is still a server fault; 4xx outside it is the
    // client's request, which will not improve on its own.
    const kind: FailureKind = status >= 500 ? 'retryable' : 'permanent';
    return {
      kind,
      retryable: kind === 'retryable',
      status,
      reason: `HTTP ${status} treated as ${kind}`,
    };
  }

  const message = readMessage(error);
  if (PERMANENT_MESSAGE_PATTERN.test(message)) {
    return {
      kind: 'permanent',
      retryable: false,
      reason: `Non-transient error: ${message}`,
    };
  }
  if (TRANSIENT_MESSAGE_PATTERN.test(message)) {
    return {
      kind: 'retryable',
      retryable: true,
      reason: `Transient error: ${message}`,
    };
  }

  return {
    kind: 'retryable',
    retryable: true,
    reason: 'Unclassified error treated as retryable within a bounded budget',
  };
}
