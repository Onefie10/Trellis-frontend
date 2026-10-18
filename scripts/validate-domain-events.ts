#!/usr/bin/env node
/**
 * Trellis Frontend: domain event contract validation.
 *
 * Two jobs, both non-mutating and read-only:
 *
 *   1. Replay the recorded event fixtures in `tests/fixtures/domain-events/`
 *      through `parseDomainEvent`, so a contract change that would break a
 *      known-good or known-bad case fails with a readable diff. This is the
 *      same code path the Jest suite exercises, runnable in CI without a DOM.
 *   2. Report the catalog, which doubles as the machine-readable inventory a
 *      consumer reads to learn what it may rely on.
 *
 * Also verifies that every registered event is covered by a valid fixture, so a
 * newly registered event cannot ship without a recorded example.
 *
 * Usage:
 *   npm run validate:events            # replay fixtures
 *   npm run validate:events -- --json  # machine-readable output
 *   npm run validate:events -- --catalog
 *
 * See docs/DOMAIN_EVENTS.md for the versioning policy.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSnapshot,
  checkSchemaEvolution,
  collectCatalogProblems,
  type SchemaSnapshot,
  describeCatalog,
  listDomainEventDefinitions,
  parseDomainEvent,
  type CatalogLike,
  type DomainEventRejectionReason,
} from '../lib/domain-events';
import { DOMAIN_EVENTS } from '../lib/domain-events/registry';

const ROOT_DIR = resolve(fileURLToPath(import.meta.url), '../..');
const FIXTURE_DIR = resolve(ROOT_DIR, 'tests/fixtures/domain-events');
/** Historic schema descriptors for every published version. Update only when adding a version. */
const SNAPSHOT_PATH = resolve(ROOT_DIR, 'lib/domain-events/schema-snapshot.json');

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const colors = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  green: useColor ? '\x1b[32m' : '',
  red: useColor ? '\x1b[31m' : '',
  dim: useColor ? '\x1b[2m' : '',
};

interface FixtureCase {
  name: string;
  /** Per-case expectation. Omitted where the whole file shares `expectAll`. */
  expect?: 'accepted' | 'rejected';
  reason?: DomainEventRejectionReason;
  event: unknown;
}

interface FixtureFile {
  description: string;
  expectAll: 'accepted' | 'rejected';
  cases: FixtureCase[];
  nonObjectCases?: FixtureCase[];
}

interface Failure {
  fixture: string;
  case: string;
  expected: string;
  actual: string;
  detail: string;
}

function loadFixture(fileName: string): FixtureFile {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, fileName), 'utf-8')) as FixtureFile;
}

/**
 * Compare one recorded case against what the catalog says today. The
 * expectation falls back to the fixture file's `expectAll`, so a file of
 * all-valid or all-invalid cases does not have to repeat it per case.
 */
function checkCase(fixtureName: string, testCase: FixtureCase, fileExpectation: 'accepted' | 'rejected'): Failure | null {
  const expectation = testCase.expect ?? fileExpectation;
  const result = parseDomainEvent(testCase.event);

  if (result.status === expectation) {
    if (result.status === 'rejected' && testCase.reason && result.reason !== testCase.reason) {
      return {
        fixture: fixtureName,
        case: testCase.name,
        expected: `rejected (${testCase.reason})`,
        actual: `rejected (${result.reason})`,
        detail: 'The rejection reason changed. A consumer branching on the reason would behave differently.',
      };
    }
    return null;
  }

  return {
    fixture: fixtureName,
    case: testCase.name,
    expected: expectation,
    actual: result.status,
    detail:
      result.status === 'rejected' ? result.issues.join('; ') : 'the catalog accepted an event it should have refused',
  };
}

function checkCoverage(): Failure[] {
  const covered = new Set<string>();

  for (const fileName of readdirSync(FIXTURE_DIR).filter((entry) => entry.endsWith('.json'))) {
    const fixture = loadFixture(fileName);

    for (const testCase of [...fixture.cases, ...(fixture.nonObjectCases ?? [])]) {
      const event = testCase.event;
      if (event && typeof event === 'object' && !Array.isArray(event) && typeof event.name === 'string') {
        covered.add(event.name);
      }
    }
  }

  return listDomainEventDefinitions()
    .filter((definition) => !covered.has(definition.name))
    .map((definition) => ({
      fixture: 'coverage',
      case: definition.name,
      expected: 'covered by a valid fixture',
      actual: 'no fixture',
      detail:
        `No fixture in tests/fixtures/domain-events/ names "${definition.name}", so nothing pins its contract. ` +
        'Add an accepted case to valid-events.json.',
    }));
}

function main(): number {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const catalogOnly = args.includes('--catalog');

  const problems = collectCatalogProblems(DOMAIN_EVENTS as unknown as CatalogLike);
  const failures: Failure[] = problems.map((problem) => ({
    fixture: 'catalog',
    case: 'integrity',
    expected: 'valid catalog',
    actual: 'invalid catalog',
    detail: problem,
  }));

  if (args.includes('--update-snapshot')) {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(buildSnapshot(DOMAIN_EVENTS as unknown as CatalogLike), null, 2)}\n`);
    console.log(`Schema snapshot written to ${SNAPSHOT_PATH}`);
    return failures.length === 0 ? 0 : 1;
  }

  // Schema evolution: compare against the committed historic versions.
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as SchemaSnapshot;
  for (const problem of checkSchemaEvolution(DOMAIN_EVENTS as unknown as CatalogLike, snapshot)) {
    failures.push({
      fixture: 'schema-evolution',
      case: problem.event + (problem.from && problem.to && problem.from !== problem.to ? ` ${problem.from} -> ${problem.to}` : ''),
      expected: 'backward compatible schema evolution',
      actual: 'breaking change',
      detail: problem.message,
    });
  }

  let checked = 0;

  if (!catalogOnly) {
    for (const fileName of readdirSync(FIXTURE_DIR).filter((entry) => entry.endsWith('.json'))) {
      const fixture = loadFixture(fileName);

      for (const testCase of [...fixture.cases, ...(fixture.nonObjectCases ?? [])]) {
        checked += 1;
        const failure = checkCase(fileName, testCase, fixture.expectAll);
        if (failure) failures.push(failure);
      }
    }

    failures.push(...checkCoverage());
  }

  const catalog = describeCatalog();

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: failures.length === 0,
          events: catalog.length,
          casesChecked: checked,
          failures,
          catalog,
        },
        null,
        2,
      ),
    );
    return failures.length === 0 ? 0 : 1;
  }

  if (catalogOnly) {
    console.log(`${colors.bold}Registered domain events (${catalog.length}):${colors.reset}`);
    for (const entry of catalog) {
      console.log(
        `  ${colors.bold}${entry.name}${colors.reset} ${colors.dim}v${entry.version}${colors.reset} ` +
          `${colors.dim}(${entry.transport}, ${entry.stability}, readable: ${entry.readableVersions.join(', ')})${colors.reset}`,
      );
      console.log(`      ${entry.description}`);
    }
    console.log();
    return failures.length === 0 ? 0 : 1;
  }

  console.log(`${colors.bold}Domain event contract${colors.reset}`);
  console.log(`  ${catalog.length} registered events, ${checked} fixture cases replayed.`);
  console.log();

  if (failures.length === 0) {
    console.log(`${colors.green}✔ Every recorded case matches the catalog.${colors.reset}`);
    console.log(
      `${colors.dim}Consumers may rely on the versioning rules in docs/DOMAIN_EVENTS.md.${colors.reset}\n`,
    );
    return 0;
  }

  console.log(`${colors.red}${colors.bold}✖ ${failures.length} contract failure(s):${colors.reset}`);
  for (const failure of failures) {
    console.log(`  ${colors.red}[FAIL]${colors.reset} ${colors.bold}${failure.case}${colors.reset} ${colors.dim}(${failure.fixture})${colors.reset}`);
    console.log(`         expected ${failure.expected}, got ${failure.actual}`);
    console.log(`         ${colors.dim}${failure.detail}${colors.reset}`);
  }
  console.log();
  console.log(`${colors.dim}Contract regressions are breaking changes. See docs/DOMAIN_EVENTS.md.${colors.reset}\n`);
  return 1;
}

process.exit(main());
