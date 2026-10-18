#!/usr/bin/env node
/**
 * Trellis Projection Reconciliation CLI
 *
 * Compares source-of-truth state against cached or derived projections,
 * reports drift with root-cause hints, and optionally repairs projections
 * through a dry-run-first workflow.
 *
 * Usage:
 *   npx tsx scripts/reconcile-projections.ts --dry-run
 *   npx tsx scripts/reconcile-projections.ts --file path/to/snapshot.json --dry-run --json
 *   npx tsx scripts/reconcile-projections.ts --file path/to/snapshot.json --apply --report .trellis/recon-report.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECTION_DOMAINS,
  applyReconciliationRepair,
  createMemoryProjectionStore,
  reconcileAndRepair,
  renderReconciliationTextReport,
  runReconciliation,
  type ProjectionDomain,
  type ReconciliationProjectionState,
  type ReconciliationSourceState,
} from '../lib/reconciliation';

const EXIT_OK = 0;
const EXIT_DRIFT_OR_FAILED = 1;
const EXIT_USAGE = 2;

export interface CliOptions {
  file: string | null;
  dryRun: boolean;
  apply: boolean;
  planDigest: string | null;
  domains: ProjectionDomain[];
  onlyFindingIds: string[];
  json: boolean;
  reportPath: string | null;
  rollbackPath: string | null;
  help: boolean;
}

export function parseReconcileArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    file: null,
    dryRun: true,
    apply: false,
    planDigest: null,
    domains: [],
    onlyFindingIds: [],
    json: false,
    reportPath: null,
    rollbackPath: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        opts.apply = false;
        break;
      case '--apply':
        opts.apply = true;
        opts.dryRun = false;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-f':
      case '--file': {
        const val = argv[i + 1];
        if (!val) throw new Error(`${arg} requires a file path`);
        opts.file = val;
        i += 1;
        break;
      }
      case '--plan-digest': {
        const val = argv[i + 1];
        if (!val) throw new Error('--plan-digest requires a digest string');
        opts.planDigest = val;
        i += 1;
        break;
      }
      case '--domain': {
        const val = argv[i + 1] as ProjectionDomain | undefined;
        if (!val || !PROJECTION_DOMAINS.includes(val)) {
          throw new Error(`--domain must be one of: ${PROJECTION_DOMAINS.join(', ')}`);
        }
        if (!opts.domains.includes(val)) opts.domains.push(val);
        i += 1;
        break;
      }
      case '--only': {
        const val = argv[i + 1];
        if (!val) throw new Error('--only requires a finding ID');
        opts.onlyFindingIds.push(val);
        i += 1;
        break;
      }
      case '--report': {
        const val = argv[i + 1];
        if (!val) throw new Error('--report requires an output path');
        opts.reportPath = val;
        i += 1;
        break;
      }
      case '--rollback-out': {
        const val = argv[i + 1];
        if (!val) throw new Error('--rollback-out requires an output path');
        opts.rollbackPath = val;
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function buildDefaultSnapshot(): {
  source: ReconciliationSourceState;
  projection: ReconciliationProjectionState;
} {
  const wallet = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  const referred = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  return {
    source: {
      affiliate: {
        referralCodes: [
          {
            code: 'ASTRDEMO12',
            ownerWallet: wallet,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        referrals: [
          {
            id: 'ref-1',
            referralCode: 'ASTRDEMO12',
            referredUserAddress: referred,
            referredUserName: 'Sam Security',
            status: 'converted',
            commissionRate: 10,
            commissionAmount: '150.00',
            createdAt: '2026-01-10T12:00:00.000Z',
            convertedAt: '2026-01-11T09:30:00.000Z',
          },
        ],
        payouts: [
          {
            id: 'pay-1',
            walletAddress: wallet,
            amount: '150.00',
            status: 'completed',
            requestedAt: '2026-01-12T10:00:00.000Z',
            processedAt: '2026-01-12T10:05:00.000Z',
            transactionHash: '5c6a1e3e7f0b5d98a2c1b4e6f8a0d3c5e7b9a1d4f6a8c0e2b4d6f8a0c2e4b6d8',
          },
        ],
        vanitySlugs: [],
        linkEvents: [],
      },
      searchIndex: {
        records: [
          {
            record: {
              id: 'ag-1',
              name: 'Canopy Predictor',
              description: 'Predicts market volatility for XLM/USDC',
              status: 'active',
            },
            permissions: { isPublic: true },
            updatedAt: 1700000000000,
          },
        ],
      },
      telemetry: {
        idempotencyEvents: [
          { ts: 1700000000000, scope: 'payouts', kind: 'hit', reason: 'replayed' },
        ],
        abuseEvents: [
          {
            eventType: 'abuse_evaluated',
            operation: 'claim_payout',
            environment: 'production',
            timestamp: 1700000000000,
            actorId: wallet,
            riskScore: 10,
            action: 'allow',
            signals: [],
          },
        ],
      },
    },
    projection: {
      affiliate: {
        earningsLedger: [{ wallet, earnedXlm: 150 }],
        walletStats: {
          [wallet]: {
            totalReferrals: 1,
            activeReferrals: 1,
            totalEarnings: '150.00',
            pendingEarnings: '0.00',
            totalPayouts: '150.00',
            conversionRate: 100,
          },
        },
        clickMetricsByWallet: {},
      },
      searchIndex: {
        indexedRecords: [
          {
            id: 'ag-1',
            name: 'Canopy Predictor',
            description: 'Predicts market volatility for XLM/USDC',
            status: 'active',
            visibility: 'public',
            indexed_at: 1700000000000,
          },
        ],
      },
      telemetry: {
        idempotencyCounters: {
          idempotency_requests: 1,
          idempotency_hits: 1,
          idempotency_collisions: 0,
          idempotency_retries: 0,
          idempotency_expired: 0,
        },
        abuseCounters: {
          totalEvaluations: 1,
          lowRiskAllowed: 1,
          stepUpChallenges: 0,
          quarantinedReviews: 0,
          criticalBlocks: 0,
        },
      },
    },
  };
}

function loadSnapshotFile(filePath: string): {
  source: ReconciliationSourceState;
  projection: ReconciliationProjectionState;
} {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Snapshot file not found: ${abs}`);
  }
  const parsed = JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object' && ('source' in parsed || 'projection' in parsed)) {
    return {
      source: (parsed.source as ReconciliationSourceState) ?? {},
      projection: (parsed.projection as ReconciliationProjectionState) ?? {},
    };
  }
  throw new Error('Snapshot JSON must contain { "source": {...}, "projection": {...} }');
}

function printHelp(): void {
  console.log(`
Trellis Projection Reconciliation Job

Usage:
  npx tsx scripts/reconcile-projections.ts [options]

Options:
  -f, --file <path>         Input JSON containing { source, projection }
      --dry-run             Detect drift and generate repair plan without mutating (default)
      --apply               Execute dry-run-first repair workflow
      --plan-digest <hex>   Require dry-run plan digest to match <hex> before applying
      --domain <name>       Restrict to affiliate-ledger, referral-click-metrics, search-index, telemetry-counters
      --only <findingId>    Repair only specific finding ID(s) (repeatable)
      --report <path>       Write full ReconciliationReport JSON to file
      --rollback-out <path> Write pre-repair RollbackSnapshot JSON to file
      --json                Print report as JSON to stdout
  -h, --help                Show this help message
`);
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseReconcileArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_USAGE;
  }

  if (opts.help) {
    printHelp();
    return EXIT_OK;
  }

  let snapshot: { source: ReconciliationSourceState; projection: ReconciliationProjectionState };
  try {
    snapshot = opts.file ? loadSnapshotFile(opts.file) : buildDefaultSnapshot();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_USAGE;
  }

  const store = createMemoryProjectionStore(snapshot.projection);
  const domains = opts.domains.length > 0 ? opts.domains : undefined;
  const onlyFindingIds = opts.onlyFindingIds.length > 0 ? opts.onlyFindingIds : undefined;

  try {
    const report = opts.apply
      ? opts.planDigest
        ? await applyReconciliationRepair(snapshot.source, store, {
            domains,
            onlyFindingIds,
            approvedPlan: opts.planDigest,
            requireDryRunApproval: true,
          })
        : (
            await reconcileAndRepair(snapshot.source, store, {
              domains,
              onlyFindingIds,
              apply: true,
            })
          ).applyReport ??
          runReconciliation(snapshot.source, snapshot.projection, { domains })
      : runReconciliation(snapshot.source, snapshot.projection, { domains });

    if (opts.reportPath) {
      const absReport = resolve(opts.reportPath);
      mkdirSync(dirname(absReport), { recursive: true });
      writeFileSync(absReport, JSON.stringify(report, null, 2), 'utf-8');
    }

    if (opts.rollbackPath && report.rollbackSnapshot) {
      const absRollback = resolve(opts.rollbackPath);
      mkdirSync(dirname(absRollback), { recursive: true });
      writeFileSync(absRollback, JSON.stringify(report.rollbackSnapshot, null, 2), 'utf-8');
    }

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReconciliationTextReport(report));
    }

    return report.ok ? EXIT_OK : EXIT_DRIFT_OR_FAILED;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_DRIFT_OR_FAILED;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
