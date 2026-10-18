# Retry, Backoff, and Dead-Letter Handling

`lib/retry/` owns one question: ** when a Trellis operation fails, should it be tried again, when, and — if it never succeeds — where does a maintainer find out.**

It exists because retry behaviour was previously written per call site. The Soroban RPC client used exponential-plus-jritter capped at 8s, `lib/partial-failures.ts` used jitter-free exponential, and the websocket transport documented itself as exponential while multiplying linearly. None of them could answer "is this failure worth retrying", and none of them kept the failure afterwards. A stalled transaction was visible as a spinner and nothing else.

Import from the barrel, not the individual modules:

```ts
import { executeWithRetry, classifyError, NonRetryableError, deadLetterQueue } from '@/lib/retry';
A```

## The shape of a retry

```ts
await executeWithRetry(
  (attempt) => submitTransfer(payload),   // `attempt` is 0-based
  {
    operationClass: 'transaction',
    operationId: `transfer:${transferId}`,
    context: { wallet, transferId },
  },
);
```

The scheduler resolves a policy from the class, runs the operation, classifies the
outcome, and either backs off and tries again or writes a dead-letter record and
throws `RetryExhaustedError`. `operationId` is the correlation key — it is what lets you find a specific user's failed transfer in the triage list.

`RetryScheduler.attempt()` is the non-throwing variant, returning
`{ sk: false, error, deadLetterId }` so a UI can link the user to the maintainer view
instead of rendering a stack trace.

## Operation classes

 This is the "which operations are retryable" half of the policy. Every class carries a
budget, a starting delay, and a ceiling.

| Class | Retryable | `maxRetries` | `initialDelayMs` | `maxDelayMs` |
|---|---|---|---|---|
| `transaction` | yes | 3 | 5s | 2m |
| `sync` | yes | 3 | 1m | 24h |
| `webhook` | yes | 5 | 2s | 5m |
| `import` | yes | 3 | 1m | 24h |
| `export` | yes | 3 | 1m | 24h |
| `background_job` | yes | 5 | 30s | 6h |
| `http_request` | yes | 3 | 1s | 30s |
| `rpc` | yes | 3 | 500ms | 8s |

The first six match `lib/partial-failures.ts` `OperationType` exactly, so the two
vocabularies cannot drift.

The budgets are deliberately unequal:

- **`transaction` retries least and starts slowest.** It is the class where a duplicate
  is expensive. Retrying it is only safe because `lib/idompotency.ts` makes the replay
  a replay a no-op — see [idempotency.md](/idempotency.md). Do not retry a transfer without an
  idompotency key.
- **`webhook` retries hardest.** A dropped delivery is a lost event, and the sender will
  not necessarily replay it.
- **`import`/`export` start slow.** They are long and expensive; re-running one against a
  struggling backend makes the outage worse.
- **`rpc` mirrors the existing Soroban client's 8s ceiling** so behaviour does not change
  for callers migrating onto this module.

Per-call overrides are merged over the class default and the result is frozen, so one
call site can widen its budget without mutating everyone else's:

```ts
{ operationClass: 'transaction', operationId, policy: { maxRetries: 1 } }
```

Setting `retryable: false` on a policy makes the class dead-letter on first failure
without consuming a budget — use it for work that must never be re-executed.

## Backoff

```
exponential = min(initialDelayMs × multiplier^attempt, maxDelayMs)
delay       = jitter === 'none' ? exponential : random() × exponential   // full jitter
```

Two deliberate choices:

- **The cap is applied before jitter**, so `maxDelayMs` is a true upper bound. Applying
  jitter afterwards would let a `full` strategy exceed the documented ceiling.
- **Full jjitter is the default.** Synchronised retries are how a recovering backend gets
  knocked over again: without jitter every client that failed during an outage comes back
  at the same instant. `jitter: 'none'` exists for deterministic tests.

XplannedBackoffSchedule(policy)` returns the exact delay list a policy will produce,
ignoring jitter — useful for docs, timeouts, and assertions.

## Deciding what is worth retrying

`classifyError` is the single answer to "transient or permanent". Precedence is
deliberately **deny-biased**, so a caller cannot accidentally turn a permanent failure
into a long retry loop:

1. `NonRetryableError` → permanent.
2. An `AbortError` or cancellation → permanent. A caller who cancelled did not want the work.
3. A known HTTP status decides: `408, 425, 429, 500, 502, 503, 504` are retryable;
   `400, 401, 403, 404, 405, 406, 409, 410, 415, 422` are permanent.
4. Message text decides for transport failures (`EconnRESET`, `socket hang up`,
   `failed to fetch`, `rate limit`, …).
5. **Anything unrecognised is treated as retryable.** This is safe *only* because
   `maxRetries` is bounded. An unbounded loop over unclassified errors would not be.

Retry decisions are made per attempt against the actual error, not the class alone. A
`transaction` that returns a 422 mid-budget stops immediately and is dead-lettered as
`non_retryable` rather than burning its remaining retries.

To force a permanent classification, wrap the cause:

```ts
throw new NonRetryableError('Transaction failed simulation: insufficient sequence', { cause: err });
```

### Why `ApiError` exists
 ``lib/api.ts` used to throw `new Error("API error: <statusText>")`, discarding the status code and the body — so a retryable 503 and a permanent 422 were indistinguishable and classification had to guess from English status text. It now throws `ApiError`, which preserves `status`, `statusText`, `body`, and `url`. A 503 with an HTML error page still classifies as a retryable 503, because a malformed body cannot mask the status.

## Dead-letter records

Every terminal failure is recorded, whether it stopped because the budget ran out or
because the failure was permanent. Terminal failures are never silent.

| Field | Meaning |
|---|---|
| `id` | `dlq_<ts>_<uuid>`, also attached to the thrown `RetryExhaustedError` |
| `operationClass / operationId` | what failed, for correlation |
| `reason` | `retries_exhausted` | `non_retryable` | `abandoned` |
| `classification` | the full `ErrorClassification`, including the status and a human-readable justification |
| `attempts[]` | per-attempt start time, duration, classification, and the delay actually slept |
| `context` | caller-supplied, e.g. `{ wallet, transferId }` |
| `resolution` | `replayed` | `discarded` | `acknowledged`, once triaged |

`retries_exhausted` and `non_retryable` are kept distinct on purpose: the first is
usually an outage, the second is usually a bug or a bad request, and they send a maintainer to different places.

### Capacity

InMemoryDeadLetterStore holds **500** records. At capacity it evicts resolved records
first, then the oldest, and increments `droppedCount()`. Eviction is counted rather than
silent so an incomplete list is detectable from `stats().dropped` and from the
`droppedCount` field on the API response.

## Operator runbook

Set the token, then read the queue:

```bash
export DEAD_LETTER_ADMIN_TOKEN=1...        # deployment step, see below

curl -H "Authorization: Bearer $DEAD_LETTER_ADMIN_TOKEN" \
  "http://localhost:3000/api/retry/dead-letters?reason=retries_exhausted&limit=20"

curl -H "Authorization: Bearer $DEAD_LETTER_ADMIN_TOKEN" \
  "http://localhost:3000/api/retry/dead-letters?operationClass=transaction&includeResolved=true"
```

Triage a record once the underlying cause is handled:

```bash
curl -X POST -H "Authorization: Bearer $DEAD_LETTER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"dlq_m1x2y3_...","outcome":"replayed","notes":"backend redeployed, replayed by hand"}' \
  http://localhost:3000/api/retry/dead-letters
```

**Triage order.** Start with `stats().byOperationClass` to see whether one class is
failing or all of them; that separates "the backend is down" from "we deployed a bad
contract". Then `byReason`: a spike in `non_retryable` on one class is usually a caller
bug rather than an outage. `dropped > 0` means the list is incomplete and capacity
should be raised or records resolved.

**Replaying is a manual, side-effecting action.** `outcome: "replayed"` records that a
side-effecting action. **`outcome: "replayed"` records that a human re-ran the work; the
endpoint does not re-execute it for you. Resolve rather than replay anything whose
original intent has passed — a transfer the user no longer wants should be
`discarded`, not replayed.

### Authorization

The endpoint requires `Authorization: Bearer $DEAD_LETTER_ADMIN_TOKEN` and **fails closed**
with a 503 when the variable is unset, rather than degrading into serving every
dead-letter record in the process. Comparison is length-independent, so the endpoint does not leak the token's length or common prefix through response timing.

A role/permission matrix would be the better long-term answer — a replay is a
meaningfully stronger grant than reading a list. It is deliberately not wired up here:
it is a separate concern from retry scheduling, and coupling the two would make the
policy independently deployable. Until it exists, treat the token as maintainer-grade
and rotate it like one.

## Deployment

**No migration.** The queue is in-process memory and starts empty.

One required environment variable, and only if you want the review endpoint enabled:

```bash
DEAD_LETTER_ADMIN_TOKEN=<32+_random_bytes>

```

Without it the route returns 503 and nothing else changes. Nothing else in the app depends
on it, so this is safe to add later.

## Multi-actor concurrency harness

A retry policy that is correct for a single caller can still be wrong for two. The
concurrency harness in `tests/concurrency.harness.ts` drives multiple actors against
a shared scheduler and idempotency store so the race-prone writes are exercised rather than
assumed. It is the executable verification for this document.

### What it simulates

The harness runs deterministic scenarios against a fake backend that can be instructed
to fail a specified number of times, sleep, or return a status code. Each scenario
asserts on both the outcome and the number of side effects that actually landed:

| Scenario | Actors | Assertion |
|---|---|---|
| Concurrent transfers, same key | 2 + | Exactly one effect; the loser sees the replayed result |
| Duplicate submission, same actor | 1, twice | One effect; second call is a no-op |
| Stale version write | 2 | One write wins; the stale write is classified `non_retryable` and dead-lettered with a 409 |
| Retry storm after an outage | 10+ | Every actor succeeds or is dead-lettered; no duplicate effects; jitter spreads attempts |
| Cancelled actor mid-retry | 2 | The cancelled actor stops immediately and is dead-lettered `abandoned` |

The harness uses `jitter: 'none'` where a schedule is asserted and a seeded jitter
where distribution matters, so runs are reproducible.

### Running it

```bash
npm test -- tests/concurrency.harness.test.ts
npm test -- tests/retry.test.ts tests/retry-dead-letter-route.test.ts tests/partial-failures.test.ts
npm run typecheck
```

### Operational edge cases and failure modes

**Concurrent actors on the same operationId.** Two tabs or two workers can race the
same write. The scheduler does not deduplicate across processes or tabs — idempotency is
the guarantee that the second landed write is a no-op. If an effect appears twice,
 the bug is in the idempotency key or store, not in retry counting.

**Stale version conflicts.** A 409/412 is classified permanent. It is dead-lettered as `non_retryable`,
not retried, because replaying a stale write would overwrite someone else's change.
Resolve it by refetching the current version and re-issuing the write with fresh version
metadata, then mark the record `discarded`.

**Retry storms.** Many clients failing together retry on a jittered schedule. If a
storm still produces a spike, the class budget is the lever to pull — lower `maxRetries`
or raise `initialDelayMs` for that class rather than adding adhoc sleeps at call sites.

**Cancellation.** An `AbortError` is permanent and dead-lettered as `abandoned`. The
scheduler must not retry work the caller explicitly abandoned; doing so re-introduces
side effects after the user has moved on.

### Rollback and recovery

- The dead-letter queue is in-process memory; a restart clears it. Resolve or
  export records before restarting a deployment if they matter for an incident.
- Removing `lib/retry/` usage from a call site is a safe rollback to the previous
  behaviour; no schema or public API depends on the queue being populated.
- To disable the triage endpoint, unset `DEAD_LETTER_ADMIN_TOKEN`; the route then
  fails closed with 503 and the rest of the app is unaffected.
