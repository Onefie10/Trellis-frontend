# Offline mutation queue

`PWAManager` persists queued requests in the browser's versioned local-storage queue. Entries survive refreshes and disconnects. The page replays them in FIFO order after reconnect or a background-sync wake-up. Endpoints that support optimistic concurrency should queue their version in an `If-Match` header; HTTP `409` and `412` responses are retained as conflicts instead of being silently discarded or replayed forever.

## Conflict handling

A conflict stays in the queue and blocks later entries, preserving FIFO semantics. The offline banner shows the request label and response status. After reviewing current server state, the user may explicitly retry the same request or discard it. A retry resets its failure counter; it does not rewrite the request body or version header, so it can conflict again until the caller supplies a request based on current state. Other client errors (`400`--`499`, except `409`/`412`) remain terminal and are dropped; server errors and network failures are retained for bounded retry.

## Operational edge cases and recovery

- Private browsing, disabled storage, or quota exhaustion can prevent persistence. In those modes the queue's storage adapter degrades to best-effort behavior; do not tell users the request is safely queued unless the queue count confirms it.
- Replays require the authenticated page context. Background Sync only wakes the page; it does not replay credentials inside the service worker.
- Requests are stored in local storage. Do not put secrets or credentials in queued bodies or custom headers; authentication should be attached by the normal application request flow.
- Multiple tabs can observe the same persisted queue. Endpoints should be idempotent and enforce concurrency with `If-Match`/version checks; the server remains authoritative. Queue entries are not a cross-tab transaction lock.
- To recover from an incorrect queued operation, use **Discard** on its conflict row. To retry after updating server state, use **Retry after reviewing current state**; if the request version is now obsolete, construct a fresh operation through the normal UI.
- Rollback requires no server migration: revert the client change and clear `trellis.offline-submissions.v1` from browser local storage only if the user consents to losing queued requests. Prefer resolving or discarding individual entries first.

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
