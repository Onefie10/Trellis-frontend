# Idempotency for High-Risk Writes

> **Status:** The multi-actor concurrency harness described below is the executable specification for this document. Any change to the store, the client, or the attempt helpers must keep `npm test -- idempotency.concurrency` green before deploy.

`lib/idempotency.ts` makes a retried write safe. It exists because the client cannot know whether its previous request reached the server: a timeout, a dropped connection, a reloaded tab and a double click all look the same from the browser, and each one used to be a second request.

The multi-actor concurrency harness in `tests/idempotency.concurrency.test.ts` is the executable specification for the guarantees below. Run it with `npm test -- idempotency.concurrency`.

Use it for writes where a duplicate is a duplicate **side effect** — payout requests, reward claims, anything that queues settlement or moves funds. Reads and ordinary updates should keep using `apiClient.post`/`put`/`delete`.

The harness drives actors through the public `apiClient.postIdempotent` surface and the attempt helpers, not a re-implementation of them, so a regression in the store or the client shows up as a failing test rather than a production incident.

## Client

```ts
const { value, replayed } = await apiClient.postIdempotent<PayoutRequest>(
  '/affiliates/payouts',
  { walletAddress, amount, destinationAddress },
  { scope: `payout:${walletAddress}` },
);
```

`apiClient.postIdempotent` derives a key from the endpoint and payload when you do not pass one, sends it as the `Idempotency-Key` header, and remembers the outcome. `replayed: true` means the value came from a stored outcome and no second request reached the network — useful for telling the user "this was already done".

#### Failure modes it reports instead of guessing

| Situation | Result |
|---|---|
| Same key, different payload | `IdempotencyConflictError` (`IDEMPOTENCY_CONFLICT`) |
| Key past its replay window | `IdempotencyKeyExpiredError` (`IDEMPOTENCY_KEY_EXPIRED`) |
| Another tab is processing the same key | `IdempotencyInProgressError` (`IDEMPOTENCY_IN_PROGRESS`) |
| Previous attempt failed | the operation runs again |
| Previous attempt succeeded | the stored result is returned |

An `in_progress` record older than `staleInProgressMs` (30s) is treated as abandoned and retried, so a crashed tab cannot lock a key forever.

## Repeating the same request on purpose

Paying out 100 XLM twice is a legitimate second intent, so a key derived from the body alone would replay the first payout forever. For those paths the key identifies the *attempt*:

```ts
function payoutScope(walletAddress, amount, destinationAddress) {
  return `payout:${walletAddress}:${amount}:${destinationAddress}`;
}

const scope = payoutScope(walletAddress, amount, destinationAddress);
const key = await beginIdempotentAttempt(scope);   // same key for every retry of this attempt
await affiliateService.requestPayout(walletAddress, amount, destinationAddress, key);
finishIdempotentAttempt(scope);                         // only after it lands
```

The attempt is persisted, so a reload keeps the same key, and it is closed on success, so the next identical request is a new intent.

`beginIdempotentAttempt` and `finishIdempotentAttempt` are the only supported way to express a repeated intent. Do not hand-roll a key from the body for a path where the same payload can be a legitimate second action.

## Storage

Outcomes live in `localStorage` under `trellis:idempotency:` and survive a reload — a promise cache does not, which is why the previous in-memory approach could not protect a retry after a refresh. When storage is unavailable (SSR, private mode, storage disabled) the store falls back to memory and still dedupes within the page. A record that cannot be parsed is dropped, so corrupted storage cannot block every future attempt.

## Server contract

`Idempotency-Key` is accepted as a header or as a body field (`idempotencyKey`) on `POST /api/affiliates/payouts`. The route answers:

-  `201` — first request, payout queued;
-  `200` with `"Duplicate request: returning the original payout..."` — recognised replay;
-  `409` `IDEMPOTENCY_CONFLICT` — the key was used for a different payout request;
-  `409` `IDEMPOTENCY_KEY_EXPIRED` — the key is past `IDEMPOTENCY_KEY_TTL_MS` (24h).

Keys are remembered per process; a multi-instance deployment needs a shared store (Redis) for the same guarantees across instances.

## Scope

This covers duplicate **requests**. It does not make the backend's own settlement retry-safe — that is the submission path behind `submitPayoutToNetwork` — and it does not replace the operator-level checks (pending-earnings reservation, in-flight duplicate rejection) that already guard the payout flow.

## Multi-actor concurrency harness

The idempotency layer only helps if it holds up when several actors hit the same write at once. `tests/idempotency.concurrency.test.ts` is the executable specification for that: it drives the real store and client with simulated actors and asserts on the number of network calls, the error codes and the stored outcomes. Run it with `npm test -- idempotency.concurrency`.

The harness covers the race-prone mutations called out in the acceptance criteria: concurrent actors, duplicate submissions, stale versions, and retry storms around critical writes. Each scenario below is a test case in that file; adding a new race-prone write path means adding a scenario here and a matching case there.

### Actors and scenarios

| Scenario | Actors | Expected outcome |
|---|---|---|
| Double click / duplicate submission | two clicks on the same button, same payload | exactly one network call; the second actor gets `replayed: true` with the first value |
| Concurrent tabs | two tabs sharing the same scope and payload | one call; the losing tab sees `IdempotencyInProgressError` while the winner is in flight, then a replay after the winner commits |
| Stale version write | one actor writes version N, another retries version N-1 under the same key | `IdempotencyConflictError`; the stale write never queues a second side effect |
| Retry storm | a failing transport retried N times by the same actor | one logical attempt key; the first success wins and later retries replay it instead of queuing again |
| Abandoned in-progress | an actor crashes mid-request | after `staleInProgressMs` the next attempt retries instead of blocking forever |
| Distinct intents | two sequential payouts of the same amount via `beginIdempotentAttempt`/`finishIdempotentAttempt` | two network calls, one per closed attempt |

The harness drives actors through the public `apiClient.postIdempotent` surface and the attempt helpers, not a re-implementation of them, so a regression in the store or the client shows up as a failing test rather than a production incident.

Each scenario asserts on observable outcomes — network call count, error code, and stored result — rather than internal state, so the tests stay valid if the store implementation changes but the guarantees do not.

### Operational edge cases

- **Multi-instance servers.** Per-process key memory means two instances can each accept the same key. Until the shared Redis store lands, pin payout traffic to a single instance or accept that duplicate rejection is only best-effort across instances.
- `**Storage disabled.** Private mode or a full `localStorage` falls back to in-memory dedupe. The guarantee degrades from "survives reload" to "within this page"; the server still rejects duplicate keys within its TTL.
- `**Clock skew.** Expiry and stale-in-progress checks compare timestamps. A client clock far ahead can expire keys early; far behind can hold an in-progress record longer than 30s (or the configured `staleInProgressMs`). The server TTL is the authority for the final decision.
- `**Corrupted storage.** Unparseable records are dropped on read, so one bad entry cannot block future attempts. The tradeoff is that a corrupted success record is forgotten and the request may be retried; the server still recognises the key.
- `**Long-running operations.** An operation that legitimately takes longer than `staleInProgressMs` will be treated as abandoned and retried. Keep the threshold above the slowest expected write.

### Failure modes and recovery

The table below maps each failure the harness exercises to its symptom and recovery. When a new failure mode is discovered in production, add it here and add a scenario to the harness so it cannot regress silently.

| Failure | Symptom | Recovery |
|---|---|---|
| Network timeout after the server committed | client sees an error; the payout exists | retry with the same key; the server returns the original payout with the duplicate message |
| Client crashes mid-request | an `in_progress` record is left behind | wait for `staleInProgressMs` and retry; the key is not locked forever |
| Server restarts and loses its key memory | a replay is treated as a first request | operator-level in-flight duplicate rejection and pending-earnings reservation are the backstop; reconcile the queue before resetting the process in production |
| Key reused for a different payload | `IDEMPOTENCY_CONFLICT` on every attempt | start a new attempt via `beginIdempotentAttempt`; do not re-use the old key |
| Key expired client-side but not server-side (or vice versa) | `IDEMPOTENCY_KEY_EXPIRED` or a sudden conflict | clear the attempt record and restart the intent; check the payout queue before resubmitting |
| Storage full or unwritable | outcomes are not persisted | dedupe falls back to memory; the server key still prevents a duplicate side effect within the TTL |

### Rollback

Idempotency is additive: the client helpers and the `Idempotency-Key` header can be removed without a schema change, and the server keeps accepting plain `POST /api/affiliates/payouts`. To roll back a bad deploy:

Rollback is safe because the harness is additive too: reverting the client stops new keys from being sent, and the server key store is left in place until its TTL passes so an in-flight key cannot be replayed.

1. Revert the client to the previous build so new writes stop sending keys.
2. Leave the server key store in place until `IDEMPOTENCY_KEY_TTL_MS` has passed; dropping it early would allow a replay of an in-flight key.
3. Reconcile the payout queue against the affiliate ledger to catch any duplicate that slipped through during the rollback window.
4. On the client, clear `trellis:idempotency:` only if a corrupt record is suspected; otherwise let expiry remove it.

The concurrency harness is the regression gate for this document: any change to the store, the client, or the attempt helpers must keep `npm test -- idempotency.concurrency` green before deploy.

Run it locally with `npm test -- idempotency.concurrency` and in CI as a required check on any PR that touches `lib/idempotency.ts`, `apiClient`, or the payout flow. A red harness blocks merge; a flaky harness is treated as a real concurrency bug, not a test to skip.
