# Invariant Monitoring

Trellis moves real money to real people. When a record drifts — a payout marked
settled with no transaction behind it, an affiliate paid more than they ever
earned, an agent created by someone who was never allowed to create it — the
damage is silent until someone goes looking. This document describes the
monitor that makes that drift loud.

The monitor answers three questions on every run:

1. **Does each critical invariant still hold?** Pass or fail, for every
   registered invariant, always.
2. **Which records broke it?** Every failure names the record IDs it implicates.
3. **What is the safe next step?** Every failure carries remediation guidance.
   Nothing is auto-repaired.

The monitor is **read-only**. It never writes to the snapshot, the database, or
the chain. It reports; a human decides.

---

## Quick start

```bash
# Monitor the bundled healthy baseline (default snapshot)
npm run monitor:invariants

# Monitor a specific snapshot, as JSON
npm run monitor:invariants -- --file path/to/snapshot.json --json

# Treat warnings as failures too
npm run monitor:invariants -- --strict

# Narrow the run while investigating
npm run monitor:invariants -- --domain funds --only FUNDS-003

# See what is registered
npm run monitor:invariants -- --list
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | No invariant failed at or above the `--fail-on` threshold |
| `1`  | At least one invariant failed at or above the threshold |
| `2`  | Usage error, or the snapshot could not be read or parsed |

`2` is deliberately distinct from `1`. A missing snapshot is an operator
mistake; reporting it as data corruption would train maintainers to ignore the
monitor.

---

## Real-time webhook alerts

The monitor can dispatch outbound webhook alerts the moment a violation is
detected, so maintainers hear about a fund discrepancy or an unauthorized
ownership mutation without waiting for someone to read a log.

### Severity threshold rules

Alert routing is driven by the severity the invariant declares:

| Severity | Routing |
|----------|---------|
| `critical` | Immediate alert. Dispatched synchronously on detection. |
| `error` | Immediate alert, batched per run. |
| `warning` | Batched into the daily digest. Never paged. |

The threshold is configurable via `alertThreshold` in the dispatcher options.
The default is `error`, so `critical` and `error` violations alert immediately
while `warning` findings accumulate into the daily digest.

### Payload shape

Every alert payload carries the diagnostic context a maintainer needs to
triage without re-running the monitor:

- the invariant `id`, `title`, `severity`, and `domain`
- the `remediation` guidance for the invariant
- the affected record IDs, so the implicated rows can be located directly
- a `diff` block describing what was expected versus what was observed

Slack, Discord, and PagerDuty destinations are supported. Each destination
receives the same violation context, formatted for its own payload schema.

---

## The four invariant domains

| Domain | ID prefix | Question it answers |
|--------|-----------|---------------------|
| **Funds** | `FUNDS-*` | Did the right amount move, exactly once, provably? |
| **Ownership** | `OWN-*` | Do the records agree about who owns what? |
| **Lifecycle** | `LIFE-*` | Is each record in a legal state, with coherent timestamps? |
| **Authorization** | `AUTH-*` | Was the actor permitted to do that, and can it be audited? |

### Full registry

Run `npm run monitor:invariants -- --list` for the authoritative, always-current
list. The table below is the summary.

| ID | Severity | Invariant |
|----|----------|-----------|
| `FUNDS-001` | critical | Payout amounts are well-formed and strictly positive |
| `FUNDS-002` | critical | Completed payouts carry an on-chain settlement reference |
| `FUNDS-003` | critical | Completed payouts never exceed credited earnings |
| `FUNDS-004` | warning | Payouts meet the affiliate minimum threshold |
| `FUNDS-005` | error | Earnings ledger entries are finite and non-negative |
| `FUNDS-006` | critical | Settlement hashes are not replayed across payouts |
| `FUNDS-007` | error | Referral commission terms are within bounds |
| `OWN-001` | critical | Entity identifiers are present and unique |
| `OWN-002` | critical | Referral codes are present and unique |
| `OWN-003` | error | Referrals resolve to a registered referral code |
| `OWN-004` | critical | No wallet refers itself |
| `OWN-005` | critical | Wallet addresses are well-formed Stellar public keys |
| `OWN-006` | error | Provenance records resolve to a known agent |
| `OWN-007` | error | Test executions resolve to a known test case |
| `OWN-008` | critical | A referral code resolves to exactly one owner |
| `LIFE-001` | error | Status and priority enums hold recognized values |
| `LIFE-002` | error | Timestamps are parseable ISO-8601 values |
| `LIFE-003` | error | Execution intervals are correctly ordered |
| `LIFE-004` | error | Record updates never predate their creation |
| `LIFE-005` | error | Referral conversions happen after creation |
| `LIFE-006` | error | Settled payouts are timestamped after they were requested |
| `LIFE-007` | error | Referral conversion state and timestamp agree |
| `LIFE-008` | warning | Execution scores and resource metrics are in range |
| `AUTH-001` | error | Authorization records use recognized roles and actions |
| `AUTH-002` | critical | Privileged actions are admin-only |
| `AUTH-003` | error | Guest actors did not create agents |
| `AUTH-004` | critical | Fund transfers stay within the policy ceiling |
| `AUTH-005` | error | Role escalations were explicitly confirmed |
| `AUTH-006` | error | Actors do not impersonate themselves |
| `AUTH-007` | warning | Privileged actions are traceable to a provenance record |

---

## Severity model

| Severity | Meaning | Default effect |
|----------|---------|----------------|
| `critical` | Funds at risk, or authorization breached. Stop and escalate. | Fails the run |
| `error` | The record is corrupt or illegitimately recorded. | Fails the run |
| `warning` | Drift worth attention that is not itself a loss. | Reported only |

`--fail-on <severity>` moves the bar. The default is `error`; `--strict` is
shorthand for `--fail-on warning`. A finding always carries the severity its
invariant declares, so a `warning` invariant can never fail a run that has not
been told to fail on warnings.

### Remediation guidance

Every failure carries a `remediation` string, and the runner substitutes the
invariant-level guidance when a specific violation does not override it. That
substitution is enforced, not conventional: a failure with no next step cannot
be produced.

Guidance is deliberately conservative. It tells you what to reconcile and who to
escalate to, and it explicitly says **not** to edit the snapshot. A monitor that
suggests "fix this row" for a money-movement anomaly is a monitor that gets used
to paper over the anomaly.

---

## Dataset shape

A snapshot is a single JSON object. The first nine collections match
`DomainDataset` in `lib/domain-invariants.ts`, so an existing disaster-recovery
snapshot can be replayed through the monitor unchanged.

```jsonc
{
  "agents": [], "testCases": [], "testExecutions": [],
  "provenanceRecords": [], "referralCodes": [], "referrals": [],
  "payouts": [], "earningsLedger": [], "bugReports": [],

  // Added by the monitor: a persisted policy decision log.
  "authorizationEvents": [
    {
      "id": "authz-1",
      "actorId": "GAAZI...",
      "actorRole": "admin",              // admin | maintainer | user | guest
      "action": "transfer_funds",        // matches PolicyAction in lib/policy-engine.ts
      "resourceId": "pay-1",
      "resourceOwner": "GAAZI...",
      "confirmed": true,                 // required for escalate_role
      "amountStroops": "150000",         // checked against maxTransferAmount
      "provenanceId": "pv-2",            // makes the decision auditable
      "at": "2026-01-12T10:05:00.000Z"
    }
  ]
}
```

### Handling bad input

Snapshots are treated as **untrusted**. A monitor that crashes on malformed
input cannot report that the input is malformed.

- A missing collection, or one that is not an array, is treated as empty.
- Collection members that are not objects are dropped.
- A non-object payload (`null`, a number, a string) yields a report in which
  every invariant passes vacuously over zero records.
- Amounts are parsed strictly. `parseFloat` is **not** used, because
  `parseFloat("150.00 XLM")` returns `150` and would let a corrupt amount read
  as valid. `"150.00 XLM"` is a `FUNDS-001` finding.

A vacuous pass is always visible: `evaluatedRecords` is `0` for every result,
and `summary.entitiesScanned` reports `0` for every collection. An empty
snapshot is not a healthy snapshot, and the report should not let you confuse
the two.

---

## Wiring it into a pipeline

CI runs the monitor against the healthy baseline on every build:

```yaml
- name: Monitor domain invariants
  run: npm run monitor:invariants -- --fail-on error
```

To gate a deployment on a real snapshot, point `--file` at it and archive
`--json` output as a build artifact so a later run can be diffed against it.

To page maintainers on critical drift, configure a webhook destination and set
`alertThreshold` to `critical` so only fund and authorization breaches dispatch
immediately and everything else batches into the daily digest.

---

## Adding a new invariant

1. Pick the domain and the next free ID in its block. **IDs are permanent** —
   runbooks and dashboards reference them, so never reuse one.
2. Add the definition to the matching file in `lib/invariant-monitor/invariants/`.
3. Fill in every descriptive field. The registry throws at import time if
   `title`, `description`, or `remediation` is empty, so a stub cannot ship.
4. Add a case to the `Corrupted fixture detection` table in
   `tests/__tests__/invariant-monitor.test.ts`, and a focused
   `Injected defect detection` test that mutates the healthy baseline.
5. Add the row to the registry table above.
6. Run `npm run monitor:invariants` — the healthy baseline must still pass.

The registry self-checks on load: duplicate IDs, an ID whose prefix disagrees
with its domain, and empty guidance all raise immediately rather than producing
a subtly wrong report.

### What an invariant definition looks like

```ts
export const someInvariant: InvariantDefinition = {
  id: 'FUNDS-010',
  domain: 'funds',
  title: 'Short human-readable name',
  description: 'What is checked, precisely.',
  rationale: 'Why breaking this harms Trellis.',
  severity: 'critical',
  remediation: 'What a maintainer should actually do about it.',
  evaluate(dataset) {
    const violations = [];
    // ...push violation(...) for each failure
    return { evaluatedRecords: dataset.payouts.length, violations };
  },
};
```

`evaluate` receives an untrusted dataset. Use the readers in
`lib/invariant-monitor/internal/helpers.ts` (`readString`, `readNumber`,
`readId`, `readTimestamp`, `parseAmount`, `parseStroops`) rather than reaching
into records directly — they return `null` instead of throwing, which is what
keeps a run alive long enough to report the damage.

---

## Relationship to the disaster-recovery validator

The two tools overlap deliberately and are both kept.

| | `validate:invariants` | `monitor:invariants` |
|---|---|---|
| Purpose | Validate a restore before cutting over | Continuous drift detection |
| Module | `scripts/validate-domain-invariants.mjs` | `lib/invariant-monitor/` |
| Output | Violations plus aggregate counts | Pass/fail per invariant, plus violations |
| Runs in CI | No | Yes |

They share constants — `STELLAR_ADDRESS_RE` and `MINIMUM_PAYOUT_XLM` both come
from `lib/affiliate-store.ts`, and the authorization vocabulary mirrors
`lib/policy-engine.ts` — so the two cannot drift into disagreeing about what
"valid" means. Use the disaster-recovery validator before a restore; use the
monitor continuously, and in CI.

---

## Troubleshooting

**`Exit code 2`, "Snapshot not found."** The `--file` path is wrong relative to
the repository root. Omit `--file` to use the bundled baseline.

**Every invariant passes on a dataset you expected to be broken.** Check
`Records scanned` in the report. Zero records across the board means the
snapshot failed to normalize, not that the data is clean.

**`FUNDS-004` warnings on every payout.** The affiliate minimum is 100 XLM
(`AFFILIATE_PROGRAM_CONFIG.minimumPayout`). Payouts below it are reported as
drift by design.

**`AUTH-004` firing on legitimate payouts.** `maxTransferAmount` in
`lib/policy-engine.ts` is expressed in stroops and defaults to `1000000` — 1
XLM. That is far below the 100 XLM affiliate minimum payout, so no real
affiliate payout can satisfy it. The invariant is reporting the policy, not the
payout. Resolve the policy question separately; do not edit the snapshot.

**No webhook alert fired for a critical violation.** Check that a destination
is configured and that `alertThreshold` is at or below the violation's
severity. A `critical` breach with the threshold set to `critical` dispatches
immediately; a `warning` never pages regardless of threshold.

---

## Related documents

- [`docs/DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md) — restore-time validation
- [`docs/domain-integrity.md`](./domain-integrity.md) — integrity rules
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contribution workflow
