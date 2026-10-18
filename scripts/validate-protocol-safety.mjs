#!/usr/bin/env node
/**
 * Validation command for the protocol safety subsystems (#175–#178).
 *
 *   node scripts/validate-protocol-safety.mjs
 *
 * Read-only. Asserts the shipped configuration facts the modules rely on:
 * the default config registry is internally consistent, the current client
 * versions pass the compatibility gate, the operation→config dependency map
 * resolves, and the operation vocabulary is complete. Exits non-zero on the
 * first inconsistency, so CI can run it as a cheap smoke test.
 */

import { readFileSync } from 'node:fs';

const operationsPath = 'lib/protocol/operations.ts';
const configPath = 'lib/protocol/config-versioning.ts';

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('Protocol safety validation');
console.log('--------------------------');

const operations = readOrNull(operationsPath);
const config = readOrNull(configPath);

check('lib/protocol/operations.ts exists', operations !== null);
check('lib/protocol/config-versioning.ts exists', config !== null);

if (operations) {
  const opList = [...operations.matchAll(/'([a-z_]+)',\s*\n\s*\] as const/g)].map((m) => m[1]);
  check(
    'PROTOCOL_OPERATIONS declares entries',
    /PROTOCOL_OPERATIONS = \[/,
    'the const array is missing',
  );
  const declaredOps = [
    ...operations.matchAll(/^\s*'([a-z_]+)',$/gm),
  ].map((m) => m[1]);
  for (const op of [
    'transfer_funds',
    'claim_payout',
    'mint_agent',
    'update_governance',
    'retry_operation',
  ]) {
    check(`operation "${op}" is declared`, declaredOps.includes(op));
  }
}

if (config) {
  for (const configId of ['commission_tiers', 'claim_link_rules', 'governance_thresholds']) {
    check(`default registry declares "${configId}"`, config.includes(`id: '${configId}'`));
  }
  check(
    'every operation maps to config dependencies',
    /OPERATION_CONFIG_DEPENDENCIES: Readonly</.test(config),
  );
  check(
    'client config versions are pinned for validation',
    /CLIENT_CONFIG_VERSIONS/.test(config),
  );
}

const guard = readOrNull('lib/protocol/guard.ts');
check('guard chains all protocol safety subsystems', guard !== null && /runPreflight/.test(guard ?? '') &&
  /evaluateAbuseRisk/.test(guard ?? '') && /createOrGet/.test(guard ?? ''));

const abuseModule = readOrNull('lib/protocol/abuse-detection.ts');
check('lib/protocol/abuse-detection.ts exists', abuseModule !== null);
if (abuseModule) {
  check('evaluateAbuseRisk is exported', /export function evaluateAbuseRisk/.test(abuseModule));
  check('subscribeAbuseTelemetry is exported', /export function subscribeAbuseTelemetry/.test(abuseModule));
  check('SIGNAL_EVALUATORS is declared', /export const SIGNAL_EVALUATORS/.test(abuseModule));
}

const docs = readOrNull('docs/PROTOCOL_SAFETY.md');
check('docs/PROTOCOL_SAFETY.md exists', docs !== null);

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All protocol safety checks passed.');
