# Maintainer Action Approval Flow & Signed Intent Receipts

## Overview

High-impact maintainer actions (such as emergency circuit breaking, key rotations, large treasury disbursements, or irreversible retention purges) require explicit maintainer intent, cryptographic verification, offline durability, and full audit traceability.

This subsystem provides:
1. **Explicit Intent Formulation:** High-impact actions are formulated into structured intent payloads with required operational justification, target resource constraints, nonces, and bounded TTL expiration.
2. **Deterministic Canonical Fingerprinting:** Intent payloads are canonically serialized per RFC 8785 (JCS) and fingerprinted via 64-bit FNV-1a digests, preventing whitespace and object key permutation tampering.
3. **Cryptographically Signed Intent Receipts:** Intents are signed with Ed25519 (compatible with hardware/browser wallets or native keys) and mint immutable signed intent receipts.
4. **Offline Resilience & Background Sync:** Actions initiated while offline are safely queued locally in an offline store and replayed with conflict prevention when network connectivity is re-established.
5. **Post-Execution & Failure Review:** Execution outcomes (success with on-chain reference `externalTxRef`, failure with diagnostic reasons, or rollback compensation) are captured and reviewable on maintainer dashboards.
6. **Telemetry & Audit Logging:** Emits privacy-sanitized telemetry events (`maintainer_intent_approved`, `maintainer_action_completed`, `maintainer_action_failed`, `maintainer_action_rolled_back`) and logs every state change to an append-only audit trail.

---

## Action Impact Classification

| Action | Tier | Description |
|---|---|---|
| `emergency_pause` | Tier 3 (Critical) | Emergency halt of specific protocol operations or contract scopes |
| `emergency_resume` | Tier 3 (Critical) | Resuming paused operations after incident resolution |
| `rotate_signing_keys` | Tier 3 (Critical) | Modifying multi-sig thresholds or rotating signing keys |
| `treasury_disbursement`| Tier 2 (Sensitive) | Moving protocol treasury or grant funds |
| `escalate_role` | Tier 2 (Sensitive) | Escalating privileges of accounts or operators |
| `run_retention_cleanup`| Tier 2 (Sensitive) | Irreversible data cleanup / sanitization runs |
| `bulk_data_import` | Tier 1 (Standard) | Bulk data ingestion or agent model registration |

---

## Architecture & Workflow

```
Maintainer Action
       │
       ▼
[Validate Intent Schema & Justification] ──(invalid / short justification)──► Refuse
       │
       ▼
[Canonical Serialization (RFC 8785) & Fingerprint]
       │
       ▼
[Ed25519 Signature Verification & Replay Protection] ──(replay detected)──► Return Existing Receipt
       │
       ├──(isOffline: true)──► [Store in Offline Queue] ──(when online)──► [Sync Replay]
       │
       ▼
[Mint Signed Intent Receipt] (Status: 'approved')
       │
       ▼
[Execution via Network/Contract]
       ├── (Success) ──► Mark 'completed' + Store externalTxRef + Emit Telemetry
       ├── (Failure) ──► Mark 'failed' + Store diagnostic reason + Emit Telemetry
       └── (Rollback) ──► Mark 'rolled_back' + Append compensation audit log
```

---

## Operational Edge Cases & Failure Modes

1. **Replay Submissions:**
   - *Risk:* Double clicking, network retries, or duplicate submissions attempting to execute the same intent twice.
   - *Mitigation:* `approveAndSignIntent` checks canonical fingerprints. Identical intent payloads resolve to the existing receipt rather than minting duplicate actions.

2. **Expired Intents:**
   - *Risk:* Old approved intents being submitted or signed long after operational conditions changed.
   - *Mitigation:* Intents have an explicit `expiresAt` timestamp. Any intent approval attempted past expiration is rejected immediately.

3. **Offline Execution & Clock Skew:**
   - *Risk:* Operations drafted offline with unsynchronized system clocks.
   - *Mitigation:* Nonces and injectable clocks are used. Offline items are held in `queued_offline` state until validated by the host environment upon sync.

4. **Transient RPC or Network Timeouts:**
   - *Risk:* On-chain submission or contract call fails mid-execution.
   - *Mitigation:* Execution failures transition the receipt to `status: 'failed'` and durably persist `failureReason`, preventing silent drops and allowing maintainers to inspect and retry without data loss.

---

## Rollback & Recovery Steps

1. **Failed Action Review:**
   - Access the Maintainer Approval Review Dashboard (`/dashboard/maintainer-approvals`).
   - Filter by status `failed` to inspect the failure diagnostics and associated audit trail.

2. **Compensatory Rollback:**
   - For actions that partially executed or require reversal, maintainers can invoke `rollbackAction(receiptId, actor, reason)`.
   - This marks the receipt as `rolled_back`, attaches compensation details to the audit log, and emits `maintainer_action_rolled_back` telemetry.

3. **Emergency Circuit Breaker:**
   - In case of critical operational misbehavior, maintainers can immediately trigger an `emergency_pause` intent with Tier 3 classification to freeze the affected resource scope.
