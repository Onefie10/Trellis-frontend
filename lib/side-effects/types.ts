/**
 * Side-Effect Dispatcher Types and Contracts.
 *
 * Implements keyed, retryable, observable, and dead-letter recoverable
 * side-effect execution for client mutations (wallet, on-chain transactions,
 * API writes, telemetry, and background sync).
 */

import type { OperationClass, RetryPolicy } from '@/lib/retry/policy';
import type { ErrorClassification } from '@/lib/retry/errors';

export type SideEffectStatus =
  | 'idle'
  | 'queued'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered';

export interface SideEffectMetadata {
  /** Optional correlation id for tracking across client/server telemetry. */
  correlationId?: string;
  /** Wallet public key associated with this action, if applicable. */
  walletAddress?: string;
  /** UI component or feature dispatching the effect. */
  source?: string;
  /** Custom operational metadata. */
  [key: string]: unknown;
}

export interface RetryAttemptRecord {
  readonly attemptNumber: number;
  readonly timestamp: number;
  readonly error: string;
  readonly classification?: ErrorClassification;
  readonly delayMs: number;
}

export interface SideEffectDescriptor<TPayload = unknown> {
  /** Unique semantic operation name (e.g. 'wallet:payout', 'soroban:mint'). */
  readonly action: string;
  /** Deterministic or attempt-scoped key identifying this side-effect instance. */
  readonly key: string;
  /** JSON-serializable request payload. */
  readonly payload: TPayload;
  /** Retry classification profile. */
  readonly operationClass?: OperationClass;
  /** Optional retry policy overrides. */
  readonly retryPolicy?: Partial<RetryPolicy> & { retryable?: boolean };
  /** Metadata for logging, telemetry, and audit. */
  readonly metadata?: SideEffectMetadata;
  /** Custom TTL in milliseconds for the idempotency record. */
  readonly ttlMs?: number;
}

export interface DeadLetterSideEffect<TPayload = unknown> {
  readonly id: string;
  readonly key: string;
  readonly action: string;
  readonly payload: TPayload;
  readonly operationClass: OperationClass;
  readonly attempts: readonly RetryAttemptRecord[];
  readonly totalAttempts: number;
  readonly lastError: string;
  readonly metadata?: SideEffectMetadata;
  readonly createdAt: number;
  readonly failedAt: number;
  readonly resolvedAt?: number;
  readonly resolution?: 'replayed' | 'discarded';
}

export type SideEffectTelemetryEvent =
  | { type: 'side_effect_queued'; key: string; action: string; metadata?: SideEffectMetadata }
  | { type: 'side_effect_started'; key: string; action: string; attempt: number }
  | { type: 'side_effect_cached_hit'; key: string; action: string; cachedAt: number }
  | { type: 'side_effect_retry'; key: string; action: string; attempt: number; delayMs: number; error: string }
  | { type: 'side_effect_succeeded'; key: string; action: string; attempts: number; durationMs: number }
  | { type: 'side_effect_dead_lettered'; key: string; action: string; deadLetterId: string; error: string }
  | { type: 'side_effect_recovered'; key: string; action: string; deadLetterId: string };

export type SideEffectTelemetryObserver = (event: SideEffectTelemetryEvent) => void;

export interface SideEffectExecutionResult<TResult = unknown> {
  readonly ok: boolean;
  readonly key: string;
  readonly status: SideEffectStatus;
  readonly result?: TResult;
  readonly error?: string;
  readonly isCached: boolean;
  readonly attempts: number;
  readonly deadLetterId?: string;
}

export interface DispatcherOptions {
  /** Injectable sleep function for deterministic time advancement in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter random source in [0, 1). */
  random?: () => number;
  /** Injectable timestamp source. */
  now?: () => number;
  /** Telemetry observer callback. */
  onTelemetry?: SideEffectTelemetryObserver;
}
