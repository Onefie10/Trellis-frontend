import { z } from 'zod';

import { STELLAR_NETWORK_IDS } from '../types';

import {
  DOMAIN_EVENT_NAME_PATTERN,
  DOMAIN_EVENT_VERSION_PATTERN,
  EventEnvelopeSchema,
  type DomainEventStability,
  type DomainEventTransport,
} from './types';

/**
 * The catalog of every domain event Trellis publishes, keyed by event name.
 *
 * Each entry carries a semver **per payload schema version**, not just one
 * schema. Keeping the superseded schemas is what makes consumer fallback real:
 * a build that understands `1.0.0` can still read an event published by an
 * older tab because `1.0.0` is still resolvable here. When a payload changes
 * incompatibly, the old entry stays and `currentVersion` moves, so both sides
 * of a rolling deploy keep working.
 *
 * Producer-side validation is enforced by `publishDomainEvent` in `emit.ts`.
 * Everything in this catalog is therefore a real, enforced contract.
 *
 * **Not yet under schema control** (see the backlog in `docs/DOMAIN_EVENTS.md`):
 * the `trellis-notification-sync` BroadcastChannel messages in
 * `lib/notifications.ts`, and the `postMessage` types exchanged with
 * `public/sw.js` - the service worker is plain JavaScript and cannot import
 * this module.
 */

/* -------------------------------------------------------------------------- */
/* Payload schemas                                                             */
/* -------------------------------------------------------------------------- */

export const OfflineQueueChangeSchema = z.object({
  /** How many submissions are still waiting to be replayed. */
  pending: z.number().int('Pending count must be an integer').min(0, 'Pending count cannot be negative'),
});

export const OfflineQueueSyncResultSchema = z.object({
  /** Ids the server accepted; the UI reports this count back to the user. */
  synced: z.array(z.string()),
  /** Ids discarded as poison payloads or after too many attempts. */
  dropped: z.array(z.string()),
  /** Submissions still queued after the flush. */
  remaining: z.number().int('Remaining count must be an integer').min(0, 'Remaining count cannot be negative'),
});

/**
 * The three PWA lifecycle events are pure notifications, so their flags are
 * literals rather than booleans. That is intentional: it documents that the
 * producer only ever signals the positive transition, and it turns a future
 * `available: false` into a loud validation failure instead of a silent
 * behaviour change. Relaxing a literal is a minor version.
 */
export const PwaUpdateAvailableSchema = z.object({
  available: z.literal(true),
});

export const PwaInstallAvailableSchema = z.object({
  available: z.literal(true),
});

export const PwaInstalledSchema = z.object({
  installed: z.literal(true),
});

export const ConnectionChangeSchema = z.object({
  /** Mirrors `navigator.onLine` at the moment the event fired. */
  online: z.boolean(),
});

/**
 * Mirrors the Network Information API. Every optional field is absent on
 * browsers that do not expose `navigator.connection`, so all of them are
 * optional and a consumer must tolerate a bare `{ online }`.
 */
export const ConnectionQualityChangeSchema = z.object({
  online: z.boolean(),
  effectiveType: z.string().min(1).optional(),
  downlink: z.number().nonnegative().optional(),
  rtt: z.number().nonnegative().optional(),
  saveData: z.boolean().optional(),
});

/**
 * The Stellar networks Trellis supports.
 *
 * Derived from `STELLAR_NETWORK_IDS` in `lib/types.ts` rather than restated, so
 * a network the app can produce is always a network a consumer can read. The
 * previous hand-written list named `public` and `sandbox`, neither of which
 * appears anywhere else in the app: the app models mainnet as `mainnet`, and has
 * no `sandbox` network. Publishing `NETWORK_CHANGED` with real app data
 * therefore threw. See `NetworkChangedSchemaV1` for the superseded shape.
 */
export const StellarNetworkSchema = z.enum(STELLAR_NETWORK_IDS);

export const ThemeModeSchema = z.enum(['light', 'dark', 'system']);

/**
 * `reason` is optional because the event firing is the signal; the reason is
 * enrichment. Making it required would force every producer to invent a value.
 */
export const WalletDisconnectedSchema = z.object({
  reason: z.string().min(1).optional(),
});

/**
 * The superseded `NETWORK_CHANGED` payload.
 *
 * Registered so a tab still running the 1.0.0 catalog keeps working. The old
 * vocabulary could not be produced by the app, so no real 1.0.0 event exists in
 * the wild; this entry exists so the version bump is correct rather than
 * silent. It is a **major** bump because the accepted values changed, which is
 * exactly the case the policy in `docs/DOMAIN_EVENTS.md` says requires one.
 */
export const NetworkChangedSchemaV1 = z.object({
  network: z.enum(['public', 'testnet', 'sandbox', 'futurenet']),
});

/** The new network is required: a "network changed" event without it is noise. */
export const NetworkChangedSchema = z.object({
  network: StellarNetworkSchema,
});

export const ThemeMutatedSchema = z.object({
  mode: ThemeModeSchema,
});

/* -------------------------------------------------------------------------- */
/* Definition shape                                                            */
/* -------------------------------------------------------------------------- */

/** Descriptive, non-generic half of a definition. */
export interface DomainEventMeta<TName extends string = string> {
  readonly name: TName;
  /** Short human title, used by the docs and the validation CLI. */
  readonly title: string;
  /** What a consumer can rely on this event to mean. */
  readonly description: string;
  readonly transport: DomainEventTransport;
  readonly stability: DomainEventStability;
  /** The version new payloads are published under. */
  readonly currentVersion: string;
  /** Release or feature the event was introduced in. */
  readonly introducedIn: string;
  /** Required when `stability` is `deprecated`; explains what replaces it. */
  readonly upgradeNotes?: string;
}

/**
 * A definition plus its version -> schema map. Generic over the map rather
 * than over a single payload type so the concrete schema types survive
 * inference, which is what lets `EventPayloadFor<'offline-queue-change'>`
 * resolve to `{ pending: number }`.
 */
export type DomainEventDefinition<
  TName extends string = string,
  TVersions extends Readonly<Record<string, z.ZodTypeAny>> = Readonly<Record<string, z.ZodTypeAny>>,
> = DomainEventMeta<TName> & { readonly versions: TVersions };

/** A definition with the payload type erased, for runtime-only lookups. */
export type AnyDomainEventDefinition = DomainEventDefinition<string, Readonly<Record<string, z.ZodTypeAny>>>;

function defineEvent<TName extends string, TVersions extends Readonly<Record<string, z.ZodTypeAny>>>(
  input: DomainEventMeta<TName> & { readonly versions: TVersions },
): DomainEventDefinition<TName, TVersions> {
  return input;
}

/* -------------------------------------------------------------------------- */
/* The catalog                                                                 */
/* -------------------------------------------------------------------------- */

export const DOMAIN_EVENTS = {
  'offline-queue-change': defineEvent({
    name: 'offline-queue-change',
    title: 'Offline queue depth changed',
    description:
      'The number of queued offline mutations changed. Consumers render the pending count. Fired on enqueue, on flush, and after a service-worker driven replay.',
    transport: 'window',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'PWA offline queue',
    versions: { '1.0.0': OfflineQueueChangeSchema },
  }),

  'offline-queue-synced': defineEvent({
    name: 'offline-queue-synced',
    title: 'Offline queue flushed',
    description:
      'A flush of the offline submission queue completed. Reports which submissions were accepted, which were dropped, and how many remain. Consumers use synced.length for the confirmation message.',
    transport: 'window',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'PWA offline queue',
    versions: { '1.0.0': OfflineQueueSyncResultSchema },
  }),

  'sw-update': defineEvent({
    name: 'sw-update',
    title: 'Service worker update waiting',
    description:
      'A new service worker is installed and waiting to activate. Consumers set their "update available" state; the literal available:true is the signal.',
    transport: 'window',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'PWA update prompt',
    versions: { '1.0.0': PwaUpdateAvailableSchema },
  }),

  'pwa-install-available': defineEvent({
    name: 'pwa-install-available',
    title: 'Install prompt available',
    description:
      'The browser fired beforeinstallprompt and the app captured it. Consumers may show an install button; the literal available:true is the signal.',
    transport: 'window',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'PWA install prompt',
    versions: { '1.0.0': PwaInstallAvailableSchema },
  }),

  'pwa-installed': defineEvent({
    name: 'pwa-installed',
    title: 'App installed',
    description: 'The app was installed to the device. Consumers hide their install affordances.',
    transport: 'window',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'PWA install prompt',
    versions: { '1.0.0': PwaInstalledSchema },
  }),

  'connection-change': defineEvent({
    name: 'connection-change',
    title: 'Connectivity changed',
    description:
      'The browser went online or offline. Consumers flip their online/offline banner. Derived from the native online/offline events.',
    transport: 'window',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'PWA connectivity banner',
    versions: { '1.0.0': ConnectionChangeSchema },
  }),

  'connection-quality-change': defineEvent({
    name: 'connection-quality-change',
    title: 'Connection quality changed',
    description:
      'The Network Information API reported a change in effective type, downlink, rtt, or saveData. Optional fields are absent on browsers without navigator.connection, so consumers must tolerate a bare { online }.',
    transport: 'window',
    stability: 'experimental',
    currentVersion: '1.0.0',
    introducedIn: 'PWA connectivity banner',
    versions: { '1.0.0': ConnectionQualityChangeSchema },
  }),

  WALLET_DISCONNECTED: defineEvent({
    name: 'WALLET_DISCONNECTED',
    title: 'Wallet disconnected in another tab',
    description:
      'Another tab disconnected the wallet, so this tab must offer to align its session. Payload reason is optional enrichment; the event firing is the signal.',
    transport: 'broadcast',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'Session continuity',
    versions: { '1.0.0': WalletDisconnectedSchema },
  }),

  NETWORK_CHANGED: defineEvent({
    name: 'NETWORK_CHANGED',
    title: 'Stellar network changed in another tab',
    description:
      'Another tab switched the active Stellar network. network is required, not optional, and uses the same vocabulary as the rest of the app: mainnet, testnet, or futurenet. Version 1.0.0 used a "public"/"sandbox" vocabulary the app never produced and is retained only so an older tab is not disconnected abruptly.',
    transport: 'broadcast',
    stability: 'stable',
    currentVersion: '2.0.0',
    introducedIn: 'Session continuity',
    versions: {
      '1.0.0': NetworkChangedSchemaV1,
      '2.0.0': NetworkChangedSchema,
    },
  }),

  THEME_MUTATED: defineEvent({
    name: 'THEME_MUTATED',
    title: 'Theme changed in another tab',
    description: 'Another tab changed the colour scheme. Consumers re-read the stored preference.',
    transport: 'broadcast',
    stability: 'stable',
    currentVersion: '1.0.0',
    introducedIn: 'Session continuity',
    versions: { '1.0.0': ThemeMutatedSchema },
  }),
} as const;

/** Every event name in the catalog. */
export type RegisteredEventName = keyof typeof DOMAIN_EVENTS;

/** Infer the payload type a set of registered schemas produces. */
export type PayloadOfVersions<TVersions extends Readonly<Record<string, z.ZodTypeAny>>> =
  TVersions[keyof TVersions] extends z.ZodType<infer TPayload> ? TPayload : never;

/** The payload a consumer receives for `TName` at its current version. */
export type EventPayloadFor<TName extends RegisteredEventName> = PayloadOfVersions<
  (typeof DOMAIN_EVENTS)[TName]['versions']
>;

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

/** Look up a definition, or `undefined` for an unregistered name. */
export function getDomainEventDefinition(name: string): AnyDomainEventDefinition | undefined {
  return (DOMAIN_EVENTS as Record<string, AnyDomainEventDefinition | undefined>)[name];
}

/** Every definition, in declaration order. */
export function listDomainEventDefinitions(): AnyDomainEventDefinition[] {
  return Object.values(DOMAIN_EVENTS) as unknown as AnyDomainEventDefinition[];
}

/**
 * Resolve the schema for one version of an event. Returns `undefined` for an
 * unregistered version, which is how the consumer path detects a producer that
 * is newer than this build.
 */
export function getDomainEventSchema(name: string, version: string): z.ZodTypeAny | undefined {
  return getDomainEventDefinition(name)?.versions[version];
}

/**
 * Compose the strict frame schema with the payload schema for a definition's
 * current version. This is the single schema a produced event must satisfy.
 * `.extend` preserves the envelope's `.strict()`, so an undeclared top-level
 * field is still a validation failure.
 */
export function composePublishSchema(definition: AnyDomainEventDefinition): z.ZodTypeAny {
  return envelopeShape(definition.name, definition.currentVersion, requireVersionSchema(definition, definition.currentVersion));
}

/** Compose a frame + payload schema for an arbitrary registered version. */
export function composeParseSchema(definition: AnyDomainEventDefinition, version: string): z.ZodTypeAny {
  return envelopeShape(definition.name, version, requireVersionSchema(definition, version));
}

function requireVersionSchema(definition: AnyDomainEventDefinition, version: string): z.ZodTypeAny {
  const payloadSchema = definition.versions[version];

  if (!payloadSchema) {
    throw new Error(
      `Domain event "${definition.name}" has no schema registered for version ${version}. ` +
        `Readable versions: ${Object.keys(definition.versions).join(', ') || '<none>'}.`,
    );
  }

  return payloadSchema;
}

function envelopeShape(name: string, version: string, payloadSchema: z.ZodTypeAny): z.ZodTypeAny {
  return EventEnvelopeSchema.extend({
    name: z.literal(name),
    version: z.literal(version),
    payload: payloadSchema,
  });
}

/* -------------------------------------------------------------------------- */
/* Catalog integrity                                                           */
/* -------------------------------------------------------------------------- */

export type CatalogLike = Readonly<Record<string, AnyDomainEventDefinition>>;

const VALID_TRANSPORTS: readonly DomainEventTransport[] = ['window', 'broadcast'];
const VALID_STABILITIES: readonly DomainEventStability[] = ['stable', 'experimental', 'deprecated'];

/**
 * Check the catalog for the mistakes that make a contract lie: a definition
 * that does not match its key, a `currentVersion` with no schema, a version
 * key that is not semver, a missing description, or a deprecation with no
 * replacement guidance.
 *
 * Pure and exported so the test suite can assert that a *deliberately* broken
 * catalog is actually rejected. The import-time guard below only ever runs
 * against the real catalog, which is what you want in production and useless
 * for proving the guard works.
 */
export function collectCatalogProblems(catalog: CatalogLike): string[] {
  const problems: string[] = [];

  for (const [key, definition] of Object.entries(catalog)) {
    if (!definition || typeof definition !== 'object') {
      problems.push(`${key}: definition is not an object.`);
      continue;
    }

    const label = definition.name || key;

    if (key !== definition.name) {
      problems.push(`${label}: catalog key "${key}" does not match definition.name "${definition.name}".`);
    }

    if (!DOMAIN_EVENT_NAME_PATTERN.test(definition.name ?? '')) {
      problems.push(`${label}: name does not match the required pattern.`);
    }

    if (!definition.title || definition.title.trim().length === 0) {
      problems.push(`${label}: title is required.`);
    }

    if (!definition.description || definition.description.trim().length === 0) {
      problems.push(`${label}: description is required so consumers know the contract.`);
    }

    if (!definition.introducedIn || definition.introducedIn.trim().length === 0) {
      problems.push(`${label}: introducedIn is required.`);
    }

    if (!VALID_TRANSPORTS.includes(definition.transport)) {
      problems.push(`${label}: transport must be "window" or "broadcast", got "${definition.transport}".`);
    }

    if (!VALID_STABILITIES.includes(definition.stability)) {
      problems.push(`${label}: stability must be stable, experimental, or deprecated.`);
    }

    if (definition.stability === 'deprecated' && !definition.upgradeNotes?.trim()) {
      problems.push(`${label}: a deprecated event must declare upgradeNotes.`);
    }

    const versions = Object.keys(definition.versions ?? {});

    if (versions.length === 0) {
      problems.push(`${label}: at least one versioned schema is required.`);
      continue;
    }

    for (const version of versions) {
      if (!DOMAIN_EVENT_VERSION_PATTERN.test(version)) {
        problems.push(`${label}: version key "${version}" is not semantic (major.minor.patch).`);
      }

      const schema = definition.versions[version];
      if (!schema || typeof schema.safeParse !== 'function') {
        problems.push(`${label}: version ${version} does not map to a zod schema.`);
      }
    }

    if (!DOMAIN_EVENT_VERSION_PATTERN.test(definition.currentVersion ?? '')) {
      problems.push(
        `${label}: currentVersion "${definition.currentVersion}" is not semantic (major.minor.patch).`,
      );
    } else if (!definition.versions[definition.currentVersion]) {
      problems.push(
        `${label}: currentVersion ${definition.currentVersion} has no registered schema. ` +
          'Add that schema or point currentVersion at an existing version.',
      );
    }
  }

  return problems;
}

/** Throwing wrapper used as the import-time guard. */
export function assertCatalogValid(catalog: CatalogLike): void {
  const problems = collectCatalogProblems(catalog);

  if (problems.length > 0) {
    throw new Error(
      `Domain event catalog is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }
}

// Fail fast: a malformed contract must never reach a production bundle.
assertCatalogValid(DOMAIN_EVENTS as unknown as CatalogLike);

/** Flat, log-friendly view of the catalog for docs and the validation CLI. */
export function describeCatalog(): Array<{
  name: string;
  version: string;
  transport: DomainEventTransport;
  stability: DomainEventStability;
  readableVersions: string[];
  title: string;
  description: string;
  introducedIn: string;
}> {
  return listDomainEventDefinitions().map((definition) => ({
    name: definition.name,
    version: definition.currentVersion,
    transport: definition.transport,
    stability: definition.stability,
    readableVersions: Object.keys(definition.versions).sort(),
    title: definition.title,
    description: definition.description,
    introducedIn: definition.introducedIn,
  }));
}
