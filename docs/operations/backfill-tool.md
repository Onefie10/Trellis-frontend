# Trellis Backfill Tool

Operator-safe backfill tool with dry-run preview, resumable checkpoints, and a structured report of skipped and failed records.

## Overview

The tool is a thin orchestrator in `scripts/backfill.ts`. It does not know about your data model. Instead, you provide an adapter module that implements the `BackfillAdapter` interface:

```ts
interface BackfillAdapter {
  loadRecords(): Promise<BackfillRecord[]>;
  plan(record: BackfillRecord): Promise<BackfillPlan>;
  apply(plan: BackfillPlan): Promise<void>;
}
```

- `loadRecords` must return records in a deterministic order. The checkpoint cursor is an index into this list.
- `plan` must be pure. It must not mutate state. Return an action of `update`, `skip`, or `fail`.
- `apply` must be idompotent. Running it twice for the same plan must not corrupt data.

## Usage

Set the adapter path and run the tool with tsx:

```bash
TRELLIS_BACKFILL_ADAPTER=./scripts/adapters/my-backfill.adapter.ts \
  npx tsx scripts/backfill.ts --dry-run --checkpoint .trellis/backfill.checkpoint.json
```

Apply changes and write a report:

```bash
TRELLIS_BACKFILL_ADAPTER=./scripts/adapters/my-backfill.adapter.ts \
  npx tsx scripts/backfill.ts --apply --report .trellis/backfill-report.json
```

Resume a partial run:

```bash
TRELLIS_BACKFILL_ADAPTER=./scripts/adapters/my-backfill.adapter.ts \
  npx tsx scripts/backfill.ts --apply --resume
```

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--dry-run` | true | Preview changes without applying. |
| `--apply` | false | Force apply. Overrides dry-run. |
| `--checkpoint <path> | `.trellis/backfill-checkpoint.json` | Checkpoint file. |
| `--report <path> | none | Write JSON report of each record. |
| `--limit <n> | none | Process only the first n records from the cursor. |
| `--resume` | true | Resume from existing checkpoint if present. |
| `--no-resume` | false | Ignore any existing checkpoint and start from the beginning. |
| `--max-attempts <n> | 3 | Recorded attempt count per record. |

## Checkpoint format

The checkpoint is written atomically via a temporary file and `rename`. It contains:

```json
{
  "version": 1,
  "tool": "trellis-backfill",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "cursor": 12,
  "records": {
    "record-1": { "id": "record-1", "status": "success", "attempts": 1, "updatedAt": "..." }
  }
}
```

## Edge cases and failure modes

- **Adapter missing**: the tool exits non-zero if `TRELLIS_BACKFILL_ADAPTER` is not set.
- **Adapter throws**: the record is marked `failed` and the cursor advances. Run again with `--resume` to retry.
- **Apply throws**: the record is marked `failed` with the error message. The checkpoint is written after every record.
- **Checkpoint corruption**: the tool rejects unknown versions or tool names. Remove the file to start fresh.
- **Interrupted run**: the cursor and records are persisted after each record, so a CTRL-C resumes correctly.
- **Duplicate ids in adapter output**: the last write wins. Ensure `loadRecords` returns unique ids.
- **Dry-run with no apply**: no changes are made and the checkpoint is not advanced.
- **Max attempts exceeded**: the record is marked `failed` and skipped on subsequent runs.

## Rollback and recovery

1. Keep the checkpoint file under version control or a durable volume.
2. Before applying, run a dry-run and archive the report.
3. If a batch is bad, restore the affected records from your own backup and delete the corresponding entries from `checkpoint.records`.
4. To restart from scratch, delete the checkpoint file and run with `--no-resume`.

## Testing

The tool is covered by jest tests in `scripts/backfill/__tests__/backfill.test.ts`. Run:

```bash
npx jest scripts/backfill/__tests__/backfill.test.ts
```
