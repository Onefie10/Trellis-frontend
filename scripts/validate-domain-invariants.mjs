#!/usr/bin/env node
/**
 * Trellis Frontend: Disaster Recovery Domain Invariant Validation
 *
 * Reads domain datasets (either default baseline fixture or external snapshot JSON)
 * and validates critical domain invariants:
 * - Uniqueness & Primary Key Consistency
 * - Relational Integrity (no orphaned executions or references)
 * - Settlement & Financial Rules (Stellar addresses, payout minimums, balance constraints)
 * - Schema & Enum Conformity
 * - Chronology & Timestamp Consistency
 *
 * This command is strictly non-mutating and read-only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(process.cwd());

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const colors = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  dim: useColor ? '\x1b[2m' : '',
  magenta: useColor ? '\x1b[35m' : '',
};

export const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
export const MINIMUM_PAYOUT_XLM = 100.0;

function isValidIsoDate(str) {
  if (typeof str !== 'string') return false;
  const timestamp = Date.parse(str);
  return !Number.isNaN(timestamp);
}

/**
 * Validates domain invariants across a domain dataset.
 * Pure function: non-mutating and read-only.
 */
export function validateInvariants(dataset = {}, options = {}) {
  const violations = [];
  let totalChecks = 0;

  const agents = Array.isArray(dataset.agents) ? dataset.agents : [];
  const testCases = Array.isArray(dataset.testCases) ? dataset.testCases : [];
  const testExecutions = Array.isArray(dataset.testExecutions) ? dataset.testExecutions : [];
  const provenanceRecords = Array.isArray(dataset.provenanceRecords) ? dataset.provenanceRecords : [];
  const referralCodes = Array.isArray(dataset.referralCodes) ? dataset.referralCodes : [];
  const referrals = Array.isArray(dataset.referrals) ? dataset.referrals : [];
  const payouts = Array.isArray(dataset.payouts) ? dataset.payouts : [];
  const earningsLedger = Array.isArray(dataset.earningsLedger) ? dataset.earningsLedger : [];
  const bugReports = Array.isArray(dataset.bugReports) ? dataset.bugReports : [];

  const entitiesScanned = {
    agents: agents.length,
    testCases: testCases.length,
    testExecutions: testExecutions.length,
    provenanceRecords: provenanceRecords.length,
    referralCodes: referralCodes.length,
    referrals: referrals.length,
    payouts: payouts.length,
    bugReports: bugReports.length,
  };

  const check = () => {
    totalChecks++;
  };

  // 1. Uniqueness Checks
  function checkUniqueness(items, entityType) {
    const seen = new Set();
    for (const item of items) {
      check();
      if (!item || !item.id || String(item.id).trim() === '') {
        violations.push({
          code: 'DUPLICATE_ID',
          category: 'uniqueness',
          entityType,
          entityId: 'UNKNOWN',
          severity: 'error',
          message: `Empty or missing primary key ID encountered in ${entityType}`,
          remediation: `Ensure all ${entityType} records have valid, unique primary identifiers.`,
        });
        continue;
      }
      const id = String(item.id);
      if (seen.has(id)) {
        violations.push({
          code: 'DUPLICATE_ID',
          category: 'uniqueness',
          entityType,
          entityId: id,
          severity: 'error',
          message: `Duplicate ${entityType} identifier detected: '${id}'`,
          remediation: `Deduplicate or re-index ${entityType} records before proceeding with restoration.`,
        });
      } else {
        seen.add(id);
      }
    }
  }

  checkUniqueness(agents, 'Agent');
  checkUniqueness(testCases, 'TestCase');
  checkUniqueness(testExecutions, 'TestExecution');
  checkUniqueness(provenanceRecords, 'ProvenanceRecord');
  checkUniqueness(referrals, 'ReferralRecord');
  checkUniqueness(payouts, 'PayoutRequest');
  checkUniqueness(bugReports, 'BugReport');

  const seenCodes = new Set();
  for (const rc of referralCodes) {
    check();
    if (seenCodes.has(rc.code)) {
      violations.push({
        code: 'DUPLICATE_ID',
        category: 'uniqueness',
        entityType: 'ReferralCode',
        entityId: rc.code,
        severity: 'error',
        message: `Duplicate referral code detected: '${rc.code}'`,
        remediation: 'Ensure referral codes are globally unique in affiliate registry.',
      });
    } else {
      seenCodes.add(rc.code);
    }
  }

  // 2. Relational Integrity Checks
  const testCaseIdSet = new Set(testCases.map((tc) => tc.id));
  for (const te of testExecutions) {
    check();
    if (!testCaseIdSet.has(te.testCaseId)) {
      violations.push({
        code: 'ORPHANED_RECORD',
        category: 'relational_integrity',
        entityType: 'TestExecution',
        entityId: te.id,
        severity: 'error',
        message: `Orphaned TestExecution '${te.id}': testCaseId '${te.testCaseId}' does not exist in test cases repository`,
        remediation: `Restore missing TestCase '${te.testCaseId}' or purge orphaned execution records.`,
        details: { testCaseId: te.testCaseId },
      });
    }
  }

  const codeOwnerMap = new Map(referralCodes.map((rc) => [rc.code, rc.ownerWallet]));
  for (const ref of referrals) {
    check();
    if (referralCodes.length > 0 && !codeOwnerMap.has(ref.referralCode)) {
      violations.push({
        code: 'ORPHANED_RECORD',
        category: 'relational_integrity',
        entityType: 'ReferralRecord',
        entityId: ref.id,
        severity: 'error',
        message: `Referral record '${ref.id}' references unknown referralCode '${ref.referralCode}'`,
        remediation: `Verify affiliate registry contains code '${ref.referralCode}'.`,
        details: { referralCode: ref.referralCode },
      });
    }

    const owner = codeOwnerMap.get(ref.referralCode);
    if (owner && owner === ref.referredUserAddress) {
      check();
      violations.push({
        code: 'SELF_REFERRAL_VIOLATION',
        category: 'relational_integrity',
        entityType: 'ReferralRecord',
        entityId: ref.id,
        severity: 'error',
        message: `Self-referral invariant breached on record '${ref.id}': owner '${owner}' referred themselves`,
        remediation: 'Disqualify self-referral record and adjust affiliate ledger accordingly.',
        details: { wallet: owner },
      });
    }
  }

  // 3. Settlement & Financial Integrity Checks
  for (const payout of payouts) {
    check();
    if (!payout.walletAddress || !STELLAR_ADDRESS_RE.test(payout.walletAddress)) {
      violations.push({
        code: 'INVALID_STELLAR_ADDRESS',
        category: 'settlement_and_financial',
        entityType: 'PayoutRequest',
        entityId: payout.id,
        severity: 'error',
        message: `Payout '${payout.id}' contains invalid Stellar wallet address: '${payout.walletAddress}'`,
        remediation: 'Correct recipient wallet address to a valid G... Stellar public key.',
      });
    }

    check();
    const amount = parseFloat(payout.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      violations.push({
        code: 'INVALID_NUMERIC_METRIC',
        category: 'settlement_and_financial',
        entityType: 'PayoutRequest',
        entityId: payout.id,
        severity: 'error',
        message: `Payout '${payout.id}' contains invalid amount '${payout.amount}'`,
        remediation: 'Ensure payout amount is a valid positive number.',
      });
    } else if (amount < MINIMUM_PAYOUT_XLM) {
      violations.push({
        code: 'FINANCIAL_BALANCE_VIOLATION',
        category: 'settlement_and_financial',
        entityType: 'PayoutRequest',
        entityId: payout.id,
        severity: 'warning',
        message: `Payout '${payout.id}' amount (${amount} XLM) is below minimum threshold of ${MINIMUM_PAYOUT_XLM} XLM`,
        remediation: `Adjust payout to meet the minimum threshold of ${MINIMUM_PAYOUT_XLM} XLM.`,
      });
    }

    check();
    if (payout.status === 'completed' && (!payout.transactionHash || payout.transactionHash.trim() === '')) {
      violations.push({
        code: 'SETTLEMENT_REFERENCE_MISSING',
        category: 'settlement_and_financial',
        entityType: 'PayoutRequest',
        entityId: payout.id,
        severity: 'error',
        message: `Completed payout '${payout.id}' is missing on-chain transaction settlement reference (transactionHash)`,
        remediation: 'Verify on-chain settlement status and attach transaction hash.',
      });
    }
  }

  for (const prov of provenanceRecords) {
    if (prov.action === 'on_chain_submission') {
      check();
      if (!prov.txHash || prov.txHash.trim() === '') {
        violations.push({
          code: 'SETTLEMENT_REFERENCE_MISSING',
          category: 'settlement_and_financial',
          entityType: 'ProvenanceRecord',
          entityId: prov.id,
          severity: 'error',
          message: `On-chain submission provenance record '${prov.id}' is missing txHash`,
          remediation: 'Attach blockchain transaction hash to on-chain action record.',
        });
      }
    }
  }

  const earnedMap = new Map(earningsLedger.map((e) => [e.wallet, e.earnedXlm]));
  const completedPayoutsByWallet = new Map();
  for (const p of payouts) {
    if (p.status === 'completed') {
      const current = completedPayoutsByWallet.get(p.walletAddress) ?? 0;
      completedPayoutsByWallet.set(p.walletAddress, current + (parseFloat(p.amount) || 0));
    }
  }

  for (const [wallet, totalPaid] of completedPayoutsByWallet.entries()) {
    check();
    const totalEarned = earnedMap.get(wallet);
    if (totalEarned !== undefined && totalPaid > totalEarned) {
      violations.push({
        code: 'FINANCIAL_BALANCE_VIOLATION',
        category: 'settlement_and_financial',
        entityType: 'EarningsLedger',
        entityId: wallet,
        severity: 'error',
        message: `Financial balance invariant breached for wallet '${wallet}': total completed payouts (${totalPaid} XLM) exceed cumulative credited earnings (${totalEarned} XLM)`,
        remediation: 'Audit payout history and freeze anomalous affiliate balances.',
        details: { wallet, totalPaid, totalEarned },
      });
    }
  }

  // 4. Schema & Enums Checks
  const validAgentStatuses = new Set(['active', 'inactive', 'draft']);
  for (const a of agents) {
    check();
    if (!validAgentStatuses.has(a.status)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'Agent',
        entityId: a.id,
        severity: 'error',
        message: `Agent '${a.id}' has invalid status '${a.status}' (expected: active, inactive, draft)`,
        remediation: 'Update agent status to a recognized enum value.',
      });
    }
  }

  const validExecutionStatuses = new Set(['pending', 'running', 'completed', 'failed']);
  for (const te of testExecutions) {
    check();
    if (!validExecutionStatuses.has(te.status)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'TestExecution',
        entityId: te.id,
        severity: 'error',
        message: `TestExecution '${te.id}' has invalid status '${te.status}' (expected: pending, running, completed, failed)`,
        remediation: 'Normalize execution status to valid domain enum.',
      });
    }

    check();
    if (typeof te.qualityScore === 'number') {
      if (te.qualityScore < 0 || te.qualityScore > 100) {
        violations.push({
          code: 'INVALID_NUMERIC_METRIC',
          category: 'schema_and_enums',
          entityType: 'TestExecution',
          entityId: te.id,
          severity: 'error',
          message: `Quality score for TestExecution '${te.id}' (${te.qualityScore}) out of bounds [0, 100]`,
          remediation: 'Clamp quality score to valid range 0 to 100.',
        });
      }
    }

    if (te.metrics) {
      check();
      const m = te.metrics;
      if (
        m.cpuInstructions < 0 ||
        m.ramBytes < 0 ||
        m.ledgerReadBytes < 0 ||
        m.ledgerWriteBytes < 0 ||
        m.readCount < 0 ||
        m.writeCount < 0
      ) {
        violations.push({
          code: 'INVALID_NUMERIC_METRIC',
          category: 'schema_and_enums',
          entityType: 'TestExecution',
          entityId: te.id,
          severity: 'error',
          message: `Negative resource metrics detected in TestExecution '${te.id}'`,
          remediation: 'Inspect benchmark collector and ensure metrics cannot be negative.',
        });
      }
    }
  }

  const validProvenanceStatuses = new Set(['success', 'failure', 'pending']);
  const validProvenanceActions = new Set([
    'input_received',
    'provider_call',
    'on_chain_submission',
    'output_generated',
    'error_encountered',
  ]);
  for (const pr of provenanceRecords) {
    check();
    if (!validProvenanceStatuses.has(pr.status)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'ProvenanceRecord',
        entityId: pr.id,
        severity: 'error',
        message: `Provenance record '${pr.id}' has invalid status '${pr.status}'`,
        remediation: 'Normalize provenance record status enum.',
      });
    }
    check();
    if (!validProvenanceActions.has(pr.action)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'ProvenanceRecord',
        entityId: pr.id,
        severity: 'error',
        message: `Provenance record '${pr.id}' has invalid action '${pr.action}'`,
        remediation: 'Normalize provenance action enum.',
      });
    }
  }

  const validPayoutStatuses = new Set(['pending', 'processing', 'completed', 'failed']);
  for (const p of payouts) {
    check();
    if (!validPayoutStatuses.has(p.status)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'PayoutRequest',
        entityId: p.id,
        severity: 'error',
        message: `PayoutRequest '${p.id}' has invalid status '${p.status}'`,
        remediation: 'Normalize payout status enum.',
      });
    }
  }

  const validBugStatuses = new Set(['submitted', 'under_review', 'in_progress', 'resolved', 'rejected']);
  const validBugPriorities = new Set(['low', 'medium', 'high', 'critical']);
  for (const br of bugReports) {
    check();
    if (!validBugStatuses.has(br.status)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'BugReport',
        entityId: br.id,
        severity: 'error',
        message: `BugReport '${br.id}' has invalid status '${br.status}'`,
        remediation: 'Normalize bug report status enum.',
      });
    }
    check();
    if (!validBugPriorities.has(br.priority)) {
      violations.push({
        code: 'INVALID_STATUS_ENUM',
        category: 'schema_and_enums',
        entityType: 'BugReport',
        entityId: br.id,
        severity: 'error',
        message: `BugReport '${br.id}' has invalid priority '${br.priority}'`,
        remediation: 'Normalize bug report priority enum.',
      });
    }
  }

  // 5. Chronology & Timestamp Checks
  for (const te of testExecutions) {
    check();
    if (!isValidIsoDate(te.startTime)) {
      violations.push({
        code: 'INVALID_TIMESTAMP_FORMAT',
        category: 'chronology_and_timestamps',
        entityType: 'TestExecution',
        entityId: te.id,
        severity: 'error',
        message: `TestExecution '${te.id}' has malformed startTime: '${te.startTime}'`,
        remediation: 'Format timestamp as valid ISO-8601 string.',
      });
    }
    if (te.endTime) {
      check();
      if (!isValidIsoDate(te.endTime)) {
        violations.push({
          code: 'INVALID_TIMESTAMP_FORMAT',
          category: 'chronology_and_timestamps',
          entityType: 'TestExecution',
          entityId: te.id,
          severity: 'error',
          message: `TestExecution '${te.id}' has malformed endTime: '${te.endTime}'`,
          remediation: 'Format timestamp as valid ISO-8601 string.',
        });
      } else if (Date.parse(te.endTime) < Date.parse(te.startTime)) {
        violations.push({
          code: 'TIMESTAMP_CHRONOLOGY_VIOLATION',
          category: 'chronology_and_timestamps',
          entityType: 'TestExecution',
          entityId: te.id,
          severity: 'error',
          message: `TestExecution '${te.id}' chronology inverted: endTime (${te.endTime}) precedes startTime (${te.startTime})`,
          remediation: 'Correct execution interval timestamps.',
        });
      }
    }
  }

  for (const br of bugReports) {
    check();
    if (isValidIsoDate(br.createdAt) && isValidIsoDate(br.updatedAt)) {
      if (Date.parse(br.updatedAt) < Date.parse(br.createdAt)) {
        violations.push({
          code: 'TIMESTAMP_CHRONOLOGY_VIOLATION',
          category: 'chronology_and_timestamps',
          entityType: 'BugReport',
          entityId: br.id,
          severity: 'error',
          message: `BugReport '${br.id}' updatedAt (${br.updatedAt}) is earlier than createdAt (${br.createdAt})`,
          remediation: 'Ensure update timestamp is greater than or equal to creation timestamp.',
        });
      }
    }
  }

  for (const ref of referrals) {
    if (ref.convertedAt && isValidIsoDate(ref.createdAt) && isValidIsoDate(ref.convertedAt)) {
      check();
      if (Date.parse(ref.convertedAt) < Date.parse(ref.createdAt)) {
        violations.push({
          code: 'TIMESTAMP_CHRONOLOGY_VIOLATION',
          category: 'chronology_and_timestamps',
          entityType: 'ReferralRecord',
          entityId: ref.id,
          severity: 'error',
          message: `Referral '${ref.id}' convertedAt (${ref.convertedAt}) is earlier than createdAt (${ref.createdAt})`,
          remediation: 'Ensure conversion timestamp follows creation timestamp.',
        });
      }
    }
  }

  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warningCount = violations.filter((v) => v.severity === 'warning').length;
  const passedChecks = Math.max(0, totalChecks - violations.length);
  const isValid = options.strict ? errorCount === 0 && warningCount === 0 : errorCount === 0;

  return {
    timestamp: new Date().toISOString(),
    isValid,
    summary: {
      totalChecks,
      passedChecks,
      errorCount,
      warningCount,
      entitiesScanned,
    },
    violations,
  };
}

/**
 * Loads baseline or specified file dataset
 */
export function loadDataset(filePath) {
  const targetPath = filePath
    ? resolve(filePath)
    : join(ROOT_DIR, 'scripts', 'fixtures', 'recovery-baseline.json');

  if (!existsSync(targetPath)) {
    throw new Error(`Domain dataset file not found: ${targetPath}`);
  }

  const raw = readFileSync(targetPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse dataset JSON: ${err.message}`);
  }
}

/**
 * CLI Main Runner
 */
async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const strict = args.includes('--strict');
  const help = args.includes('--help') || args.includes('-h');

  let fileIdx = args.indexOf('--file');
  if (fileIdx === -1) fileIdx = args.indexOf('-f');
  const customFilePath = fileIdx !== -1 && args[fileIdx + 1] ? args[fileIdx + 1] : null;

  if (help) {
    console.log(`
Trellis Disaster Recovery Domain Invariant Validation

Usage:
  npm run validate:invariants [options]
  node scripts/validate-domain-invariants.mjs [options]

Options:
  --file, -f <path>  Path to external domain snapshot JSON file to validate
  --json             Output results in machine-readable JSON format
  --strict           Treat warnings as validation failures (exit code 1)
  -h, --help         Show this help message
`);
    process.exit(0);
  }

  if (!isJson) {
    console.log(`${colors.bold}${colors.cyan}================================================================${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}   Trellis — Disaster Recovery Domain Invariant Validator${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}================================================================${colors.reset}\n`);
    console.log(`${colors.dim}Target source: ${customFilePath ? customFilePath : 'Default Recovery Baseline Fixture'}${colors.reset}\n`);
  }

  let dataset;
  try {
    dataset = loadDataset(customFilePath);
  } catch (err) {
    if (isJson) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`${colors.red}${colors.bold}Error loading dataset:${colors.reset} ${err.message}`);
    }
    process.exit(1);
  }

  const report = validateInvariants(dataset, { strict });

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.isValid ? 0 : 1);
  }

  // Display scanned entities
  console.log(`${colors.bold}Entities Scanned:${colors.reset}`);
  for (const [entity, count] of Object.entries(report.summary.entitiesScanned)) {
    console.log(`  - ${entity}: ${colors.bold}${count}${colors.reset}`);
  }
  console.log();

  if (report.violations.length === 0) {
    console.log(`${colors.green}${colors.bold}✔ 100% of domain invariants PASSED (${report.summary.totalChecks} checks).${colors.reset}`);
    console.log(`${colors.green}All core domain invariants, relationships, and settlement references are consistent.${colors.reset}\n`);
    process.exit(0);
  }

  console.log(`${colors.bold}Invariant Violations (${report.violations.length}):${colors.reset}`);
  for (const v of report.violations) {
    const badge = v.severity === 'error' ? `${colors.red}[ERROR]` : `${colors.yellow}[WARN]`;
    console.log(`  ${badge} ${colors.bold}${v.code}${colors.reset} (${colors.magenta}${v.category}${colors.reset}) on ${colors.bold}${v.entityType}#${v.entityId}${colors.reset}`);
    console.log(`         ${v.message}`);
    console.log(`         ${colors.dim}↳ Remediation: ${v.remediation}${colors.reset}`);
  }
  console.log();

  console.log(`${colors.bold}----------------------------------------------------------------${colors.reset}`);
  console.log(
    `Summary: ${colors.bold}${report.summary.passedChecks}${colors.reset} passed, ` +
    `${report.summary.warningCount > 0 ? colors.yellow : ''}${report.summary.warningCount} warning(s)${colors.reset}, ` +
    `${report.summary.errorCount > 0 ? colors.red : ''}${report.summary.errorCount} error(s)${colors.reset}`
  );

  if (report.isValid) {
    console.log(`\n${colors.green}${colors.bold}✔ Validation passed (no critical errors).${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}${colors.bold}✖ Disaster recovery validation FAILED with ${report.summary.errorCount} error(s).${colors.reset}`);
    console.log(`${colors.red}Follow the escalation steps in docs/DISASTER_RECOVERY.md before completing restore.${colors.reset}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('Fatal validation error:', err);
    process.exit(1);
  });
}
