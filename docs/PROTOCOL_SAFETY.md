# Protocol Safety: Config Versioning, Emergency Pause, Preflight & Receipts

Covers issues **#175, #176, #177, #178** — the four protocol-safety subsystems
that guard every high-risk Trellis operation. All modules live in `lib/protocol/`
and compose into one entry point (`executeGuardedOperation`).

```
request ─► #178 config compatibility ─► #177 pause gate ─► #175 preflight rules ─► abuse detection ─► #176 receipt ─► execute
              (incompatible? block)       (paused? block)    (blocked? refuse)    (score/step-up/review)  (created-or-replayed)
```

Refused operations never mint receipts and never reach transaction signing.

## Modules

| Module | Issue | Responsibility |
| --- | --- | --- |
| `lib/protocol/operations.ts` | — | Shared operation/environment vocabulary (`PROTOCOL_OPERATIONS`, `PROTOCOL_ENVIRONMENTS`) |
| `lib/protocol/config-versioning.ts` | #178 | Config registry, semver compatibility verdicts, fail-early validation |
| `lib/protocol/emergency-pause.ts` | #177 | Scoped pause/resume, boundary enforcement, audit trail |
| `lib/protocol/preflight.ts` | #175 | Deterministic rule checks → `success` / `warning` / `blocked` |
| `lib/protocol/abuse-detection.ts` | — | Risk-scored abuse detection, explainable signals, step-up & review quarantine |
| `lib/protocol/operation-receipts.ts` | #176 | Canonical request fingerprints, replay-safe receipts, permission-checked lookup |
| `lib/protocol/canonical.ts` | — | Stable serialization shared by fingerprints |
| `lib/protocol/guard.ts` | — | The composed chain above |
| `lib/protocol/index.ts` | — | Barrel export |

## #178 — Protocol configuration versioning

Configuration surfaces (`commission_tiers`, `claim_link_rules`,
`governance_thresholds`) are declared in `DEFAULT_PROTOCOL_CONFIG_REGISTRY`
with:

- `currentVersion` — what this build was written against
- `minSupportedVersion` — the exclusive floor; anything older is refused
- optional `deprecation` metadata and explicit per-version `compatibility` entries

`validateProtocolCompatibility(registry, versions)` is the gate every dependent
operation calls. Behaviour:

| Version class | Result |
| --- | --- |
| current | proceeds, no warnings |
| old but within the supported range | proceeds (+ `CONFIG_DEPRECATED` warning when deprecated) |
| old, below the floor | `ProtocolConfigIncompatibleError` with code `VERSION_TOO_OLD` |
| future / unknown | `ProtocolConfigIncompatibleError` with code `VERSION_UNKNOWN` |
| explicitly marked | `MIGRATION_REQUIRED` error |

**Adding or bumping a config surface:** edit
`DEFAULT_PROTOCOL_CONFIG_REGISTRY`, add the new version to the
`compatibility` map, and update `CLIENT_CONFIG_VERSIONS` if the shipped client
moves. Bump the matching entry in `CHANGELOG.md`.

## #177 — Emergency pause and scoped resume

`PauseManager` pauses one `operation × environment` scope, optionally narrowed
to one `subjectId` (a compromised wallet, a misbehaving agent). Rules:

- **Pause:** maintainers and admins; requires a non-empty reason; idempotent.
- **Enforce:** `assertOperationAllowed()` at the execution boundary (route
  handler / transaction composer) throws `OperationPausedError` carrying a
  user-safe message — the internal reason and pausing actor are never exposed.
  Unrelated operations, environments and subjects are unaffected.
- **Resume:** admins only. Unauthorized attempts are *refused and audited*
  (`resume_denied` entry); the pause stays in effect.
- **Audit:** every pause, resume and denied resume is recorded with actor,
  reason and timestamp in an append-only log.

## #175 — Deterministic preflight

`runPreflight()` evaluates pure rules in fixed order: always-on rules
(pause gate → config gate → sequence freshness) then per-operation rules
(balance coverage for transfers, allowance for payouts, fee sanity for mints).
The verdict folds to `blocked` > `warning` > `success`.

- Determinism: rules are pure, time is injected, no I/O — the same request and
  state snapshot always produce the same result and the same `requestId`.
- Warnings always carry a user-safe `message` **and** a `remediation` step.
- Warning-level results remain submittable by policy (`isSubmittable`);
  `blocked` results must never be signed or submitted.
- Stale-state detection blocks when `sequenceAtComposition` no longer matches
  `currentSequence`.

**Adding a rule:** write a pure `(request) => PreflightRuleResult` and add it to
`OPERATION_RULES` (or pass `extraRules` for deployment-specific checks).

## #176 — Operation receipts

`ReceiptService.createOrGet()` is the replay-safety boundary:

- The fingerprint is taken over the **canonical (RFC 8785-style) encoding** of
  `{ actorId, environment, operation, payload }` — key order can never change it.
- New signing or hashing call sites should include a versioned domain such as
  `trellis.payment.v1` with `domainSeparatedCanonicalJSONBytes()` (or
  `hashDomainSeparatedPayload()`). This prevents the same JSON body from being
  replayed as a valid payload in a different protocol context; keep existing
  receipt fingerprints unchanged for compatibility.
- The first submission creates the receipt (`status: 'received'`); any duplicate
  submission resolves to the existing receipt (`created: false`). A double-click
  or retried fetch cannot mint a second receipt.
- Transitions: `received → submitted (externalRef, e.g. tx hash) → confirmed`,
  or `failed` with a user-safe reason.
- Lookup (`lookupById/lookupByFingerprint` via `ReceiptService.lookup`) is
  permission-checked: owners read their own receipts; `maintainer`/`admin` may
  read any (support). Everyone else gets `ReceiptLookupDeniedError`.

## Risk-scored abuse detection for high-impact operations

`lib/protocol/abuse-detection.ts` evaluates high-risk operations before receipts are minted.
It produces explainable signals with weighted contributions, grades risk from 0 to 100,
and routes operations through progressive actions:

| Risk Score | Action | Behavior | User Impact |
| --- | --- | --- | --- |
| 0 – 39 | `allow` | Normal pass | Low-risk legitimate operations execute seamlessly without interference. |
| 40 – 69 | `step_up` | Step-up challenge | Requires second factor (hardware wallet, biometric signature, or MFA TOTP). A verified `stepUpProof` converts action to `allow`. |
| 70 – 89 | `review` | Quarantined | Suspicious cluster of signals held for asynchronous compliance/operator review; returns remediation instructions. |
| 90 – 100 | `block` | Immediate refusal | Malicious burst scripts or critical anomalies rejected immediately with audit log entry. |

### Explainable Risk Signals

- `HIGH_VELOCITY_BURST` / `BURST_VELOCITY_CRITICAL`: Excessive operation frequency within 1 hour.
- `MODERATE_FAILURE_RATE` / `HIGH_FAILURE_RATE`: Multiple consecutive failures within 15 minutes.
- `FRESH_ACCOUNT_SURGE`: Critical actions attempted by accounts created < 24 hours ago.
- `UNUSUAL_LARGE_VOLUME`: Payout or transfer values exceeding the high-volume threshold (`10,000 XLM`).
- `FIRST_TIME_BENEFICIARY`: High-value operations targeting unfamiliar destination accounts.
- `ANONYMIZED_NETWORK_ROUTE`: Operations routed via Tor, public proxies, or anonymizing VPNs.
- `ANOMALOUS_GEO_LOCATION`: Operation origin differing significantly from baseline history.
- `GOVERNANCE_PRIVILEGE_ELEVATION`: Sensitive governance updates attempted without admin credentials.

### Operational Edge Cases & Failure Modes

- **Clock Skew:** All evaluations accept an injectable clock (`now`) and calculate relative durations rather than absolute timestamps. Step-up tokens expire after 5 minutes TTL.
- **Flapping Network/VPN Providers:** When VPN detection is triggered alone (weight 20), risk score remains 20 (< 40), allowing legitimate privacy-conscious users to proceed without challenge. Step-up triggers only when compounded with other risk signals (velocity, unfamiliar recipient, etc.).
- **Telemetry Disconnection:** If telemetry WebSocket or subscribers fail or drop events, evaluations catch exceptions and continue so security gating is never bypassed by telemetry unavailability.

### Rollback & Recovery Steps

- **Runtime Bypass:** `options.bypassAbuseDetection = true` can be passed to `executeGuardedOperation` to instantly disable abuse evaluation if false positives arise during network outages or major promotional campaigns.
- **Threshold Tuning:** The `abuseConfig` parameter allows live overrides of `stepUpThreshold`, `reviewThreshold`, `blockThreshold`, and `burstVelocityLimitPerHour` without code redeployment.
- **Quarantine Resolution:** Quarantined items (`action: 'review'`) record canonical fingerprints, allowing operators to approve or reject items via maintainer dashboard or protocol CLI.

## Using the composed guard

```ts
import { executeGuardedOperation } from '@/lib/protocol';

const result = executeGuardedOperation(
  {
    operation: 'claim_payout',
    environment: 'production',
    actorId: wallet.publicKey,
    actor: { id: wallet.publicKey, role: 'contributor' },
    payload: { rewardId, amount },
    configVersions: { commission_tiers: '2.0.0' },
  },
  { configRegistry, pauseManager, receipts },
);
// result.receipt is created-or-replayed; PreflightBlockedError or AbuseRiskError means refused.
```

## Validation and tests

```bash
# Focused unit tests (protocol safety + abuse detection + guard)
npx jest tests/lib/protocol --coverage=false

# Standalone executable abuse detection verification
node scripts/test-abuse-detection.mjs

# Smoke-validate shipped configuration facts
node scripts/validate-protocol-safety.mjs
```

Test coverage map (acceptance criteria → tests):

| Acceptance criterion | Test |
| --- | --- |
| #178 current/old-compatible/old-incompatible/future-unknown | `tests/lib/protocol/config-versioning.test.ts` |
| #177 pause, resume, unauthorized resume, audit output | `tests/lib/protocol/emergency-pause.test.ts` |
| #175 success/warning/failed/stale-state, determinism | `tests/lib/protocol/preflight.test.ts` |
| #176 fingerprint stability, duplicates, lookup permissions | `tests/lib/protocol/operation-receipts.test.ts` |
| Abuse detection: explainable signals, step-up, review, blocking | `tests/lib/protocol/abuse-detection.test.ts`, `scripts/test-abuse-detection.mjs` |
| composed chain, abuse gating before receipt minting | `tests/lib/protocol/guard.test.ts` |

## Migration / deployment notes

- **No breaking API changes.** The modules are additive; nothing existing
  imports them yet, so no migration is required to land this.
- **Wiring:** to enforce at a boundary, construct the guard dependencies once
  per deployment (`PauseManager` backed by shared storage, `ReceiptService`
  backed by the API) and call `executeGuardedOperation` from route handlers
  before signing/submission. Until a server-side store is wired, both default
  to in-memory stores — suitable for development, not for multi-instance
  production enforcement.
- **Rollout:** ship with no pauses active and all current config versions;
  pauses are an operational lever, not a code path change.
