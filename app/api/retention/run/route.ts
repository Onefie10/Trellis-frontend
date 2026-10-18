import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { deniedResponse, requireActor } from '@/lib/auth';
import { checkPermission } from '@/lib/permissions';

/**
 * #45 — Data retention policy enforcement endpoint.
 *
 * Classifies operational data types and enforces retention limits:
 *
 * | Type          | Retention | Notes                                         |
 * |---------------|-----------|-----------------------------------------------|
 * | audit         | 7 years   | Financial regulation / SOC 2                  |
 * | telemetry     | 90 days   | Anonymous events, short-lived                 |
 * | exports       | 30 days   | Generated export artefacts                    |
 * | support       | 2 years   | Support ticket evidence                       |
 * | simulations   | 1 year    | Simulation run data                           |
 *
 * Records linked to active disputes, open audits, or unsettled financial
 * positions are **protected** and exempt from deletion regardless of age.
 *
 * POST /api/retention/run   — execute a dry-run or live cleanup
 * GET  /api/retention/run   — return the current policy table
 *
 * ## Authorization
 *
 * `POST` deletes records irreversibly and previously had no authorization at
 * all — anyone who could reach the endpoint could trigger a cleanup. It now
 * requires the `run_retention_cleanup` grant, which the matrix restricts to
 * `admin` at `global` scope.
 *
 * That grant carries a `requires_confirmation` condition, satisfied only by
 * `dryRun: false`. A `dryRun: true` request is therefore a real check — a
 * maintainer can be told what a cleanup *would* remove — but a deliberately
 * unusable one: the delete path is unreachable without explicitly opting out of
 * the dry run.
 *
 * `GET` only returns the static policy table, so it stays open.
 */

// ── Policy definitions ────────────────────────────────────────────────────────

export type DataClass = 'audit' | 'telemetry' | 'exports' | 'support' | 'simulations';

interface RetentionPolicy {
  /** Maximum age in days before a record is eligible for deletion. */
  maxAgeDays: number;
  /** Human-readable reason this class must be retained for that duration. */
  rationale: string;
  /**
   * Whether records in this class can be protected by a dispute / audit hold.
   * When `true`, records matching an active hold are excluded from deletion.
   */
  protectable: boolean;
}

const POLICY_TABLE: Record<DataClass, RetentionPolicy> = {
  audit: {
    maxAgeDays: 7 * 365,
    rationale: 'Financial audit trail — kept 7 years per SOC 2 / GDPR recital 47.',
    protectable: true,
  },
  telemetry: {
    maxAgeDays: 90,
    rationale: 'Anonymous operational telemetry. No PII; short retention reduces storage cost.',
    protectable: false,
  },
  exports: {
    maxAgeDays: 30,
    rationale: 'Generated export artefacts expire after 30 days.',
    protectable: false,
  },
  support: {
    maxAgeDays: 2 * 365,
    rationale: 'Support evidence retained 2 years to cover statutory dispute windows.',
    protectable: true,
  },
  simulations: {
    maxAgeDays: 365,
    rationale: 'Simulation run data kept 1 year for reproducibility and user history.',
    protectable: true,
  },
};

// ── Request schema ────────────────────────────────────────────────────────────

const RunRequestSchema = z.object({
  /** When `true` report what would be deleted without actually deleting. */
  dryRun: z.boolean().optional().default(true),
  /** Limit cleanup to specific data classes; defaults to all. */
  dataClasses: z
    .array(z.enum(['audit', 'telemetry', 'exports', 'support', 'simulations']))
    .optional(),
});

// ── Stubs (replace with real DB calls) ───────────────────────────────────────

interface CleanupResult {
  dataClass: DataClass;
  eligibleCount: number;
  protectedCount: number;
  deletedCount: number;
}

async function countEligible(_class: DataClass, _maxAgeDays: number): Promise<number> {
  // TODO: SELECT COUNT(*) FROM <table> WHERE created_at < NOW() - INTERVAL '<maxAgeDays> days'
  return 0;
}

async function countProtected(_class: DataClass): Promise<number> {
  // TODO: JOIN against disputes / audits / settlements table for active holds.
  return 0;
}

async function deleteExpired(_class: DataClass, _maxAgeDays: number, _dryRun: boolean): Promise<number> {
  // TODO: DELETE FROM <table>
  //         WHERE created_at < NOW() - INTERVAL '<maxAgeDays> days'
  //           AND id NOT IN (SELECT record_id FROM active_holds WHERE data_class = _class)
  return 0;
}

// ── Route handlers ────────────────────────────────────────────────────────────

/** GET /api/retention/run — return the current policy table. */
export async function GET(_request: NextRequest) {
  const policy = Object.entries(POLICY_TABLE).map(([dataClass, p]) => ({
    dataClass,
    maxAgeDays: p.maxAgeDays,
    rationale: p.rationale,
    protectable: p.protectable,
  }));
  return NextResponse.json({ policy }, { status: 200 });
}

/**
 * POST /api/retention/run
 *
 * Body: { dryRun?: boolean, dataClasses?: DataClass[] }
 */
export async function POST(request: NextRequest) {
  // Identity first. An anonymous caller should not reach schema validation, and
  // the `dryRun` flag that satisfies the confirmation condition comes from the
  // body, so the action cannot be authorized until after the body is read.
  const identity = await requireActor(request);
  if (!identity.ok) return identity.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { dryRun, dataClasses } = parsed.data;

  // Irreversible and spans every data class, so the grant is admin-only and the
  // `requires_confirmation` condition is satisfied only by `dryRun: false`.
  const decision = checkPermission('run_retention_cleanup', {
    role: identity.actor.role,
    actorId: identity.actor.id,
    resourceScope: 'global',
    context: { confirmed: dryRun === false },
  });
  if (!decision.allowed) return deniedResponse(decision);

  const targets: DataClass[] = dataClasses ?? (Object.keys(POLICY_TABLE) as DataClass[]);

  const results: CleanupResult[] = [];

  for (const dc of targets) {
    const policy = POLICY_TABLE[dc];
    const eligibleCount = await countEligible(dc, policy.maxAgeDays);
    const protectedCount = policy.protectable ? await countProtected(dc) : 0;
    const deletedCount = await deleteExpired(dc, policy.maxAgeDays, dryRun);

    results.push({ dataClass: dc, eligibleCount, protectedCount, deletedCount });
  }

  return NextResponse.json(
    {
      dryRun,
      ranAt: new Date().toISOString(),
      results,
      summary: {
        totalEligible: results.reduce((s, r) => s + r.eligibleCount, 0),
        totalProtected: results.reduce((s, r) => s + r.protectedCount, 0),
        totalDeleted: results.reduce((s, r) => s + r.deletedCount, 0),
      },
    },
    { status: 200 },
  );
}
