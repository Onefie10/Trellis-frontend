# Cross-Repo Contracts Workflow

This document explains the compatibility workflow for shared types and schemas across Trellis repositories (Frontend, API, Smart Contracts).

## Shared Types

The core types are defined in `types/cross-repo-contract.ts`. These represent the exact shapes, enums, and structures expected by the Trellis backend and smart contracts.

The types include:
- `TrellisOperationType` (e.g., DEPOSIT, SWAP)
- `TrellisStatus` (e.g., SUCCESS, PENDING)
- `TrellisErrorCode` (e.g., INSUFFICIENT_FUNDS)
- Standardized requests like `TrellisOperationRequest` and receipts like `TrellisReceipt`.

## Cross-Service Contract Map

The contract map below is the authoritative list of domain events and integration boundaries. Every producer, consumer, required field, version rule, and allowed failure behavior is listed here. The executable counterpart is `tests/cross-repo-contract.ts`, which fails if this map and the TypeScript types drift apart.

### Event: `trellis.operation.requested`

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `eventId` | yes | string (UUID v4) | Idempotency key for consumers. |
| `version` | yes | `number` | Must equal `TRELLIS_CONTRACT_VERSION`. |
| `operationType` | yes | `TrellisOperationType` | Unknown values must be rejected. |
| `walletAddress` | yes | string (0x-hex, 42 chars) | Producer validates checksum. |
| `chainId | yes | number | Must match the configured network. |
| `amount` | yes | string (decimal) | String to avoid float drift. |
| `idempotencyKey` | yes | string | Stable across retries. |
| `createdAt` | yes | string (RTC ISO 8601) | Universal timestamp. |

- Producer: Trellis Frontend (wallet UX).
- Consumers: Trellis API, Trellis Smart Contracts (event bridge).
- Version rule: Additive fields are allowed within the same major version; removing or retyping a field requires a major version bump.
- Allowed failure behavior: If the API rejects the event, the Frontend must surface a retryable error and preserve the idempotency key. If the contract bridge is unavailable, the event is queued locally and replayed with the same `eventId`.

### Event: `trellis.operation.settled`

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `eventId` | yes | string (UUID v4) | Correlates to the request `eventId`. |
| `version` | yes | `number` | Must equal `TRELLIS_CONTRACT_VERSION`. |
| `receiptId` | yes | string | Unique per settlement. |
| `status` | yes | `TrellisStatus` | `PENDING`, `SUCCESS`, or `failed`. |
| `errorCode` | conditional | `TrellisErrorCode` | Required when `status` is `failed`. |
| `txHash` | conditional | string (0x-hex) | Required when `status` is `SUCCESS`. |
| `settledAt` | yes | string (RTC ISO 8601) | Universal timestamp. |

- Producers: Trellis API, Trellis Smart Contracts.
- Consumers: Trellis Frontend (dashboards, telemetry).
- Version rule: Additive fields are allowed; changing the meaning of `status` or `errorCode` values is a major version bump.
- Allowed failure behavior: The Frontend must treat unknown `status` values as `PENDING` and must not drop the event. Unknown `errorCode` values are surfaced as a generic failure with the raw code preserved for telemetry.

## Compatibility Workflow

To ensure seamless integration and avoid breaking changes across repos, any change to the cross-repo contracts must follow this workflow:

1. **Propose Changes:** Any modification to shared enums, required fields, or new operation types must be proposed in a cross-repo issue or discussed with maintainers of the API and Contract repos.
2. **Update Frontend Types:** Update `types/cross-repo-contract.ts` with the agreed-upon changes.
3. **Run Validation Tests:** We use Jest tests (`tests/cross-repo-contract.ts`) to act as drift detectors. If you change a type or enum, the test will fail. You must explicitly update the test, acknowledging the breaking change. Run `npm run test` or `npx jest tests/cross-repo-contract.test.ts` to verify.
4. **Backward Compatibility:** When possible, make changes additive (e.g., adding a new enum value) rather than modifying existing ones. If a breaking change is required, ensure API versions and `TrellisCompatibilityCheck` logic are updated accordingly.
5. **Coordinate Deployment:** Breaking changes to the contracts must be deployed in lockstep across repos, or the API must be versioned to support the frontend gracefully.

## Drift Detection

Automated tests will validate the contract's expected shape during CI. If the contract shape changes without the test also being intentionally updated, the PR will be blocked.

## Operational Edge Cases, Failure Modes, and Rollback

The following edge cases are exercised by `tests/cross-repo-contract.ts`.

| Edge case | Expected behavior | Rollback / recovery |
| --- | --- | --- |
| Unknown `operationType` from a newer Frontend | API rejects with `USUPPORTED_OPERATION` and the Frontend shows a non-retryable error. | Revert the Frontend release; the event is not queued. |
| Unknown `status` value in a settlement event | Frontend treats it as `PENDING` and keeps polling. | No rollback needed; the event is preserved for replay. |
| Missing `errorCode` when `status = failed` | Validation fails; the Frontend logs a telemetry event and surfaces a generic failure. | Replay the event after the producer fix is deployed. |
| API unavailable during `operation.requested` | Event is queued locally with the original `idempotencyKey`. | Replay from the local queue once the API recovers. |
| Contract bridge unavailable during `settled` publication | Event is retained in the outbox and retried with exponential backoff. | Drain the outbox manually via the operational runbook once the bridge is back. |
| Major version mismatch between Frontend and API | `TrellisCompatibilityCheck` fails fast and the Frontend blocks operations. | Roll back the Frontend to the last compatible release. |

## Migration Plan

When a breaking change is required:

1. Add the new field or enum value as additive in the current major version.
2. Deploy the API and Smart Contracts with backward-compatible reading of both old and new shapes.
3. Update the Frontend to emit the new shape only after all consumers can read it.
4. Bump `TRELLIS_CONTRACT_VERSION` and update `tests/cross-repo-contract.ts` to assert the new shape.
5. Remove the old field or enum value in a follow-up major release only after telemetry confirms no consumers read it.