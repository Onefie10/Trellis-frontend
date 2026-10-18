# Trellis Frontend Disaster Recovery & Domain Invariant Validation

This document establishes the recovery verification standards and escalation workflows for Trellis Frontend domain state following a database restore, disaster recovery drill, snapshot migration, or indexer sync.

---

## 🎯 Purpose & Scope

When restoring state from backups or migrating across persistent storage layers, data corruptions can occur:
- Foreign keys broken by partial restores (e.g. orphaned test executions).
- Identity collisions from parallel imports (duplicate primary keys or referral codes).
- Ledger and settlement reference drift (completed payouts missing blockchain transaction hashes or payouts exceeding earned reserves).
- Timestamp regressions or invalid enum values.

The **Domain Invariant Validator** provides a standardized, **strictly read-only** check that certifies domain integrity before traffic is directed to the restored environment.

---

## 🚀 Running the Invariant Validation

### Standard Verification (Local / Baseline Fixtures)

```bash
npm run validate:invariants
# or alias:
npm run dr:validate
```

## Resource Budget Checks

Run the deterministic worst-case user activity, ledger history, and catalog search
workloads before promoting changes that affect dashboard data processing:

```bash
npm run test:resource-budgets
```

The limits are versioned in `scripts/resource-budgets.json`. The check reports
elapsed time and JavaScript heap growth for each generated workload, and exits
nonzero if a record, result, time, or heap budget is exceeded. These synthetic
checks catch local processing regressions; they do not replace production
profiling or measure network and database costs.

If a budget fails, first rerun it on the same Node version and machine to confirm
the result. Use a heap or CPU profile to identify the workload's allocation or
hot loop, then reduce retained data, bound pagination/results, or avoid repeated
scans. Keep the workload size fixed while comparing before and after results.
Change a budget only when measured product capacity justifies the new limit, and
record the capacity rationale alongside the change. Do not increase a limit only
to make a failing check pass. If the check fails in CI but passes locally, compare
Node versions and runner memory limits before adjusting application code.

### Validating a Restored Database Snapshot / Dump

When restoring from an external JSON dump or database export:

```bash
npm run validate:invariants -- --file /path/to/restored-dataset.json
```

### Automated CI / CD Pipelines & Monitoring

```bash
# Output structured machine-readable JSON for monitoring pipelines
npm run validate:invariants -- --json --file /var/data/restore.json

# Enforce zero warnings and zero errors (exit code 1 on warning)
npm run validate:invariants -- --strict --file /var/data/restore.json
```

---

## 📋 Core Domain Invariants Matrix

| Category | Invariant Code | Severity | Description |
|---|---|---|---|
| **Uniqueness** | `DUPLICATE_ID` | `ERROR` | Primary key or referral code exists more than once in the dataset. |
| **Relational Integrity** | `ORPHANED_RECORD` | `ERROR` | A dependent record references a parent that does not exist (e.g., `TestExecution.testCaseId` pointing to missing `TestCase`). |
| **Relational Integrity** | `SELF_REFERRAL_VIOLATION` | `ERROR` | A referral record references the referrer's own wallet address as the beneficiary. |
| **Settlement & Financial** | `INVALID_STELLAR_ADDRESS` | `ERROR` | A payout or settlement wallet address does not conform to valid Stellar public key format (`^G[A-Z2-7]{55}$`). |
| **Settlement & Financial** | `SETTLEMENT_REFERENCE_MISSING` | `ERROR` | A completed payout or on-chain provenance action is missing its transaction hash (`txHash`). |
| **Settlement & Financial** | `FINANCIAL_BALANCE_VIOLATION` | `ERROR` | Cumulative completed payouts for a wallet exceed cumulative credited earnings, or a payout is below `MINIMUM_PAYOUT_XLM`. |
| **Schema & Enums** | `INVALID_STATUS_ENUM` | `ERROR` | An entity status is not one of the allowed domain lifecycle states. |
| **Schema & Enums** | `INVALID_NUMERIC_METRIC` | `ERROR` | Quality scores out of range `[0, 100]` or negative resource metrics (CPU, RAM, ledger I/O). |
| **Chronology** | `TIMESTAMP_CHRONOLOGY_VIOLATION` | `ERROR` | Time regression: `endTime` precedes `startTime`, or `updatedAt` is earlier than `createdAt`. |
| **Chronology** | `INVALID_TIMESTAMP_FORMAT` | `ERROR` | Malformed date string that cannot be parsed as valid ISO-8601. |

---

## 🔍 How to Interpret Validation Reports

Output is categorized into clear sections:
1. **Entities Scanned**: Counts for each domain model (`agents`, `testCases`, `testExecutions`, `provenanceRecords`, `referralCodes`, `referrals`, `payouts`, `bugReports`).
2. **Status Badges**:
   - `[PASS]`: Invariant certified.
   - `[WARN]`: Potential risk that does not breach referential integrity (e.g. payout below minimum threshold pending batch settlement).
   - `[ERROR]`: Hard invariant violation. **Blocks cutover and go-live**.
3. **Remediation Note**: Direct actionable instructions to repair the affected record.

---

## 🛠️ Escalation & Remediation Workflow

When a disaster recovery validation check fails, maintainers must adhere to the following escalation paths:

### 1. Orphaned Records (`ORPHANED_RECORD`)
- **Root Cause**: Incomplete backup restore where child tables were restored ahead of parent tables, or partial data purging.
- **Escalation Step**:
  1. Check backup timestamp of parent entity table (`TestCase`, `Agent`, `ReferralCode`).
  2. If parent record exists in a newer or alternate partition, re-import parent record.
  3. If parent record was legitimately permanently deleted, isolate and quarantine orphaned executions before re-running validator.

### 2. Settlement & Balance Drift (`SETTLEMENT_REFERENCE_MISSING`, `FINANCIAL_BALANCE_VIOLATION`)
- **Root Cause**: Indexer lag during backup, unconfirmed transactions included as completed, or ledger double-counting.
- **Escalation Step**:
  1. Query the Stellar Horizon RPC endpoint (`https://horizon-testnet.stellar.org` or mainnet) for the affected wallet account.
  2. Cross-reference account transaction history with unlinked payout records.
  3. Reconcile transaction hash into payout record or reset status from `completed` to `processing` until on-chain confirmation is indexed.
  4. Temporarily freeze payout dispatch for affected affiliate wallets pending manual balance audit.

### 3. Identity Collisions (`DUPLICATE_ID`)
- **Root Cause**: Multiple restore dumps merged without primary key de-duplication.
- **Escalation Step**:
  1. Inspect duplicate records using the primary key printed in the validator output.
  2. Compare `updatedAt` timestamps and retain the most recent authoritative record.
  3. Archive duplicate historical versions in audit log.

### 4. Chronology & Timestamp Inversions (`TIMESTAMP_CHRONOLOGY_VIOLATION`)
- **Root Cause**: Clock drift between server nodes during benchmark execution or manual DB edits.
- **Escalation Step**:
  1. Validate NTP synchronization across nodes.
  2. Set `endTime = startTime + durationMs` where duration was recorded in execution telemetry.

---

## 🛡️ Read-Only & Non-Mutating Guarantees

- The validator opens datasets in **read-only** mode.
- No writes, updates, deletions, or schema changes are ever issued to databases or files.
- The command can be safely re-run repeatedly in production staging environments before releasing maintenance mode locks.
