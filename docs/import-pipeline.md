# Trellis Bulk Import Pipeline Guide

## Overview
The Trellis Bulk Import Pipeline provides safe, idempotent ingestion of datasets (Agents, Test Cases, Provenance records, Submissions) with dry-run validation, duplicate detection, and automated rollback guidance.

---

## Key Features

1. **Dry-Run Validation (`dryRun: true`)**:
   - Evaluates input rows without applying persistent storage mutations.
   - Outputs summary statistics: `createCount`, `updateCount`, `skipCount`, `errorCount`, `duplicateCount`.

2. **Idempotency & Deduplication**:
   - Matches records on external identifier (`id` or custom key).
   - In-batch duplicate detection flags duplicate keys within the same payload.
   - Repeated imports with existing keys update or skip safely rather than creating duplicate records.

3. **Rollback & Compensation Guidance**:
   - Generates pre-import snapshot IDs and compensation step instructions for partial failures.
   - Provides executable SQL/API recovery scripts to restore previous states cleanly.

---

## Secure Import Pipeline

### Preview & Quarantine
All imports run through a preview stage before any persistent write. Rows are validated against the target schema; rows that fail validation or reference unknown keys are moved to a **quarantine** set rather than aborting the whole batch.

- `preview.accepted`: rows that passed validation and will be applied.
- `preview.quarantined`: rows rejected with `row.errors` and `row.reason`.
- `preview.traceId`: stable identifier linking every accepted row to its import batch and audit log entry.

### Traceability
Each accepted row records `traceId`, `batchId`, `sourceRowIndex`, and `appliedAt`. These fields are surfaced in the `ImportResult.appliedRecords` payload so downstream consumers can audit or reverse individual rows.

### Rollback & Retry
- **Rollback**: use `rollbackGuidance.compensationSteps` to revert applied rows by `traceId`. Compensation is idempotent and safe to re-run.
- **Retry**: re-submit only `preview.quarantined` rows after correcting the flagged fields. Accepted rows are skipped via idempotency keys, so retries never duplicate data.
- **Partial failure**: if a live import fails midway, execute compensation for the reported `traceId` range, then retry the quarantined subset.

### Operational Edge Cases
- Duplicate keys within a single payload are quarantined, not silently merged.
- Rows referencing missing foreign keys are quarantined with `reason: "missing_reference"`.
- Oversized payloads are rejected before preview; split into smaller batches and retry.

## Supported Formats

### 1. JSON Array
```json
[
  {
    "id": "agent-101",
    "name": "Yield Optimizer",
    "description": "Automated liquidity and yield management agent.",
    "category": "trading",
    "price": 50,
    "version": "1.0.0"
  }
]
```

### 2. CSV
```csv
id,name,description,category,price,version
agent-101,Yield Optimizer,Automated liquidity and yield management agent.,trading,50,1.0.0
agent-102,Governance Oracle,Monitors voting proposals on Soroban.,governance,25,1.1.0
```

---

## API Endpoints

### 1. Dry Run Validation

POST /api/import/dry-run?entityType=agents

- Request Body: JSON array or CSV text
- Response: Full validation summary and row diffs, zero persistent writes.

### 2. Live Ingestion

POST /api/import?entityType=agents&dryRun=false

- Request Body: JSON array or CSV text
- Response: `ImportResult` with `appliedRecords` and `rollbackGuidance`.

---

## Remediation for Invalid Rows & Partial Failures

1. **Validation Errors**:
   - Fix required fields, string lengths, or numeric ranges as flagged in `row.errors`.
2. **Duplicate Key Errors**:
   - Deduplicate external IDs before committing.
3. **Rollback Guidance**:
   - If an import fails midway during live execution, review `rollbackGuidance.compensationSteps` and execute compensation actions to return state to baseline.
4. **Quarantined Rows**:
   - Inspect `preview.quarantined`, correct each row's `errors`, and resubmit only those rows. Accepted rows remain traceable via `traceId` and are skipped on retry.
