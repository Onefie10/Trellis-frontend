# Offline mutation queue

`PWAManager` persists queued requests in the browser's versioned local-storage queue. Entries survive refreshes and disconnects. The page replays them in FIFO order after reconnect or a background-sync wake-up. Endpoints that support optimistic concurrency should queue their version in an `If-Match` header; HTTP `409` and `412` responses are retained as conflicts instead of being silently discarded or replayed forever.

## Conflict handling

A conflict stays in the queue and blocks later entries, preserving FIFO semantics. The offline banner shows the request label and response status. After reviewing current server state, the user may explicitly retry the same request or discard it. A retry resets its failure counter; it does not rewrite the request body or version header, so it can conflict again until the caller supplies a request based on current state. Other client errors (`400`–`499`, except `409`/`412`) remain terminal and are dropped; server errors and network failures are retained for bounded retry.

## Operational edge cases and recovery

- Private browsing, disabled storage, or quota exhaustion can prevent persistence. In those modes the queue's storage adapter degrades to best-effort behavior; do not tell users the request is safely queued unless the queue count confirms it.
- Replays require the authenticated page context. Background Sync only wakes the page; it does not replay credentials inside the service worker.
- Requests are stored in local storage. Do not put secrets or credentials in queued bodies or custom headers; authentication should be attached by the normal application request flow.
- Multiple tabs can observe the same persisted queue. Endpoints should be idempotent and enforce concurrency with `If-Match`/version checks; the server remains authoritative. Queue entries are not a cross-tab transaction lock.
- To recover from an incorrect queued operation, use **Discard** on its conflict row. To retry after updating server state, use **Retry after reviewing current state**; if the request version is now obsolete, construct a fresh operation through the normal UI.
- Rollback requires no server migration: revert the client change and clear `trellis.offline-submissions.v1` from browser local storage only if the user consents to losing queued requests. Prefer resolving or discarding individual entries first.

## Cross-service contract map

This map lists every domain event and integration boundary that touches the offline mutation queue. It is the authoritative reference for producers, consumers, required fields, version rules, and allowed failure behavior. Automated tests in `src/lib/offline/___tests__/contract-map.test.ts` verify that this document stays in sync with the runtime constants in `src/lib/offline/contract-map.ts`.

### Event catalog

Each event has a stable name, a version, an explicit producer and consumer set, a required field list, and an allowed failure policy. Producers MUST emit the required fields with the declared types; consumers MUST tolerate additional unknown fields for forward compatibility.

| Event | Version | Producer | Consumers | Required fields | Allowed failure behavior |
| --- | --- | --- | --- | --- | --- |
| `offline.queue.enqueued`.1 | 1 | `PWAManager.enqueue` | `OfflineBanner`, `TelemetrySink` | `id`, label`, `method`, `url`, `headers`, `body`, `queuedAt`, `attempts`, `status` | Never fatal. Enqueue failures degrade to best-effort storage and emit `offline.queue.storage-degraded`.1. |
| `offline.queue.replay-started`.1 | 1 | `ReplayEngine.flush` | `OfflineBanner`, `TelemetrySink` | `id`, `queueeAt`, `attempts`, `startedAt` | Never fatal. Missing telemetry must not block replay. |
| `offline.queue.replay-succeeded`.1 | 1 | `ReplayEngine.flush` | `OfflineBanner`, `TelemetrySink` | `id`, `status`, `finishedAt`, `attempts` | Never fatal. Entry is removed from the queue before consumers are notified. |
| `offline.queue.replay-conflict`.1 | 1 | `ReplayEngine.flush` | `OfflineBanner`, `TelemetrySink` | `id`, `status`, `serverVersion`, `conflictAt` | Never fatal. Entry remains in the queue and blocks later entries. |
| `offline.queue.replay-failed`.1 | 1 | `ReplayEngine.flush` | `OfflineBanner`, `TelemetrySink` | `id`, `status`, `reason`, `attempts` | Never fatal. Retained for bounded retry or dropped if terminal. |
| `offline.queue.discarded`.1 | 1 | `OfflineBanner.discard` | `TelemetrySink` | `id`, `reason`, `discardedAt` | Never fatal. User-initiated; must not be blocked by telemetry failure. |
| `offline.queue.storage-degraded`.1 | 1 | `QueueStorageAdapter` | `OfflineBanner`, `TelemetrySink` | `reason`, `detectedAt` | Never fatal. Banner must stop claiming requests are safely queued. |

### Integration boundaries

| Boundary | Direction | Protocol | Required fields | Version rules | Allowed failure behavior |
| --- | --- | --- | --- | --- | --- |
| `PWAManager -> QueueStorageAdapter` | outbound | in-process | `id`, `label`, `method`, `url`, `headers`, `body`, `queuedAt`, `attempts`, `status` | Storage key `trellis.offline-submissions.v1` is versioned; bump the suffix on breaking shape changes and migrate on read. | Quota exhaustion or disabled storage degrades to best-effort and emits `offline.queue.storage-degraded`.1. |
| `ReplayEngine -> API` | outbound | HTTP | `method`, `url`, `headers`, `body`, `If-Match` (when a version is known) | Request body and `If-Match` are immutable across retries. A retry must not rewrite the version header. | `409`/`412` become conflicts and block FIFO. `400–499` (except `409`/`412`) are terminal and dropped. `5xx` and network errors are retained for bounded retry. |
| `Background Sync -> ReplayEngine` | inbound | Service Worker postMessage | `type: "trellis.offline.replay"`, `queuedAt` | Message type is versioned by the `trellis.offline.` prefix; unknown types are ignored. | With no authenticated page context the wake-up is ignored; no credentials are replayed inside the service worker. |
| `QueueStorageAdapter -> Other Tabs` | bidirectional | local storage events | `key`, `newValue` | Storage key is versioned as described above. | Tabs observe the same queue but do not hold a cross-tab lock; the server remains authoritative via `If-Match`. |
| `TelemetrySink -> Observability` | outbound | HTTP/beacon | `event`, `version`, `timestamp`, `payload` | Event names are versioned with a trailing `.1`; new versions are additive and old consumers must ignore unknown fields. | Telemetry failures are swallowed and must never block queue operations. |

### Version rules

- Event names carry a trailing `.<version>` suffix. Adding optional fields is a additive change and keeps the current version. Removing or retyping a required field requires a new version and a migration note here.
- The persisted queue key is `trellis.offline-submissions.v1`. Bump the `v1` suffix on breaking shape changes and migrate existing entries on read.
- `If-Match` values are opaque to the client. The client MUST not normalize, rewrite, or regenerate them during retry.
- Background Sync message types are namespaced under `trellis.offline.`; unknown types are ignored without error.

### Allowed failure behavior summary

- Network failures and `5xx` responses: retained for bounded retry with exponential backoff.
- `409`/`412`: retained as conflicts, block FIFO, surfaced in the offline banner for explicit retry or discard.
- Other `400–499`: terminal, dropped from the queue and reported via `offline.queue.replay-failed`.1.
- Storage failures: degrade to best-effort and emit `offline.queue.storage-degraded`.1; the UI must not claim the request is safely queued.
- Telemetry failures: swallowed; they must never block queue operations.

## Operational edge cases and recovery

- Private browsing, disabled storage, or quota exhaustion can prevent persistence. In those modes the queue's storage adapter degrades to best-effort behavior; do not tell users the request is safely queued unless the queue count confirms it.
- Replays require the authenticated page context. Background Sync only wakes the page; it does not replay credentials inside the service worker.
- Requests are stored in local storage. Do not put secrets or credentials in queued bodies or custom headers; authentication should be attached by the normal application request flow.
- Multiple tabs can observe the same persisted queue. Endpoints should be idempotent and enforce concurrency with `If-Match`/version checks; the server remains authoritative. Queue entries are not a cross-tab transaction lock.
- To recover from an incorrect queued operation, use **Discard** on its conflict row. To retry after updating server state, use **Retry after reviewing current state**; if the request version is now obsolete, construct a fresh operation through the normal UI.
- Rollback requires no server migration: revert the client change and clear `trellis.offline-submissions.v1` from browser local storage only if the user consents to losing queued requests. Prefer resolving or discarding individual entries first.

## Verification

The contract map is executable: `src/lib/offline/contract-map.ts` exports the same event and boundary definitions as typed records, and `src/lib/offline/___tests__/contract-map.test.ts` asserts that:

1. Every entry in the event catalog has a non-empty producer, at least one consumer, a non-empty required-fields list, and a non-empty failure policy.
2. Every event name ends with a `.<version>` suffix and the version matches the numeric suffix.
3. Every boundary declares a direction in `{ inbound, outbound, bidirectional }`.
4. The persisted storage key used by the runtime matches `trellis.offline-submissions.v1`.
5. The conflict statuses consumed by the replay engine are exactly `[409, 412]`.

Run the verification with the repository test runner:

```bash
npm test -- contract-map
```

## Rollback and recovery

- Rollback requires no server migration: revert the client change and clear `trellis.offline-submissions.v1` from browser local storage only if the user consents to losing queued requests. Prefer resolving or discarding individual entries first.
- If a contract change is reverted after being shipped, bump the event version and keep the old consumer path available until all consumers have migrated.
- Telemetry events are additive; dropping an event from the catalog is a breaking change and requires a version bump and a migration note in this document.

## Deterministic chaos test suite

The chaos suite exercises interrupted user and background workflows without relying on wall-clock timing. Every test drives the queue through an injected clock, a seeded PRNG, and a controlled fetch double so results are repeatable across machines.

The suite lives in `tests/chaos/offline-queue.chaos.test.ts` and is run with `npm test -- chaos.` It uses three harness primitives:

- `createChaosClock()` — a deterministic `now()` source that only advances when a test calls `tick(ms)`. Retry backoff and queue expiry are asserted against this clock, not `Date.now()` or `setTimeout`.
- `createChaosFetch(script)` — a fetch replacement that returns programmed responses or throws programmed network errors in order. The script is an explicit array, so a given test always sees the same sequence.
- `seedQueue(entries)` — writes a known queue state into the versioned local-storage key before the code under test loads.

The cases covered by the suite are:

1. **Network failure then recovery.** A network error is retained and retried on the next drain after the clock advances past the backoff window; the entry eventually succeeds and leaves the queue.
2. **Restart mid-replay.** The page is torn down after the first entry is sent but before its acknowledgement is persisted; a fresh context loads the same storage and replays without duplicating the acknowledged entry.
3. **Stale reads.** An `If-Match` request receives `412`, and the entry is retained as a conflict that blocks later entries until the user resolves it.
4. **Terminal client errors.** A 400-499 response other than 409/412 drops the entry and lets the next entry drain.
5. **Bounded retry.** Repeated server errors increase the failure counter and eventually stop retrying without dropping the entry.
6. **Multi-tab concurrency.** Two drains share the same storage and must not send the same entry twice; the second drain observes the acknowledged state.
7. **Storage failure.** When the storage adapter throws on write, the queue count reflects the failure and the UI does not claim the request is safely queued.

Each case asserts on the persisted queue snapshot and the recorded request log, never on elapsed wall-time. The chaos clock is the only source of time, and the fetch script is the only source of network behavior, so failures reproduce exactly on every run.

## Failure modes and rollback steps

- If a drain appears stuck, check the conflict row first: a conflict blocks FIFO by design. Resolve or discard the conflict before investigating later entries.
- If a request keeps conflicting after retry, the caller must construct a fresh operation from current server state; retry never rewrites the body or version header.
- If the queue count does not increase after an offline mutation, treat the request as not queued and surface the storage error to the user.
- Rollback: revert the client change, then clear `trellis.offline-submissions.v1` from browser local storage only with explicit user consent. Prefer resolving or discarding individual entries first. No server migration is required.