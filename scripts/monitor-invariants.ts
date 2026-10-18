/**
 * Trellis invariant monitor — read-only reporting command.
 *
 * Evaluates every registered invariant against a dataset snapshot and reports
 * pass/fail per invariant, the record IDs implicated by each failure, and safe
 * next steps. The command never writes to the dataset it reads.
 *
 * Exit codes
 *   0  nothing failed at or above --fail-on
 *   1  at least one invariant failed at or above --fail-on
 *   2  usage error, or the snapshot could not be read or parsed
 *
 * `2` is distinct from `1` on purpose: a missing snapshot is an operator
 * mistake, and CI should not report it as data corruption.
 *
 * Usage
 *   npm run monitor:invariants
 *   npm run monitor:invariants -- --file path/to/snapshot.json --json
 *   npm run monitor:invariants -- --strict --domain funds --domain ownership
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { runInvariantMonitor } from '../lib/invariant-monitor/monitor';
import { renderJsonReport, renderTextReport } from '../lib/invariant-monitor/report';
import { INVARIANT_DOMAINS, type InvariantDomain, type Severity } from '../lib/invariant-monitor/types';
import { ALL_INVARIANTS } from '../lib/invariant-monitor/registry';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const SEVERITIES: readonly Severity[] = ['critical', 'error', 'warning'];

const DEFAULT_SNAPSHOT = 'tests/fixtures/invariant-monitor/healthy-dataset.json';

interface ParsedArgs {
  file: string | null;
  json: boolean;
  list: boolean;
  strict: boolean;
  failOn: Severity;
  domains: InvariantDomain[];
  only: string[];
  help: boolean;
}

function printHelp(): void {
  console.log(`
Trellis Invariant Monitor

Usage:
  npm run monitor:invariants -- [options]
  npx tsx scripts/monitor-invariants.ts [options]

Options:
  -f, --file <path>   Snapshot to monitor (default: ${DEFAULT_SNAPSHOT})
      --json          Emit the report as JSON
      --strict        Same as --fail-on warning
      --fail-on <sev> Fail on critical, error (default), or warning
      --domain <name> Restrict to funds, ownership, lifecycle, authorization (repeatable)
      --only <id>     Restrict to a specific invariant ID (repeatable)
      --list          List the registered invariants and exit
  -h, --help          Show this message

Exit codes:
  0  no invariant failed at or above the threshold
  1  at least one invariant failed
  2  usage error, or the snapshot could not be read

This command is read-only. It reports findings; it never repairs a snapshot.
`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    file: null,
    json: false,
    list: false,
    strict: false,
    failOn: 'error',
    domains: [],
    only: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--list':
        parsed.list = true;
        break;
      case '--strict':
        parsed.strict = true;
        break;
      case '-f':
      case '--file': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`${arg} requires a path`);
        parsed.file = value;
        index += 1;
        break;
      }
      case '--fail-on': {
        const value = argv[index + 1];
        if (value === undefined || !SEVERITIES.includes(value as Severity)) {
          throw new Error(`--fail-on must be one of: ${SEVERITIES.join(', ')}`);
        }
        parsed.failOn = value as Severity;
        index += 1;
        break;
      }
      case '--domain': {
        const value = argv[index + 1];
        if (value === undefined || !INVARIANT_DOMAINS.includes(value as InvariantDomain)) {
          throw new Error(`--domain must be one of: ${INVARIANT_DOMAINS.join(', ')}`);
        }
        if (!parsed.domains.includes(value as InvariantDomain)) {
          parsed.domains.push(value as InvariantDomain);
        }
        index += 1;
        break;
      }
      case '--only': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('--only requires an invariant ID');
        parsed.only.push(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.strict) parsed.failOn = 'warning';
  return parsed;
}

function listInvariants(): void {
  console.log('Registered Trellis invariants:\n');
  for (const domain of INVARIANT_DOMAINS) {
    const inDomain = ALL_INVARIANTS.filter((invariant) => invariant.domain === domain);
    if (inDomain.length === 0) continue;
    console.log(`${domain}:`);
    for (const invariant of inDomain) {
      console.log(`  ${invariant.id.padEnd(11)} [${invariant.severity}] ${invariant.title}`);
    }
    console.log('');
  }
  console.log(`${ALL_INVARIANTS.length} invariants across ${INVARIANT_DOMAINS.length} domains.`);
}

function readSnapshot(path: string): unknown {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Snapshot not found: ${absolute}`);
  }
  const raw = readFileSync(absolute, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function main(): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run with --help for usage.');
    return EXIT_USAGE;
  }

  if (args.help) {
    printHelp();
    return EXIT_OK;
  }

  if (args.list) {
    listInvariants();
    return EXIT_OK;
  }

  const snapshotPath = args.file ?? DEFAULT_SNAPSHOT;

  let snapshot: unknown;
  try {
    snapshot = readSnapshot(snapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error(`Cannot read snapshot: ${message}`);
    return EXIT_USAGE;
  }

  const report = runInvariantMonitor(snapshot, {
    failOn: args.failOn,
    domains: args.domains.length > 0 ? args.domains : undefined,
    only: args.only.length > 0 ? args.only : undefined,
    source: args.file ?? DEFAULT_SNAPSHOT,
  });

  if (args.json) {
    console.log(renderJsonReport(report));
  } else {
    const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
    console.log(renderTextReport(report, { color: useColor }));
  }

  return report.ok ? EXIT_OK : EXIT_FAILED;
}

process.exitCode = main();
