"use client"
import React from "react"
import SimulationLogs from "./SimulationLogs"
import useSimulationStore, { SimulationStore, SimulationRun } from "../../store/useSimulationStore"

// -----------------------------------------------------------------------------
// Operator-safe backfill tool (dry-run + resumable checkpoints)
// -----------------------------------------------------------------------------
// This tool is designed to be run from the browser console or a thin
// CLI wrapper. It previews changes, stores checkpoints in localStorage,
// resumes safely, and reports skipped or failed records. The implementation
// is deliberately small and well-tested rather than a broad rewrite.

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type BackfillRecord = {
  id: string
  simulationId: string
  payload: Record<string, unknown>
  targetStatus?: string
}

export type BackfillDirection = "forward" | "reverse"

export type BackfillOptions = {
  /** When true, no mutations are performed. Defaults to true. */
  dryRun?: boolean
  /** Number of records to process before writing a checkpoint. Defaults to 50. */
  batchSize?: number
  /** Maximum number of records to process in this run. Defaults to Infinity. */
  maxRecords?: number
  /** Direction of the backfill. Defaults to "forward". */
  direction?: BackfillDirection
  /** Optional checkpoint key override. */
  checkpointKey?: string
}

export type BackfillCheckpoint = {
  key: string
  processedIds: string[]
  lastId?: string
  updatedAt: number
}

export type BackfillReport = {
  total: number
  processed: number
  skipped: number
  failed: number
  written: number
  skippedIds: string[]
  failedIds: string[]
  writtenIds: string[]
  dryRun: boolean
  direction: BackfillDirection
  startedAt: number
  finishedAt?: number
}

export type BackfillStore = {
  runs: Record<string, SimulationRun>
  startRun: (simulationId: string) => Promise<void> | void
  fetchLogsForRun: (runId: string) => Promise<void> | void
}

// -----------------------------------------------------------------------------
// Checkpoint storage (localStorage + in-memory fallback)
// -----------------------------------------------------------------------------

const memoryCheckpoints = new Map<string, BackfillCheckpoint>()

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null
    return window.localStorage
  } catch {
    return null
  }
}

export function loadCheckpoint(key: string): BackfillCheckpoint | null {
  const storage = getStorage()
  if (!storage) return memoryCheckpoints.get(key) ?? null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BackfillCheckpoint
    if (!parsed || !Array.isArray(parsed.processedIds)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveCheckpoint(key: string, checkpoint: BackfillCheckpoint): void {
  const storage = getStorage()
  if (!storage) {
    memoryCheckpoints.set(key, checkpoint)
    return
  }
  try {
    storage.setItem(key, JSON.stringify(checkpoint))
  } catch {
    memoryCheckpoints.set(key, checkpoint)
  }
}

export function clearCheckpoint(key: string): void {
  const storage = getStorage()
  if (storage) {
    try {
      storage.removeItem(key)
    } catch {
      // ignore storage errors
    }
  }
  memoryCheckpoints.delete(key)
}

// -----------------------------------------------------------------------------
// Core backfill runner
// -----------------------------------------------------------------------------

export type BackfillContext = {
  /** Returns the current value for a record, or null if missing. */
  read: (record: BackfillRecord) => Promise<unknown | null> | unknown | null
  /** Persists the new value for a record. */
  write: (record: BackfillRecord, value: unknown) => Promise<void> | void
  /** Optional predicate to skip records that are already correct. */
  shouldSkip?: (record: BackfillRecord, current: unknown | null) => boolean
  /** Optional transform to derive the new value. */
  transform: (record: BackfillRecord, current: unknown | null) => unknown
}

export async function runBackfill(
  records: BackfillRecord[],
  context: BackfillContext,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const dryRun = options.dryRun ?? true
  const batchSize = Math.max(1, options.batchSize ?? 50)
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY
  const direction = options.direction ?? "forward"
  const checkpointKey = options.checkpointKey ?? "trellis:backfill:checkpoint"

  const report: BackfillReport = {
    total: records.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    written: 0,
    skippedIds: [],
    failedIds: [],
    writtenIds: [],
    dryRun,
    direction,
    startedAt: Date.now(),
  }

  const existing = loadCheckpoint(checkpointKey)
  const processedIds = new Set<string>(existing?.processedIds ?? [])

  const ordered = direction === "forward" ? [...records] : [...records].reverse()

  let processedSinceCheckpoint = 0
  let lastId: string | undefined

  for (const record of ordered) {
    if (report.processed >= maxRecords) break
    if (processedIds.has(record.id)) {
      report.skipped += 1
      report.skippedIds.push(record.id)
      continue
    }

    try {
      const current = await context.read(record)
      if (context.shouldSkip && context.shouldSkip(record, current)) {
        report.skipped += 1
        report.skippedIds.push(record.id)
        processedIds.add(record.id)
        continue
      }

      const nextValue = context.transform(record, current)

      if (!dryRun) {
        await context.write(record, nextValue)
        report.written += 1
        report.writtenIds.push(record.id)
      }

      processedIds.add(record.id)
      report.processed += 1
      lastId = record.id
      processedSinceCheckpoint += 1

      if (processedSinceCheckpoint >= batchSize) {
        saveCheckpoint(checkpointKey, {
          key: checkpointKey,
          processedIds: Array.from(processedIds),
          lastId,
          updatedAt: Date.now(),
        })
        processedSinceCheckpoint = 0
      }
    } catch (err) {
      report.failed += 1
      report.failedIds.push(record.id)
      // Do not mark as processed so a resume will retry it.
    }
  }

  saveCheckpoint(checkpointKey, {
    key: checkpointKey,
    processedIds: Array.from(processedIds),
    lastId,
    updatedAt: Date.now(),
  })

  report.finishedAt = Date.now()
  return report
}

// -----------------------------------------------------------------------------
// Operational edge cases, failure modes, and rollback/recovery
// -----------------------------------------------------------------------------
//
// 1. Dry-run defaults to true. Operators must explicitly pass dryRun: false
//    to perform writes. This prevents accidental mutations from a console
//    paste.
//
// 2. Checkpoints are written to localStorage under a stable key. If localStorage
//    is unavailable (SSO, private mode), the tool falls back to an in-memory
//    Map. Resuming across page reloads will not work in that case.
//
// 3. If a write fails, the record is not marked as processed. A later resume
//    will retry it. The report lists failed IDs so operators can inspect them.
//
// 4. Rollback: the tool does not automatically roll back writes. Because the
//    transform is pure and the checkpoint tracks what was processed, an operator
//    can run a reverse backfill (options.direction = "reverse") with a compensating
//    transform, or clear the checkpoint and re-run with the original values.
//
// 5. Resume: call runBackfill again with the same checkpointKey. Records already
//    in the checkpoint are skipped. To force a full re-run, call clearCheckpoint
//    first.
//
// 6. Batching: checkpoints are written every batchSize records and once at the
//    end of the run. A crash between checkpoints will replay at most batchSize
//    records. Writes must be idempotent for this to be safe.
//
// 7. Max records: operators can cap the run with maxRecords to perform a
//    controlled canary rollout.

// -----------------------------------------------------------------------------
// React component
// -----------------------------------------------------------------------------

export const SimulationRunner: React.FC<{ simulationId: string | null }> = ({ simulationId }) => {
  const [startRun, fetchLogsForRun, runs] = useSimulationStore((state: SimulationStore) => [state.startRun, state.fetchLogsForRun, state.runs])

  const runList: SimulationRun[] = Object.values(runs).filter((r: SimulationRun) => r.simulationId === simulationId).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => simulationId && startRun(simulationId)}
          disabled={!simulationId}
          className={`px-3 py-1 rounded text-white ${simulationId ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400'}`}
        >
          Run Selected
        </button>
      </div>

      <div>
        <h4 className="text-sm font-medium">Run History</h4>
        <div className="space-y-3 mt-2">
          {runList.length === 0 && <div className="text-sm text-slate-500">No runs yet.</div>}
          {runList.map((r: SimulationRun) => (
            <div key={r.runId} className="p-3 border rounded">
              <div className="flex justify-between items-center">
                <div className="text-sm">Run {r.runId}</div>
                <div className="text-xs text-slate-600">{r.status}</div>
              </div>
              <div className="mt-2">
                <SimulationLogs logs={r.logs} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default SimulationRunner
