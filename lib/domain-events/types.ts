import { z } from 'zod';

import type { DeadLetterQueue, RetryPolicy } from './dlq';

/**
 * Stable, versioned contracts for Trellis domain events.
 *
 * A "domain event" is any message that crosses a boundary inside the app:
 * a `window` `CustomEvent`, a cross-tab `BroadcastChannel` message, or a
 * message handed to a service worker. The problem this module solves is that
 * those boundaries used to be typed by convention only — a string literal plus
 * an inline object literal — so a producer could rename a field, drop a field,
 * or change a type and no compiler, test, or consumer would notice until
 * runtime.
 *
 * The contract is a two-layer schema:
 *
 *   1. {@link EventEnvelopeSchema} - the frame every event shares. It is
 *      validated with `.strict()`, so a producer cannot smuggle in an
 *      undeclared top-level field.
 *   2. A per-event payload schema, registered against a semver version in
 *      `registry.ts`. These are deliberately *not* strict, which is what makes
 *      an additive minor version safe for an old consumer.
 *
 * Every published envelope carries an explicit `version`, so a consumer never
 * has to guess which payload shape it is holding.
 */

/**
 * Event names are lowercase-kebab for `window` events and SCREAMING_SNAKE for
 * cross-tab session events, matching the two conventions already in the
 * codebase. The pattern accepts both rather than forcing a rename.
 */
export const DOMAIN_EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Payload schema versions are strict semver so major/minor/patch mean something. */
export const DOMAIN_EVENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** How a published envelope reaches its consumers. */
export type DomainEventTransport = 'window' | 'broadcast';

/**
 * Contract maturity. `experimental` events may change in a minor version;
 * `stable` events only change per the semver rules in `docs/DOMAIN_EVENTS.md`.
 */
export type DomainEventStability = 'stable' | 'experimental' | 'deprecated';

/**
 * The frame shared by every domain event.
 *
 * `version` is the version of *this event name's payload schema*, not of the
 * envelope. Changing the envelope itself (adding, renaming, or removing any
 * field here) is a breaking change for every registered event at once and
 * requires a new envelope revision.
 */
export const EventEnvelopeSchema = z
  .object({
    /** Registry key. Also the `CustomEvent` name for the `window` transport. */
    name: z.string().regex(DOMAIN_EVENT_NAME_PATTERN, 'Event name contains unsupported characters'),
    /** Explicit payload schema version, e.g. `1.0.0`. Never omitted. */
    version: z.string().regex(DOMAIN_EVENT_VERSION_PATTERN, 'Event version must be semantic (major.minor.patch)'),
    /** Correlation id, unique per publication. Lets a log line be tied to an event. */
    id: z.string().min(1, 'Event id is required'),
    /** ISO 8601 publication time. */
    timestamp: z.string().datetime('Event timestamp must be an ISO 8601 datetime'),
    /** Producer identity, e.g. a tab id or a subsystem name. */
    source: z.string().min(1, 'Event source is required'),
    /**
     * Validated against the registered schema for `name` + `version`.
     *
     * `z.unknown()` is implicitly optional in zod, so a frame with no `payload`
     * key would pass this schema. `parseDomainEvent` therefore checks for the
     * key's presence itself and reports a missing payload as an
     * `invalid-envelope` rather than as bad payload content.
     */
    payload: z.unknown(),
  })
  .strict();

/** A published event. `payload` is generic so consumers get a concrete type. */
export interface DomainEventEnvelope<TPayload = unknown> {
  readonly name: string;
  readonly version: string;
  readonly id: string;
  readonly timestamp: string;
  readonly source: string;
  readonly payload: TPayload;
}

/**
 * Why a payload was refused. The taxonomy is deliberately fine-grained so a
 * consumer can tell an intentional future version from a typo in a field name.
 */
export type DomainEventRejectionReason =
  /** The event was not an object at all (string, number, null, ...). */
  | 'not-an-object'
  /** No registry entry exists for this `name`; the producer is unregistered. */
  | 'unknown-event'
  /** The frame itself failed validation (missing `version`, bad `timestamp`, unknown top-level field). */
  | 'invalid-envelope'
  /** `version` is not semver, so it cannot be looked up or meaningfully compared. */
  | 'malformed-version'
  /** `version` is semver but absent from the registry - typically a producer newer than this build. */
  | 'unknown-version'
  /**
   * The version is registered but is not the current one, so its payload is
   * still readable yet no longer matches the schema the typed handler expects.
   * Reached during a rolling deploy, or from an injected fixture.
   */
  | 'legacy-version'
  /** The payload did not satisfy the schema registered for this name + version. */
  | 'invalid-payload';

/** Outcome of validating an untrusted event against the registry. */
export type DomainEventParseResult<TPayload = unknown> =
  | {
      status: 'accepted';
      name: string;
      /** The version the payload was validated against. */
      version: string;
      /** True when `version` is not the current registered version. */
      isLegacy: boolean;
      payload: TPayload;
      envelope: DomainEventEnvelope<TPayload>;
    }
  | {
      status: 'rejected';
      name: string | null;
      version: string | null;
      reason: DomainEventRejectionReason;
      /** Human-readable, already formatted for logs. Empty for structural rejections. */
      issues: string[];
    };

/** Context handed to a consumer's fallback when an event cannot be dispatched normally. */
export interface DomainEventFallbackContext {
  readonly name: string;
  /** The version present on the wire, or `null` when it could not be read. */
  readonly receivedVersion: string | null;
  /** The version this build publishes and understands, or `null` for an unknown event. */
  readonly currentVersion: string | null;
  readonly reason: DomainEventRejectionReason;
  /** Raw payload, unvalidated. Never trust it - that is why you are in the fallback path. */
  readonly payload: unknown;
  readonly issues: string[];
}

/** Options for {@link publishDomainEvent}. */
export interface PublishDomainEventOptions {
  /** Where the validated envelope should be delivered. */
  delivery: DomainEventDelivery;
  /** Producer identity stamped onto the envelope. */
  source: string;
  /** Injected for deterministic tests. */
  id?: string;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

/** Options for {@link tryPublishDomainEvent}, which reports instead of throwing. */
export interface TryPublishDomainEventOptions extends PublishDomainEventOptions {
  /**
   * What to do when the payload is invalid. `'throw'` matches the fail-fast
   * house style used by `lib/invitations.ts`; `'drop'` is for call sites that
   * must not interrupt a user flow.
   */
  onInvalid?: 'throw' | 'drop';
}

/**
 * An injectable transport. Keeping delivery abstract is what lets the same
 * validated envelope be asserted on in tests without a real `window` or a real
 * `BroadcastChannel`.
 */
export interface DomainEventDelivery {
  readonly transport: DomainEventTransport;
  dispatch(envelope: DomainEventEnvelope<unknown>): void;
}

/** Options for the consumer helpers. */
export interface SubscribeDomainEventOptions<TName extends string = string> {
  /**
   * Handle a version registered for this event that is not the current one.
   * Reached when a producer is older than this build and the payload is still
   * readable, which is the normal state during a rolling deploy.
   */
  onLegacy?: (payload: unknown, context: LegacyDomainEventContext) => void;
  /**
   * Handle anything that could not be dispatched to the typed handler:
   * an unregistered version, an invalid payload, or an unknown event. This is
   * the documented graceful-degradation path - see `docs/DOMAIN_EVENTS.md`.
   */
  fallback?: (context: DomainEventFallbackContext) => void;
  /** Restrict the typed handler to a subset of registered versions. */
  acceptVersions?: readonly string[];
  /** Per-subscription event name, only useful for diagnostics. */
  label?: string;
  /** Override the handler retry/backoff policy (default 3 retries: 2s, 4s, 8s). */
  retry?: Partial<RetryPolicy>;
  /** Dead letter queue that receives events whose handler keeps failing. */
  deadLetterQueue?: DeadLetterQueue;
  /** Schedules a retry. Injected in tests; defaults to setTimeout. */
  scheduler?: (run: () => void, delayMs: number) => void;
  readonly __name?: TName;
}

/** Context for a readable but non-current version. */
export interface LegacyDomainEventContext {
  readonly name: string;
  readonly receivedVersion: string;
  readonly currentVersion: string;
  readonly isFuture: boolean;
}

/** Why a publication was refused. */
export type DomainEventPublishError = DomainEventValidationError | UnknownDomainEventError;

/** Result of {@link tryPublishDomainEvent}. */
export type TryPublishResult<TPayload> =
  | { ok: true; envelope: DomainEventEnvelope<TPayload> }
  | { ok: false; error: DomainEventPublishError };

/**
 * Thrown when a payload fails its registered schema. An event that cannot be
 * validated is never published - the whole point of the contract is that a
 * downstream consumer can trust the frame it receives.
 */
export class DomainEventValidationError extends Error {
  constructor(
    readonly eventName: string,
    readonly eventVersion: string,
    readonly issues: readonly string[],
  ) {
    super(
      `Domain event "${eventName}" failed validation for version ${eventVersion}:\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'DomainEventValidationError';
  }
}

/** Thrown when a producer references an event name that is not registered. */
export class UnknownDomainEventError extends Error {
  constructor(eventName: string) {
    super(
      `Domain event "${eventName}" is not registered. ` +
        'Add it to lib/domain-events/registry.ts before publishing it, so consumers get a schema.',
    );
    this.name = 'UnknownDomainEventError';
  }
}

/** Format a zod issue list into stable one-line messages for logs and errors. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<envelope>';
    return `${path}: ${issue.message}`;
  });
}
