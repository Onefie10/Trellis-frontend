/**
 * Trellis Synthetic Journey Monitor â€” Runnable CLI Tool.
 *
 * Exercises the critical end-to-end user workflow:
 * Wallet Session â†’ Marketplace Catalog â†’ IPFS Metadata â†’ Protocol Guard â†’
 * Soroban Preflight â†’ Transaction Broadcast â†’ State Verification.
 *
 * Measures latency, evaluates SLAs, and attributes failure/degradation to the exact
 * culprit subsystem (Wallet, IPFS, Soroban RPC, Horizon, Protocol Guard, etc.).
 *
 * Exit codes:
 *   0  Journey passed within SLA
 *   1  Journey failed, or SLA degraded with --strict
 *   2  Usage error or invalid argument
 *
 * Usage:
 *   npm run monitor:journey
 *   npm run monitor:journey -- --json
 *   npm run monitor:journey -- --strict
 *   npm run monitor:journey -- --scenario ipfs_down
 *   npm run monitor:journey -- --iterations 5 --interval 500
 */

import {
  createDefaultAdapters,
  runSyntheticJourney,
  SyntheticJourneyScheduler,
  type AdapterOptions,
  type SyntheticJourneyResult,
} from '../lib/journey-monitor';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

interface ParsedArgs {
  iterations: number;
  intervalMs: number;
  scenario: AdapterOptions['scenario'];
  strict: boolean;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`
Trellis Synthetic Journey Monitor

Usage:
  npm run monitor:journey -- [options]
  npx tsx scripts/synthetic-journey-monitor.ts [options]

Options:
  -n, --iterations <n>   Number of journey iterations to run (default: 1)
  -i, --interval <ms>    Interval in ms between iterations (default: 0)
  -s, --scenario <name>  Inject failure or latency preset:
                           healthy (default), wallet_invalid, wallet_unfunded,
                           catalog_missing, ipfs_down, emergency_paused,
                           abuse_risk, rpc_timeout, rpc_resource_exceeded,
                           horizon_rate_limited, horizon_bad_seq, state_desync,
                           high_latency
      --strict           Treat SLA degradation as failure (exit code 1)
      --json             Output results as formatted JSON
  -h, --help             Show this help message

Exit codes:
  0  All steps passed within SLA
  1  At least one journey run failed or SLA degraded in strict mode
  2  Usage error or unrecognized option
`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    iterations: 1,
    intervalMs: 0,
    scenario: 'healthy',
    strict: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--strict':
        parsed.strict = true;
        break;
      case '-n':
      case '--iterations': {
        const next = argv[i + 1];
        if (!next || isNaN(Number(next)) || Number(next) < 1) {
          throw new Error(`--iterations requires a positive integer; got '${next}'`);
        }
        parsed.iterations = parseInt(next, 10);
        i += 1;
        break;
      }
      case '-i':
      case '--interval': {
        const next = argv[i + 1];
        if (!next || isNaN(Number(next)) || Number(next) < 0) {
          throw new Error(`--interval requires a non-negative integer; got '${next}'`);
        }
        parsed.intervalMs = parseInt(next, 10);
        i += 1;
        break;
      }
      case '-s':
      case '--scenario': {
        const next = argv[i + 1];
        const validScenarios = [
          'healthy',
          'wallet_invalid',
          'wallet_unfunded',
          'catalog_missing',
          'ipfs_down',
          'emergency_paused',
          'abuse_risk',
          'rpc_timeout',
          'rpc_resource_exceeded',
          'horizon_rate_limited',
          'horizon_bad_seq',
          'state_desync',
          'high_latency',
        ];
        if (!next || !validScenarios.includes(next)) {
          throw new Error(
            `--scenario must be one of: ${validScenarios.join(', ')}; got '${next}'`,
          );
        }
        parsed.scenario = next as AdapterOptions['scenario'];
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option '${arg}'. Run with --help for usage.`);
        }
        break;
    }
  }

  return parsed;
}

function renderTextReport(result: SyntheticJourneyResult): string {
  const statusEmoji =
    result.status === 'healthy' ? 'âœ… HEALTHY' : result.status === 'degraded' ? 'âš ï¸ DEGRADED' : 'âŒ FAILED';

  const lines: string[] = [];
  lines.push('â•'.repeat(72));
  lines.push(` TRELLIS SYNTHETIC JOURNEY REPORT â€” ${result.workflow}`);
  lines.push('â•'.repeat(72));
  lines.push(` Run ID:       ${result.journeyId}`);
  lines.push(` Status:       ${statusEmoji}`);
  lines.push(` Total Time:   ${result.totalDurationMs}ms (SLA: ${result.totalSlaThresholdMs}ms)`);
  lines.push(` Target Agent: ${result.metadata.agentId}`);
  lines.push(` Actor Key:    ${result.metadata.actorPublicKey}`);
  lines.push('â”€'.repeat(72));
  lines.push(' Step Execution & SLA Breakdown:');

  for (const step of result.steps) {
    const icon = step.status === 'passed' ? 'âœ“' : step.status === 'degraded' ? 'âš ' : 'âœ—';
    const statusLabel = step.status.toUpperCase().padEnd(8);
    const durationLabel = `${step.durationMs}ms / ${step.slaThresholdMs}ms`.padEnd(16);
    const stepName = step.name.padEnd(40);
    lines.push(`  ${icon} [${statusLabel}] ${stepName} ${durationLabel} [${step.dependency}]`);

    if (step.error) {
      lines.push(`      â””â”€ ERROR: ${step.error}`);
    }
  }

  if (result.blame) {
    lines.push('â”€'.repeat(72));
    lines.push(' DEPENDENCY BLAME ATTRIBUTION:');
    lines.push(`  Culprit:        ${result.blame.culprit.toUpperCase()}`);
    lines.push(`  Severity:       ${result.blame.severity.toUpperCase()}`);
    lines.push(`  Confidence:     ${Math.round(result.blame.confidence * 100)}%`);
    lines.push(`  Retriable:      ${result.blame.retriable ? 'Yes' : 'No'}`);
    lines.push(`  Root Cause:     ${result.blame.reason}`);
    lines.push(`  Remediation:    ${result.blame.suggestedRemediation}`);
  }

  lines.push('â•'.repeat(72));
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return EXIT_USAGE;
  }

  if (args.help) {
    printHelp();
    return EXIT_OK;
  }

  const stepDelays =
    args.scenario === 'high_latency'
      ? {
          soroban_preflight_simulation: 1800, // SLA is 1200
          transaction_submission: 3200,      // SLA is 2500
        }
      : undefined;

  const adapters = createDefaultAdapters({
    scenario: args.scenario,
    stepDelaysMs: stepDelays,
  });

  if (args.iterations === 1) {
    const result = await runSyntheticJourney(
      {
        strictSla: args.strict,
      },
      adapters,
    );

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderTextReport(result));
    }

    if (result.status === 'failed') return EXIT_FAILED;
    if (result.status === 'degraded' && args.strict) return EXIT_FAILED;
    return EXIT_OK;
  }

  // Multi-iteration run with scheduler metrics aggregation
  const scheduler = new SyntheticJourneyScheduler({
    maxHistory: args.iterations,
    config: { strictSla: args.strict },
    adapters,
  });

  const results: SyntheticJourneyResult[] = [];
  let anyFailure = false;

  for (let i = 0; i < args.iterations; i += 1) {
    const result = await scheduler.runOnce();
    results.push(result);

    if (result.status === 'failed' || (result.status === 'degraded' && args.strict)) {
      anyFailure = true;
    }

    if (i < args.iterations - 1 && args.intervalMs > 0) {
      await new Promise((r) => setTimeout(r, args.intervalMs));
    }
  }

  const metrics = scheduler.getMetrics();

  if (args.json) {
    console.log(JSON.stringify({ results, metrics }, null, 2));
  } else {
    for (const res of results) {
      console.log(renderTextReport(res));
      console.log('');
    }
    console.log('â•'.repeat(72));
    console.log(` AGGREGATE SUMMARY (${args.iterations} Iterations)`);
    console.log('â•'.repeat(72));
    console.log(` Availability:     ${metrics.availabilityPercent}%`);
    console.log(` Passed:           ${metrics.passedRuns}`);
    console.log(` Degraded:         ${metrics.degradedRuns}`);
    console.log(` Failed:           ${metrics.failedRuns}`);
    console.log(` Mean Duration:    ${metrics.meanDurationMs}ms`);
    console.log(` p95 Duration:     ${metrics.p95DurationMs}ms`);
    console.log(` p99 Duration:     ${metrics.p99DurationMs}ms`);
    console.log('â•'.repeat(72));
  }

  return anyFailure ? EXIT_FAILED : EXIT_OK;
}

if (process.env.NODE_ENV !== 'test') {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('Fatal synthetic journey error:', err);
      process.exit(EXIT_FAILED);
    },
  );
}
