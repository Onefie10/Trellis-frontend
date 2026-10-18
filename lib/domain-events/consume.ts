import { z } from 'zod';

import {
  composeParseSchema,
  getDomainEventDefinition,
  type AnyDomainEventDefinition,
  type EventPayloadFor,
  type RegisteredEventName,
} from './registry';
import {
  formatIssues,
  type DomainEventEnvelope,
  type DomainEventFallbackContext,
  type DomainEventParseResult,
  type DomainEventRejectionReason,
  type SubscribeDomainEventOptions,
} from './types';
import { DOMAIN_EVENT_VERSION_PATTERN } from './types';
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  deadLetterQueue as sharedDeadLetterQueue,
} from './dlq';

/**
 * Consumer side of the domain event contract.
 *
 * The guarantee this module provides: **a typed handler is only ever called
 * with a payload that validated against the schema registered for that exact
 * name and version.** Everything a consumer cannot understand is diverted to
 * `options.fallback` instead of being handed to the handler and blowing up
 * three frames later.
 *
 * That is the whole point of carrying an explicit version. Without it a
 * consumer has to either trust every payload (and break on drift) or
 * re-validate defensively everywhere.
 */

/** A consumer callback that has been proven to receive a valid payload. */
export type DomainEventHandler<TName extends RegisteredEventName> = (
  payload: EventPayloadFor<TName>,
  envelope: DomainEventEnvelope<EventPayloadFor<TName>>,
) => void | Promise<void>;

export interface ParseDomainEventOptions {
  /**
   * The event name the transport implies. Required for `broadcast`, where the
   * message carries no out-of-band name; for `window` it is the `CustomEvent`
   * type and is used to cross-check the envelope.
   */
  name?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split a zod failure into "the frame is wrong" versus "the payload is wrong",
 * so a consumer can tell a drifted frame from a drifted field.
 */
function classifyIssues(issues: readonly z.ZodIssue[]): DomainEventRejectionReason {
  if (issues.some((issue) => issue.code === 'unrecognized_keys')) {
    return 'invalid-envelope';
  }

  if (issues.some((issue) => issue.path[0] === 'payload')) {
    return 'invalid-payload';
  }

  return 'invalid-envelope';
}

/**
 * Validate an untrusted event against the catalog. Never throws: an event that
 * fails to parse is a normal, expected condition on a shared channel, not an
 * exceptional one.
 */
export function parseDomainEvent(
  raw: unknown,
  options: ParseDomainEventOptions = {},
): DomainEventParseResult {
  if (!isPlainObject(raw)) {
    return {
      status: 'rejected',
      name: null,
      version: null,
      reason: 'not-an-object',
      issues: [`expected an event envelope object, received ${Array.isArray(raw) ? 'an array' : typeof raw}`],
    };
  }

  const envelopeName = typeof raw.name === 'string' ? raw.name : null;
  const name = options.name ?? envelopeName;

  if (!name) {
    return {
      status: 'rejected',
      name: null,
      version: null,
      reason: 'unknown-event',
      issues: ['event has no name, and the transport supplied none'],
    };
  }

  if (envelopeName !== null && envelopeName !== name) {
    return {
      status: 'rejected',
      name,
      version: typeof raw.version === 'string' ? raw.version : null,
      reason: 'invalid-envelope',
      issues: [`envelope name "${envelopeName}" does not match the transport name "${name}"`],
    };
  }

  const definition = getDomainEventDefinition(name);

  if (!definition) {
    return {
      status: 'rejected',
      name,
      version: typeof raw.version === 'string' ? raw.version : null,
      reason: 'unknown-event',
      issues: [`"${name}" is not registered in lib/domain-events/registry.ts`],
    };
  }

  const version = raw.version;

  if (!('payload' in raw)) {
    // Checked before the schema runs because `z.unknown()` is *implicitly
    // optional*, so a frame with no `payload` key at all would otherwise
    // surface as a payload failure. A missing payload is a broken frame, not
    // bad payload content, and a consumer debugging drift needs that
    // distinction.
    return {
      status: 'rejected',
      name,
      version: typeof version === 'string' ? version : null,
      reason: 'invalid-envelope',
      issues: ['payload is required on every domain event envelope'],
    };
  }

  if (typeof version !== 'string') {
    return {
      status: 'rejected',
      name,
      version: null,
      reason: 'malformed-version',
      issues: ['version is required and must be an explicit semantic version string'],
    };
  }

  if (!DOMAIN_EVENT_VERSION_PATTERN.test(version)) {
    return {
      status: 'rejected',
      name,
      version,
      reason: 'malformed-version',
      issues: [
        `version "${version}" is not semantic (expected major.minor.patch, e.g. ${definition.currentVersion})`,
      ],
    };
  }

  if (!definition.versions[version]) {
    return {
      status: 'rejected',
      name,
      version,
      reason: 'unknown-version',
      issues: [
        `version ${version} is not readable by this build. ` +
          `Readable: ${Object.keys(definition.versions).join(', ')}.`,
      ],
    };
  }

  const result = composeParseSchema(definition, version).safeParse(raw);

  if (!result.success) {
    return {
      status: 'rejected',
      name,
      version,
      reason: classifyIssues(result.error.issues),
      issues: formatIssues(result.error),
    };
  }

  return {
    status: 'accepted',
    name,
    version,
    isLegacy: version !== definition.currentVersion,
    payload: (result.data as DomainEventEnvelope<unknown>).payload,
    envelope: result.data as DomainEventEnvelope<unknown>,
  };
}

function deliver<TName extends RegisteredEventName>(
  name: TName,
  raw: unknown,
  handler: DomainEventHandler<TName>,
  options: SubscribeDomainEventOptions<TName>,
): void {
  const result = parseDomainEvent(raw, { name });
  const definition = getDomainEventDefinition(name) as AnyDomainEventDefinition;

  if (result.status === 'rejected') {
    if (options.fallback) {
      options.fallback({
        name: result.name ?? name,
        receivedVersion: result.version,
        currentVersion: definition?.currentVersion ?? null,
        reason: result.reason,
        payload: isPlainObject(raw) ? raw.payload : undefined,
        issues: result.issues,
      });
    }
    return;
  }

  const accept = options.acceptVersions;

  if (accept && !accept.includes(result.version)) {
    options.fallback?.({
      name,
      receivedVersion: result.version,
      currentVersion: definition.currentVersion,
      reason: 'unknown-version',
      payload: result.payload,
      issues: [`version ${result.version} is not in the accepted list [${accept.join(', ')}]`],
    });
    return;
  }

  if (result.isLegacy) {
    // A readable but non-current version. The payload no longer matches the
    // schema the handler was typed against, so it must not reach the handler.
    if (options.onLegacy) {
      options.onLegacy(result.payload, {
        name,
        receivedVersion: result.version,
        currentVersion: definition.currentVersion,
        isFuture: compareSemver(result.version, definition.currentVersion) > 0,
      });
      return;
    }

    options.fallback?.({
      name,
      receivedVersion: result.version,
      currentVersion: definition.currentVersion,
      reason: 'legacy-version',
      payload: result.payload,
      issues: [
        `version ${result.version} is readable but is not the current version ${definition.currentVersion}. ` +
          'Provide onLegacy to handle it explicitly.',
      ],
    });
    return;
  }

  runWithRetry(name, result.envelope, handler, options);
}

/**
 * Run the handler; on a throw or rejection retry with exponential backoff
 * (default 2s, 4s, 8s) and, once retries are exhausted, capture the envelope
 * in the dead letter queue instead of losing it.
 */
function runWithRetry<TName extends RegisteredEventName>(
  name: TName,
  envelope: DomainEventEnvelope<unknown>,
  handler: DomainEventHandler<TName>,
  options: SubscribeDomainEventOptions<TName>,
): void {
  const policy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const queue = options.deadLetterQueue ?? sharedDeadLetterQueue;
  const schedule = options.scheduler ?? ((run: () => void, delay: number) => void setTimeout(run, delay));
  const subscriber = options.label ?? name;

  const invoke = () =>
    handler(
      envelope.payload as EventPayloadFor<TName>,
      envelope as DomainEventEnvelope<EventPayloadFor<TName>>,
    );

  const attempt = async (n: number): Promise<void> => {
    try {
      await invoke();
    } catch (error) {
      if (n <= policy.maxRetries) {
        schedule(() => void attempt(n + 1), computeBackoffMs(n, policy));
        return;
      }
      queue.capture({
        subscriber,
        eventName: name,
        version: envelope.version,
        envelope,
        error: error instanceof Error ? error.message : String(error),
        attempts: n,
      });
    }
  };

  void attempt(1);
}

/** Register a replayer so DLQ entries can be re-triggered against this handler. */
function registerReplay<TName extends RegisteredEventName>(
  name: TName,
  handler: DomainEventHandler<TName>,
  options: SubscribeDomainEventOptions<TName>,
): () => void {
  const queue = options.deadLetterQueue ?? sharedDeadLetterQueue;
  return queue.registerReplayer(options.label ?? name, async (raw) => {
    const parsed = parseDomainEvent(raw, { name });
    if (parsed.status === 'rejected') throw new Error(parsed.issues.join('; '));
    await handler(
      parsed.payload as EventPayloadFor<TName>,
      parsed.envelope as DomainEventEnvelope<EventPayloadFor<TName>>,
    );
  });
}

/** Compare two semver strings. Returns -1, 0, or 1. */
export function compareSemver(left: string, right: string): -1 | 0 | 1 {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;

    if (a > b) return 1;
    if (a < b) return -1;
  }

  return 0;
}

export interface SubscribeWindowOptions<TName extends RegisteredEventName>
  extends SubscribeDomainEventOptions<TName> {
  /** Defaults to `window`. Injected in tests. */
  target?: EventTarget;
}

/**
 * Subscribe to a `window` domain event. The validated payload is delivered
 * only when it satisfies the registered schema for the version on the wire.
 */
export function subscribeDomainEvent<TName extends RegisteredEventName>(
  name: TName,
  handler: DomainEventHandler<TName>,
  options: SubscribeWindowOptions<TName> = {},
): () => void {
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);

  if (!target) {
    return () => undefined;
  }

  const listener = (event: Event) => {
    deliver(name, (event as CustomEvent<unknown>).detail, handler, options);
  };

  target.addEventListener(name, listener);
  const unregisterReplay = registerReplay(name, handler, options);

  return () => {
    unregisterReplay();
    target.removeEventListener(name, listener);
  };
}

/**
 * Subscribe to a `broadcast` domain event. Unlike the `window` transport there
 * is no out-of-band name, so `name` is required and the envelope's own `name`
 * is cross-checked against it.
 */
export function subscribeDomainChannel<TName extends RegisteredEventName>(
  name: TName,
  channel: BroadcastChannel | null,
  handler: DomainEventHandler<TName>,
  options: SubscribeDomainEventOptions<TName> = {},
): () => void {
  if (!channel) {
    return () => undefined;
  }

  const listener = (event: MessageEvent) => {
    deliver(name, event.data, handler, options);
  };

  channel.addEventListener('message', listener);
  const unregisterReplay = registerReplay(name, handler, options);

  return () => {
    unregisterReplay();
    channel.removeEventListener('message', listener);
  };
}
