import {
  composePublishSchema,
  getDomainEventDefinition,
  type AnyDomainEventDefinition,
  type EventPayloadFor,
  type RegisteredEventName,
} from './registry';
import {
  DomainEventValidationError,
  UnknownDomainEventError,
  formatIssues,
  type DomainEventDelivery,
  type DomainEventEnvelope,
  type PublishDomainEventOptions,
  type TryPublishDomainEventOptions,
  type TryPublishResult,
} from './types';

/**
 * Producer side of the domain event contract.
 *
 * The one rule this module enforces: **nothing is delivered until it has
 * validated.** Every publish path builds the full envelope, validates it
 * against the registered schema, and only then hands the *parsed* result to
 * the transport. Dispatching the parse output rather than the raw candidate
 * matters for forward compatibility - a payload schema is non-strict, so
 * unknown keys are stripped, and consumers receive exactly the fields their
 * declared version promises.
 *
 * A failed validation is not a warning. The event is not published, because
 * the entire value of the contract is that a downstream consumer can trust the
 * frame it receives.
 */

let fallbackEventCounter = 0;

/**
 * `crypto.randomUUID` is unavailable in some jsdom and non-secure contexts, so
 * fall back to a timestamp+counter id rather than failing a publication over a
 * correlation id.
 */
function defaultEventId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;

  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }

  fallbackEventCounter += 1;
  return `evt-${Date.now().toString(36)}-${fallbackEventCounter.toString(36)}`;
}

interface ValidatedPublication {
  definition: AnyDomainEventDefinition;
  envelope: DomainEventEnvelope<unknown>;
}

function buildAndValidate<TName extends RegisteredEventName>(
  name: TName,
  payload: EventPayloadFor<TName>,
  options: PublishDomainEventOptions,
): ValidatedPublication {
  const definition = getDomainEventDefinition(name);

  if (!definition) {
    throw new UnknownDomainEventError(name);
  }

  const now = options.now ? options.now() : new Date();

  const candidate = {
    name,
    version: definition.currentVersion,
    id: options.id ?? defaultEventId(),
    timestamp: now.toISOString(),
    source: options.source,
    payload,
  };

  const result = composePublishSchema(definition).safeParse(candidate);

  if (!result.success) {
    throw new DomainEventValidationError(
      name,
      definition.currentVersion,
      formatIssues(result.error),
    );
  }

  return { definition, envelope: result.data as DomainEventEnvelope<unknown> };
}

/**
 * Validate and publish a domain event.
 *
 * Throws {@link DomainEventValidationError} when the payload does not satisfy
 * its registered schema, and {@link UnknownDomainEventError} when the name is
 * not in the catalog. In both cases nothing is delivered. This fail-fast shape
 * matches the existing convention in `lib/invitations.ts` and
 * `lib/partial-failures.ts`, where invalid data is rejected rather than stored.
 *
 * @returns the validated envelope that was delivered.
 */
export function publishDomainEvent<TName extends RegisteredEventName>(
  name: TName,
  payload: EventPayloadFor<TName>,
  options: PublishDomainEventOptions,
): DomainEventEnvelope<EventPayloadFor<TName>> {
  const { envelope } = buildAndValidate(name, payload, options);

  options.delivery.dispatch(envelope);

  return envelope as DomainEventEnvelope<EventPayloadFor<TName>>;
}

/**
 * Non-throwing {@link publishDomainEvent} for call sites that must not
 * interrupt a user flow (a queued offline mutation, a background listener).
 *
 * With the default `onInvalid: 'throw'` this re-raises, so switching to it is
 * opt-in and visible. Set `onInvalid: 'drop'` to discard the event and get
 * `{ ok: false }` back instead.
 */
export function tryPublishDomainEvent<TName extends RegisteredEventName>(
  name: TName,
  payload: EventPayloadFor<TName>,
  options: TryPublishDomainEventOptions,
): TryPublishResult<EventPayloadFor<TName>> {
  try {
    return { ok: true, envelope: publishDomainEvent(name, payload, options) };
  } catch (error) {
    const isContractError =
      error instanceof DomainEventValidationError || error instanceof UnknownDomainEventError;

    if (options.onInvalid === 'drop' && isContractError) {
      return { ok: false, error };
    }

    throw error;
  }
}

/**
 * Deliver over the DOM `window` as a `CustomEvent` whose `detail` is the
 * validated envelope. The `CustomEvent` name is the registry key, so
 * `addEventListener` keeps working as the subscription mechanism.
 *
 * Throws when there is no DOM, because silently discarding a domain event in a
 * server render would hide a real wiring bug. Call sites that already guard on
 * `typeof window !== 'undefined'` should keep that guard.
 */
export function createWindowDelivery(target?: EventTarget): DomainEventDelivery {
  const resolved = target ?? (typeof window !== 'undefined' ? window : undefined);

  if (!resolved) {
    throw new Error(
      'createWindowDelivery() requires a DOM EventTarget. The window event transport is browser-only; ' +
        'guard the call site on typeof window !== "undefined".',
    );
  }

  return {
    transport: 'window',
    dispatch(envelope) {
      resolved.dispatchEvent(new CustomEvent(envelope.name, { detail: envelope }));
    },
  };
}

/**
 * Deliver over a `BroadcastChannel` as the bare envelope. A `null` channel is
 * tolerated and becomes a no-op, matching the existing
 * `this.channel?.postMessage(...)` behaviour in non-browser and
 * no-BroadcastChannel environments.
 */
export function createBroadcastDelivery(channel: BroadcastChannel | null): DomainEventDelivery {
  return {
    transport: 'broadcast',
    dispatch(envelope) {
      channel?.postMessage(envelope);
    },
  };
}
