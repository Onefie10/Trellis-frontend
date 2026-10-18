# External dependency degradation matrix

The operational health endpoint exposes `dependencyFallbacks` as a redacted guidance list when one of the monitored providers is degraded or down. The operations dashboard displays a user-safe message, the fallback to preserve, and the recovery action. It does not pass through probe URLs or raw provider errors.

| Dependency | Failure signal | User-safe fallback | Recovery |
| --- | --- | --- | --- |
| Stellar Horizon | Timeout, HTTP 5xx, rate limit, or repeated failed probe | Label cached account data stale; pause new submissions until the selected network can confirm state. Never report a transaction as complete before ledger confirmation. | Check endpoint/network health, refresh account data, and confirm transactions by ledger result. |
| Soroban RPC | Timeout, HTTP 5xx, rate limit, or repeated failed probe | Keep cached reads visibly stale; block actions requiring fresh simulation; do not claim unconfirmed success. | Restore RPC health, refresh state, and simulate before enabling actions. |
| IPFS metadata | Gateway timeout, HTTP 5xx, or repeated failed probe | Reuse only previously verified cached metadata. Show unavailable for missing content and do not substitute unverified data. | Check the gateway and CID, then reload and re-verify metadata. |
| Marketplace search | Search status endpoint down or degraded | Keep the current page available and show search as temporarily limited. Do not present a provider error as zero results. | Check the service and index, then retry and refresh the result count. |

## Failure and rollback guidance

- Probe health is a service-level signal, not proof that a specific request succeeded. Critical reads and writes still need request-level validation.
- HTTP 429 and timeouts should honor bounded retry/backoff. Never automatically replay a payment or other non-idempotent write unless its idempotency contract is enforced.
- If status is unavailable, preserve the last confirmed value with a stale label or show an unavailable state. Do not silently replace it with a successful-looking empty result.
- When a provider recovers, refresh from the provider before removing stale labels or re-enabling actions. Reconcile uncertain transaction submissions by transaction hash before retrying.
- To roll back a fallback UI change, revert its display behavior while retaining health probes and logs. Do not clear user cache until fresh data has been verified.

The matrix is tested against the configured external probe targets so a new monitored dependency must receive an explicit safe fallback and recovery note.
