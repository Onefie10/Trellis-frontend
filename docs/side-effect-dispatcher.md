# Idempotent Side-Effect Dispatcher & Dead-Letter Recovery

The `SideEffectDispatcher` (`lib/side-effects`) provides a unified, production-grade mutation pipeline for client-side actions (Stellar transactions, wallet interactions, API mutations, and background synchronization).

## Architecture

```
User Action (Wallet / API / Offline Replay)
                   │
                   ▼
       [SideEffectDispatcher.dispatch]
                   │
    ┌──────────────┴──────────────┐
    ▼                             ▼
[Idempotency Check]       [Duplicate In-Flight Promise Guard]
 ├─ Succeeded: Return cached  ├─ Same tab: share promise
 ├─ Conflict: 409 Conflict    └─ Cross-tab: Lock / InProgressError
 ├─ Expired: 400 Expired
 └─ Fresh/Retry: Proceed
                   │
                   ▼
       [Bounded Retry Loop (lib/retry)]
 ├─ Exponential jittered backoff
 ├─ Error classification (transient vs permanent)
 ├─ Telemetry event stream
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
    [Success]          [Terminal Failure]
 ├─ Persist result    ├─ Persist failure record
 ├─ Resolve DLQ item  ├─ Enqueue to Dead-Letter Queue
 └─ Emit telemetry    └─ Emit telemetry & alert
```

## Key Capabilities

1. **Deterministic Idempotency Keying**:
   Operations are keyed uniquely. Retrying a successful operation returns the stored result immediately without repeating user-visible network calls or blockchain transactions.
2. **Concurrent Guarding**:
   In-flight requests within the same browser tab share the running promise. Cross-tab writes enforce a mutual exclusion lock with stale recovery (default 30s) so abandoned attempts from closed tabs are gracefully reclaimed.
3. **Classified Bounded Retries**:
   Retries leverage `lib/retry` policy classification. Permanent client errors (e.g., 400, 422, invalid signature) fail immediately without retrying, while transient errors (network loss, 503, RPC timeouts) retry with jittered exponential backoff.
4. **Dead-Letter Recovery (DLQ)**:
   Exhausted or terminal failures are captured into `SideEffectDeadLetterQueue` (`trellis.side-effects.dlq.v1`), bounded at 250 entries with eviction prioritizing resolved entries.
5. **Dashboard Inspection & Replay**:
   Operators can inspect full request payloads and failure attempt history from `/dashboard/operations` via `<SideEffectDeadLetterPanel />`, replaying actions cleanly or discarding unrecoverable actions.
6. **Telemetry & Observability**:
   Emits structured events:
   - `side_effect_queued`
   - `side_effect_started`
   - `side_effect_cached_hit`
   - `side_effect_retry`
   - `side_effect_succeeded`
   - `side_effect_dead_lettered`
   - `side_effect_recovered`

## Operational Edge Cases & Failure Modes

- **Storage Exhaustion / Quota Exceeded**:
  When `localStorage` is full or disabled (private browsing mode), the DLQ and idempotency store automatically fall back to memory-backed storage without throwing, ensuring mutations complete safely.
- **Cross-Tab Stale Abandonment**:
  If a tab crashes or closes mid-mutation, the lock becomes stale after 30 seconds (`DEFAULT_STALE_LOCK_MS`). Subsequent tabs detect this and safely re-run the mutation.
- **Conflicting Payloads**:
  Submitting the same idempotency key with a modified payload throws `IdempotencyConflictError` (HTTP 409), preventing state divergence.
- **Replay Safety**:
  When an operator triggers **Replay** in the operations dashboard, the dispatcher resets the failure state and re-dispatches using the original verified payload and key. If the replay succeeds, the dead-letter entry is marked resolved.

## Rollback & Recovery Steps

- **Rollback**:
  The side-effect dispatcher does not require database or server-side schema migrations. Reverting client code leaves existing keys intact.
- **Queue Cleanup**:
  To clear all dead-letter entries from the browser console or emergency support script:
  ```js
  localStorage.removeItem('trellis.side-effects.dlq.v1');
  ```
  Or invoke the dashboard **Clear all DLQ** button.
