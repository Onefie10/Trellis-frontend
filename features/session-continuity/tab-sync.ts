import {
  compareSemver,
  createBroadcastDelivery,
  getDomainEventDefinition,
  parseDomainEvent,
  publishDomainEvent,
  type DomainEventEnvelope,
  type DomainEventFallbackContext,
  type EventPayloadFor,
  type LegacyDomainEventContext,
} from '../../lib/domain-events';

/**
 * Cross-tab session synchronization.
 *
 * The wire format used to be `{ event, payload?: unknown, source, timestamp },
 * where `payload` was unconstrained, so a receiving tab could be handed any
 * shape at all. It is now a versioned domain event: the payload is typed per
 * event name, the version is explicit, and a tab that cannot read an incoming
 * version routes it to a fallback instead of acting on garbage.
 *
 * The channel name is unchanged, so tabs on the old and new code interoperate.
 * An old tab ignores the envelope fields it does not recognise, and a new tab
 * sends the old untyped shape to its fallback rather than crashing on it.
 */
export const SESSION_SYNC_CHANNEL = 'trellis-session-sync';

export type SessionSyncEventName = 'WALLET_DISCONNECTED' | 'NETWORK_CHANGED' | 'THEME_MUTATED';

/** A session-sync message is a domain event envelope. `Name` is narrowed to
 * the session union so `SessionConflictPrompt` keeps a single discriminant.
 */
export type SessionSyncMessage = DomainEventEnvelope<unknown> & {
  name: SessionSyncEventName;
  version: string;
};

/** Payload type for a specific session event, as enforced by the catalog. */
export type SessionSyncPayload<TName extends SessionSyncEventName> = EventPayloadFor<TName>;

/** Identifies this tab, so echoed messages can be ignored. */
function defaultSource(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;

  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }

  return `tab-${Date.now().toString(36)}`;
}

/**
 * Build a validated session-sync envelope without delivering it.
 *
 * Validation is reused from the producer rather than reimplemented, so this
 * function cannot produce an envelope the registry would refuse. Passing a
 * `null` channel makes delivery a no-op, which is what lets the envelope be
 * built and validated without broadcasting it.
 */
export function createSessionSyncMessage<TPayload extends SessionSyncEventName>(
  event: TPayload,
  payload: SessionSyncPayload<TPayload>,
  source: string,
): DomainEventEnvelope<SessionSyncPayload<TPayload>> {
  return publishDomainEvent(event, payload, {
    delivery: createBroadcastDelivery(null),
    source,
  });
}

export interface SessionTabSyncOptions {
  /** Override the tab identity. Injected by tests. */
  source?: string;
  /** Called for any inbound message this build cannot read. */
  onUnreadable?: (context: DomainEventFallbackContext) => void;
  /**
   * Handle a readable but non-current version instead of dropping it. Receives
   * the raw payload, because it no longer matches the schema the current
   * consumer was typed against.
   */
  onLegacy?: (context: LegacyDomainEventContext, payload: unknown) => void;
}

/**
 * Operational edge cases and failure modes for cross-tab sync:
 *
 * - Duplicate submissions: the same logical mutation may arrive from multiple
 *   tabs or be replayed by the browser. Consumers must key on `idOf` or the
 *   envelope `id` to dedupe; this class delivers every valid envelope and
 *   does not itself dedupe.
 * - Stale versions: an envelope from a future or past schema version is routed
 *   to `onLegacy` and never reaches `subscribe` listeners.
 * - Retry storms: `publish` throws synchronously on invalid payloads and
 *   never broadcasts partial data; callers own backoff and idempotency keys.
 * - Rollback/recovery: close() detaches the channel and clears listeners; a
 *   reloaded tab re-registers with a fresh source id and re-syncs from the
 *   server of record rather than relying on in-flight broadcasts.
 */
export class SessionTabSync {
  private readonly channel: BroadcastChannel | null;
  private readonly source: string;
  private readonly listeners = new Set<(message: SessionSyncMessage) => void>();
  private readonly options: SessionTabSyncOptions;

  constructor(options: SessionTabSyncOptions = {}) {
    this.source = options.source ?? defaultSource();
    this.options = options;
    this.channel =
      typeof window !== 'undefined' && 'BroadcastChannel' in window
        ? new BroadcastChannel(SESSION_SYNC_CHANNEL)
        : null;
    this.channel?.addEventListener('message', this.handleMessage);
  }

  /**
   * Validate an inbound `BroadcastChannel` message before handing it to any
   * listener. The envelope is self-describing on this transport, so the name
   * is read from the message rather than from the channel.
   */
  private readonly handleMessage = (event: MessageEvent) => {
    const raw = event.data as { source?: string; payload?: unknown } | undefined;

    if (!raw || typeof raw !== 'object' || raw.source === this.source) {
      return;
    }

    const result = parseDomainEvent(raw);

    if (result.status === 'rejected') {
      this.options.onUnreadable?.({
        name: result.name ?? 'unknown',
        receivedVersion: result.version,
        currentVersion: result.name ? getDomainEventDefinition(result.name)?.currentVersion ?? null : null,
        reason: result.reason,
        payload: raw.payload,
        issues: result.issues,
      });
      return;
    }

    if (result.isLegacy) {
      const currentVersion = getDomainEventDefinition(result.name)?.currentVersion ?? null;

      this.options.onLegacy?.(
        {
          name: result.name,
          receivedVersion: result.version,
          currentVersion: currentVersion ?? result.version,
          isFuture: currentVersion ? compareSemver(result.version, currentVersion) > 0 : false,
        },
        result.payload,
      );
      return;
    }

    const message = result.envelope as SessionSyncMessage;
    this.listeners.forEach((listener) => listener(message));
  };

  subscribe(listener: (message: SessionSyncMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Publish a validated session event to the other tabs and return the
   * envelope that was sent. Throws if the payload does not match the
   * registered schema, in which case nothing is broadcast.
   */
  publish<TName extends SessionSyncEventName>(
    event: TName,
    payload: SessionSyncPayload<TName>,
  ): DomainEventEnvelope<SessionSyncPayload<TName>> {
    return publishDomainEvent(event, payload, {
      delivery: createBroadcastDelivery(this.channel),
      source: this.source,
    });
  }

  close() {
    this.channel?.removeEventListener('message', this.handleMessage);
    this.channel?.close();
    this.listeners.clear();
  }
}
