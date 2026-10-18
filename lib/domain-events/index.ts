/**
 * Stable, versioned contracts for Trellis domain events.
 *
 * Import surface for the event contract. Producers should use
 * {@link publishDomainEvent}; consumers should use
 * {@link subscribeDomainEvent} or {@link subscribeDomainChannel}. Both validate
 * against the catalog in `registry.ts`, which is the single place an event
 * name, payload schema, or version is declared.
 *
 * See `docs/DOMAIN_EVENTS.md` for the versioning policy and the consumer
 * compatibility expectations.
 */

export {
  DOMAIN_EVENT_NAME_PATTERN,
  DOMAIN_EVENT_VERSION_PATTERN,
  DomainEventValidationError,
  EventEnvelopeSchema,
  UnknownDomainEventError,
  formatIssues,
  type DomainEventDelivery,
  type DomainEventEnvelope,
  type DomainEventFallbackContext,
  type DomainEventParseResult,
  type DomainEventPublishError,
  type DomainEventRejectionReason,
  type DomainEventStability,
  type DomainEventTransport,
  type LegacyDomainEventContext,
  type PublishDomainEventOptions,
  type SubscribeDomainEventOptions,
  type TryPublishDomainEventOptions,
  type TryPublishResult,
} from './types';

export {
  DOMAIN_EVENTS,
  assertCatalogValid,
  collectCatalogProblems,
  composeParseSchema,
  composePublishSchema,
  describeCatalog,
  getDomainEventDefinition,
  getDomainEventSchema,
  listDomainEventDefinitions,
  ConnectionChangeSchema,
  ConnectionQualityChangeSchema,
  NetworkChangedSchema,
  NetworkChangedSchemaV1,
  OfflineQueueChangeSchema,
  OfflineQueueSyncResultSchema,
  PwaInstallAvailableSchema,
  PwaInstalledSchema,
  PwaUpdateAvailableSchema,
  StellarNetworkSchema,
  ThemeModeSchema,
  ThemeMutatedSchema,
  WalletDisconnectedSchema,
  type AnyDomainEventDefinition,
  type CatalogLike,
  type DomainEventDefinition,
  type DomainEventMeta,
  type EventPayloadFor,
  type PayloadOfVersions,
  type RegisteredEventName,
} from './registry';

export {
  buildSnapshot,
  checkSchemaEvolution,
  checkVersionChain,
  describeSchema,
  diffSchemas,
  type CompatProblem,
  type SchemaDescriptor,
  type SchemaSnapshot,
} from './compat';

export {
  createBroadcastDelivery,
  createWindowDelivery,
  publishDomainEvent,
  tryPublishDomainEvent,
} from './emit';

export {
  DEFAULT_RETRY_POLICY,
  DLQ_STORAGE_KEY,
  DeadLetterQueue,
  computeBackoffMs,
  deadLetterQueue,
  type DeadLetterEntry,
  type DeadLetterInput,
  type RetryPolicy,
} from './dlq';

export {
  compareSemver,
  parseDomainEvent,
  subscribeDomainChannel,
  subscribeDomainEvent,
  type DomainEventHandler,
  type ParseDomainEventOptions,
  type SubscribeWindowOptions,
} from './consume';
