# Schema Evolution Guardrails Runbook

## Overview

As the Trellis Frontend evolves, data stored in client-side persistence (IndexedDB, LocalStorage) and payloads exchanged across public API contracts will encounter format revisions, newly added properties, and legacy fields scheduled for sunset.

The **Schema Evolution Guardrails** module ([lib/schema-versioning.ts](file:///c:/Users/HP/drips/Bigclavs/Trellis-frontend/lib/schema-versioning.ts)) provides declarative versioning, configurable unknown-field policies, and deprecated-field lifecycle controls for both read and write boundaries.

---

## Policies and Failure Modes

### 1. Unknown Field Policies (`unknownFieldPolicy`)

When a record contains fields not declared in the target schema (excluding system metadata: `id`, `schemaVersion`, `migratedAt`, `previousVersion`):

| Policy | Behavior | Recommended Use Case |
|---|---|---|
| `'strip'` | Drops unknown fields from output; emits warnings. | **Default for Public API Responses** & outbound network requests. Prevents payload pollution and internal data leaks. |
| `'reject'` | Fails validation (`valid: false`, records error). | **Strict Write Gateways** and critical mutation APIs where unvalidated client inputs cannot be tolerated. |
| `'preserve'` | Retains unknown fields as-is. | **Default for Local Storage Reads** to preserve forward-compatibility and custom client-side cache extensions. |
| `'quarantine'` | Moves unknown fields to a separate envelope property (defaults to `_quarantined`). | **Diagnostic & Ingestion Pipelines** where telemetry or unexpected properties must be audited without dropping data. |

### 2. Deprecated Field Policies (`deprecatedFieldPolicy`)

When a record contains fields flagged with `deprecated: true` (or registered via `defineDeprecatedField`):

| Policy | Behavior | Recommended Use Case |
|---|---|---|
| `'warn'` | Issues deprecation notice and logs developer warnings via `console.warn`. Record remains `valid: true`. | **Active Rollouts & Transition Windows**. Alerts developers without breaking consumer UI. |
| `'reject'` | Fails validation (`valid: false`, records error). | **Staging / CI Linting / Sunsetted Schemas**. Enforces that code has migrated before production cutoffs. |
| `'allow'` | Silently permits deprecated fields without warnings or errors. | **Legacy Testing Environments** or high-frequency batch sync loops. |

---

## Integration Guide

### Guarding Stored Record Writes
```typescript
import { guardRecordWrite } from '@/lib/schema-versioning';

// Writes with unknown field stripping and deprecation warnings
const sanitizedRecord = guardRecordWrite(
  draftAgent,
  '2.0',
  { unknownFieldPolicy: 'strip', deprecatedFieldPolicy: 'warn' }
);
```

### Guarding Public API Responses
```typescript
import { guardAPIResponse } from '@/lib/schema-versioning';

const { data, validCount, rejectedCount, errors, warnings } = guardAPIResponse<AgentRecord>(
  rawApiResponse,
  { unknownFieldPolicy: 'strip', deprecatedFieldPolicy: 'warn' }
);

if (rejectedCount > 0) {
  telemetry.logError('API schema violations', { errors });
}
```

---

## Operational Edge Cases & Recovery Steps

### 1. Unexpected Field Drift in API Responses
- **Symptom**: Incoming API payload contains fields from a newer backend release that the frontend schema catalog does not yet recognise.
- **Guardrail Protection**: Default `unknownFieldPolicy: 'strip'` isolates the frontend state from unexpected fields, preventing UI crashes or unvalidated prototype pollution.
- **Action**:
  1. Inspect warning logs emitted by `guardAPIResponse`.
  2. If the field represents a new contract requirement, update the schema in `lib/schema-versioning.ts` with a new minor/major version.

### 2. Accidental Deprecated Field Breakage
- **Symptom**: Client mutation fails due to a rejected deprecated property during strict mode enforcement.
- **Rollback / Recovery**:
  1. Change `deprecatedFieldPolicy` back to `'warn'` in configuration.
  2. Identify the caller relying on the deprecated key.
  3. Update caller to write to the designated `replacement` property.

### 3. Corrupt or Unrecognized Schema Version in Storage
- **Symptom**: Record has an invalid or unknown `schemaVersion` (e.g. `999.0`).
- **Guardrail Protection**: Record is marked invalid and excluded from clean result arrays without throwing unhandled exceptions.
- **Rollback / Recovery**:
  1. Use `upgradeLoadedRecords` in non-throwing mode to recover salvageable fields.
  2. Fall back to base schema (`1.0`) defaults if automatic migration path is unavailable.
