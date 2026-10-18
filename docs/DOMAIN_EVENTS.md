# Domain Event Contract

Trellis domain events are the messages that cross a boundary inside the app: a
`window` `CustomEvent`, or a cross-tab `BroadcastChannel` message.

Before this contract, those boundaries were typed by convention only — a string
literal plus an inline object literal. A producer could rename a field, drop a
field, or change a type, and no compiler, test, or consumer would notice until
runtime. This document is the compatibility promise that replaces that.

`lib/domain-events/` is the single source of truth. Event names, payload
schemas, and versions all live in `lib/domain-events/registry.ts`.

---

## The two guarantees

**Producer side — nothing is delivered until it has validated.**
`publishDomainEvent` builds the full envelope, validates it against the
registered schema for that name and version, and only then hands the *parsed*
result to the transport. An invalid payload throws `DomainEventValidationError`
and delivers nothing. An unregistered name throws `UnknownDomainEventError`.

**Consumer side — a typed handler is only ever called with a validated payload.**
`subscribeDomainEvent` / `subscribeDomainChannel` validate every inbound event
against the schema registered for that exact name and version. Anything the
consumer cannot understand is diverted to the fallback instead of reaching the
handler and failing three frames later.

Together these mean a consumer never has to re-validate defensively, and a
producer cannot ship drift silently.

---

## The envelope

Every event crosses the wire in the same frame. Validated with `.strict()`, so a
producer cannot smuggle in an undeclared top-level field.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Registry key. Also the `CustomEvent` type on the `window` transport. |
| `version` | semver string | **Explicit** payload schema version, e.g. `1.0.0`. Never omitted. |
| `id` | string | Correlation id, unique per publication. |
| `timestamp` | ISO 8601 | Publication time. |
| `source` | string | Producer identity — a tab id or a subsystem name. |
| `payload` | object | Validated against the schema for `name` + `version`. |

`version` is the version of **this event name's payload schema**, not of the
envelope. Changing the envelope itself (adding, renaming, or removing any field
above) is breaking for every registered event at once and needs a new envelope
revision.

---

## Registered events

Regenerate this table with `npm run validate:events -- --catalog`.

| Event | Version | Transport | Stability | Readable versions |
| --- | --- | --- | --- | --- |
| `offline-queue-change` | 1.0.0 | window | stable | 1.0.0 |
| `offline-queue-synced` | 1.0.0 | window | stable | 1.0.0 |
| `sw-update` | 1.0.0 | window | stable | 1.0.0 |
| `pwa-install-available` | 1.0.0 | window | stable | 1.0.0 |
| `pwa-installed` | 1.0.0 | window | stable | 1.0.0 |
| `connection-change` | 1.0.0 | window | stable | 1.0.0 |
| `connection-quality-change` | 1.0.0 | window | **experimental** | 1.0.0 |
| `WALLET_DISCONNECTED` | 1.0.0 | broadcast | stable | 1.0.0 |
| `NETWORK_CHANGED` | 2.0.0 | broadcast | stable | 1.0.0, 2.0.0 |
| `THEME_MUTATED` | 1.0.0 | broadcast | stable | 1.0.0 |

Event names are lowercase-kebab for `window` events and SCREAMING_SNAKE for
cross-tab session events. That reflects the two conventions already in the
codebase; the name pattern accepts both rather than forcing a rename.

---

## Versioning policy

Versions are **strict** semver — `major.minor.patch`, all three parts required.
`1.0` and `latest` are both refused with `malformed-version`. This is
deliberately stricter than the unrelated record-migration framework in
`lib/schema-versioning.ts`, which accepts a two-part version; the two systems
have different jobs and are not interchangeable.

### What each bump means

| Change | Bump |
| --- | --- |
| Add an optional payload field | **minor** |
| Widen a payload type (add an enum member, accept a wider range) | **minor** |
| Relax a literal (`available: true` → `boolean`) | **minor** |
| Rename a field | **major** |
| Remove a field | **major** |
| Narrow a type, make an optional field required | **major** |
| Add a new event name | none — start at `1.0.0` |

**The mechanism that makes minor bumps safe** is that payload schemas are
*non-strict* while the envelope is *strict*. An old consumer validating a
newer producer's `1.1.0` payload under `1.0.0` strips the unknown keys and
proceeds, because every field `1.0.0` promised is still present and still
correct. That is why the additive rule is safe and why renaming is not.

### Keeping old versions readable

When a payload changes incompatibly, the superseded schema **stays** in
`versions` and `currentVersion` moves:

```ts
NETWORK_CHANGED: defineEvent({
  currentVersion: '2.0.0',
  versions: {
    '1.0.0': NetworkChangedSchemaV1,  // still readable
    '2.0.0': NetworkChangedSchemaV2,
  },
}),
```

This is what makes a rolling deploy survivable. An older tab can still publish
`1.0.0`; a newer tab can still read it. Do not delete a version until every
deployed build has moved past it.

### Stability levels

- `stable` — changes only per the rules above.
- `experimental` — may change in a **minor** version without notice.
  `connection-quality-change` is experimental because it mirrors a browser API
  that is not universally available.
- `deprecated` — must declare `upgradeNotes` naming the replacement. The
  catalog guard refuses a deprecation without them.

---

## Consumer compatibility expectations

This section is the contract consumers rely on. If any of it is not true, that
is a bug in `lib/domain-events/`, not a consumer's problem.

**1. Your handler only ever receives a validated payload.**
The payload you are handed satisfied the schema registered for that exact `name`
and `version` at the moment it was received. You do not need to re-validate,
coerce, or null-check a required field.

**2. Unknown keys are already stripped.**
You receive exactly the fields your declared version promises — not the raw
producer object. A producer's extra fields cannot leak into your handler.

**3. An unknown version never reaches your handler.**
If a producer is newer than your build, its event goes to the fallback with
`reason: 'unknown-version'`. This holds even when the payload is perfectly
valid, which is exactly the case a naive implementation gets wrong.

**4. A missing `payload` key is an envelope failure, not a payload failure.**
`z.unknown()` is implicitly optional in zod, so `parseDomainEvent` checks for
the key's presence itself and reports `invalid-envelope`. A broken frame and
bad payload content are distinguishable, which matters when debugging drift.

**5. A registered but non-current version is reported as legacy, not dropped.**
You get `onLegacy(payload, context)` with `receivedVersion`, `currentVersion`,
and `isFuture`. If you do not provide `onLegacy`, the event goes to the fallback
with `reason: 'legacy-version'` rather than being silently discarded.

**6. Cross-tab events are cross-checked against the transport.**
On the `broadcast` transport there is no out-of-band name, so an envelope whose
`name` disagrees with the channel it arrived on is rejected as
`invalid-envelope`.

**7. An unregistered name is `unknown-event`, never a best-effort guess.**
An unregistered name means the producer is unregistered, not that the payload
is unrecognisable. It goes to the fallback.

### Rejection reasons

| Reason | Means |
| --- | --- |
| `not-an-object` | The message was not an object at all. |
| `unknown-event` | No registry entry for this name. |
| `invalid-envelope` | The frame is wrong — missing `version`, bad `timestamp`, undeclared top-level field, name/transport mismatch, or missing `payload`. |
| `malformed-version` | `version` is absent or not strict semver. |
| `unknown-version` | Semver, but not registered. Usually a producer newer than this build. |
| `legacy-version` | Registered, but not the current version. |
| `invalid-payload` | The payload did not satisfy the registered schema. |

### Graceful degradation

Supply a `fallback` and the event is never lost silently. `hooks/usePWA.ts` is
the reference implementation — it logs the reason, both versions, and the
validation issues, then leaves state untouched rather than acting on an
unvalidated payload.

```ts
const unsubscribe = subscribeDomainEvent(
  'connection-change',
  (payload) => setState((prev) => ({ ...prev, isOnline: payload.online })),
  {
    fallback: ({ name, reason, receivedVersion, currentVersion, issues }) =>
      console.warn(`[usePWA] ignored "${name}" (${reason}, v${receivedVersion ?? 'absent'})`, issues),
  },
);
```

---

## Adding an event

1. **Declare the payload schema** in `lib/domain-events/registry.ts`, with a
   doc comment on every field.
2. **Register it** in `DOMAIN_EVENTS` via `defineEvent`. Every field is
   required: `name`, `title`, `description`, `transport`, `stability`,
   `currentVersion`, `introducedIn`, `versions`. The import-time guard
   (`assertCatalogValid`) throws on a malformed entry, so a broken contract
   never reaches a production bundle.
3. **Export the schema** from `lib/domain-events/index.ts` if a consumer needs
   it by name.
4. **Publish** with `publishDomainEvent`. Never dispatch a `CustomEvent` or
   `postMessage` a domain event by hand.
5. **Subscribe** with `subscribeDomainEvent` or `subscribeDomainChannel`, and
   register a `fallback`.
6. **Add a fixture** for the event to
   `tests/fixtures/domain-events/valid-events.json`. `npm run validate:events`
   fails if a registered event has no fixture, so this step cannot be skipped.

### Network vocabulary

`StellarNetworkSchema` is derived from `STELLAR_NETWORK_IDS` in `lib/types.ts`
rather than restated, so a network the app can produce is always a network a
consumer can read. The two cannot drift again.

It used to be a hand-written list of `public | testnet | sandbox | futurenet`,
which matched nothing else in the app: `lib/types.ts` and
`lib/stellar-constants.ts` model mainnet as `mainnet`, and the app has no
`sandbox` Stellar network. Publishing `NETWORK_CHANGED` with real app data threw
`DomainEventValidationError`.

That is why `NETWORK_CHANGED` is at **2.0.0**. Changing the accepted values is a
narrowing, so it takes a major bump. `1.0.0` stays registered as
`NetworkChangedSchemaV1` so a tab still on the old catalog is not disconnected
abruptly — it is accepted as a legacy version and routed to `onLegacy`. No real
1.0.0 event exists in the wild, since the old vocabulary could not be produced.

---

## Validation

```bash
npm run validate:events            # replay every recorded fixture
npm run validate:events -- --json  # machine-readable
npm run validate:events -- --catalog  # print the catalog inventory
```

Non-mutating and read-only. Exits non-zero on any mismatch, and verifies that
every registered event is covered by a fixture. Fixtures live in
`tests/fixtures/domain-events/`:

| Fixture | Contains |
| --- | --- |
| `valid-events.json` | One accepted envelope per registered event. |
| `invalid-missing-field.json` | Payload missing a required field, or with the wrong type. |
| `invalid-unknown-version.json` | Unknown, missing, and malformed versions. |
| `invalid-envelope.json` | Bad frames and non-object messages. |

The Jest suite (`tests/__tests__/domain-events.test.ts`) replays the same
fixtures and adds the producer, consumer, and catalog-guard coverage. Run it
with `npm test`.

---

## Handler failures: retry and dead letter queue

A subscriber handler that throws (or returns a rejected promise) is retried
with exponential backoff: 3 retries after 2s, 4s and 8s by default. Override
with the `retry` subscription option (`{ maxRetries, baseDelayMs }`).

When retries are exhausted the validated envelope is captured in the dead
letter queue (`lib/domain-events/dlq.ts`, persisted to `localStorage`) with
the error and attempt count, so it is never silently lost.

Maintainers can inspect the payload and **Replay** or **Discard** entries from
the "Failed domain events" panel on `/dashboard/operations`. Replay re-runs the
handler of the live subscriber (matched by `label`, falling back to the event
name) once, without retries; if it fails again the entry stays in the queue.
Give subscribers distinct `label`s if more than one handles the same event.

---

## Not yet under schema control

These boundaries still carry untyped messages. Do not assume they validate.

- `trellis-notification-sync` `BroadcastChannel` messages in
  `lib/notifications.ts` — same treatment, not yet migrated.
- `postMessage` types exchanged with `public/sw.js` — **not migratable** by
  design. The service worker is plain JavaScript and cannot import this module.
- `lib/feature-flags.ts` listener set and `storage` events.
- Analytics and agent telemetry, which have their own separate contracts —
  see `docs/telemetry-event-contract.md`. Do not conflate them with domain
  events.
