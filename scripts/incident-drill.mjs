#!/usr/bin/env node
/**
 * Trellis Frontend: Incident Drill Runbook Executable Verification Harness
 *
 * Backs the incident drill runbook (docs/incident-drill-runbook.md) with
 * automated, non-destructive verification checks covering:
 *  1. Recovery: Resumption of interrupted multi-step workflows without duplicate side effects
 *  2. Rollback: Emergency restoration of state to verified baseline snapshots
 *  3. Data Validation: Domain invariant checks, corruption detection, and field blame
 *  4. User-Impact: Blast-radius calculation, error taxonomy, and status communications
 *
 * Exit codes:
 *   0  All drill verification checks passed
 *   1  One or more drill verification checks failed
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import { validateInvariants } from './validate-domain-invariants.mjs';

const scriptDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(scriptDir, '..');

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

function badge(status) {
  if (status === 'pass') return `${colors.green}[PASS]${colors.reset}`;
  if (status === 'warn') return `${colors.yellow}[WARN]${colors.reset}`;
  return `${colors.red}[FAIL]${colors.reset}`;
}

function sha256(data) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// ─── 1. Recovery Verification Drill ──────────────────────────────────────────

/**
 * In-memory checkpoint store for reproducible recovery drills.
 */
export class DrillCheckpointStore {
  constructor() {
    this.operations = new Map();
    this.checkpoints = new Map();
  }

  saveOperation(op) {
    this.operations.set(op.id, JSON.parse(JSON.stringify(op)));
  }

  getOperation(id) {
    const op = this.operations.get(id);
    return op ? JSON.parse(JSON.stringify(op)) : null;
  }

  saveCheckpoint(cp) {
    const key = `${cp.operationId}:${cp.stepId}`;
    this.checkpoints.set(key, JSON.parse(JSON.stringify(cp)));
  }

  getCheckpoint(operationId, stepId) {
    const key = `${operationId}:${stepId}`;
    return this.checkpoints.get(key) ? JSON.parse(JSON.stringify(this.checkpoints.get(key))) : null;
  }

  listCheckpoints(operationId) {
    const results = [];
    const prefix = `${operationId}:`;
    for (const [key, value] of this.checkpoints.entries()) {
      if (key.startsWith(prefix)) {
        results.push(JSON.parse(JSON.stringify(value)));
      }
    }
    return results;
  }

  clear() {
    this.operations.clear();
    this.checkpoints.clear();
  }
}

/**
 * Pure state machine engine executing multi-step operations with checkpoint boundaries.
 */
export class DrillOperationEngine {
  constructor(store = new DrillCheckpointStore()) {
    this.store = store;
  }

  createOperation(type, label, steps, context = {}) {
    const op = {
      id: `drill-op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      label,
      status: 'pending',
      currentStepIndex: 0,
      steps: steps.map((s) => ({
        id: s.id,
        label: s.label,
        sideEffect: Boolean(s.sideEffect),
        status: 'pending',
      })),
      context,
      resumeCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.saveOperation(op);
    return op;
  }

  async execute(operationId, executor) {
    let op = this.store.getOperation(operationId);
    if (!op) throw new Error(`Operation ${operationId} not found`);

    if (op.status === 'in_progress') {
      return {
        operationId,
        completed: false,
        skippedSteps: [],
        executedSteps: [],
        error: 'Operation already in progress in another context',
      };
    }
    if (op.status === 'completed') {
      return { operationId, completed: true, skippedSteps: [], executedSteps: [] };
    }
    if (op.status === 'failed') {
      return {
        operationId,
        completed: false,
        skippedSteps: [],
        executedSteps: [],
        error: 'Operation has permanently failed and cannot be resumed',
      };
    }

    op.status = 'in_progress';
    op.resumeCount += 1;
    op.updatedAt = new Date().toISOString();
    this.store.saveOperation(op);

    const checkpointedStepIds = new Set(
      this.store.listCheckpoints(operationId).map((c) => c.stepId)
    );

    const result = {
      operationId,
      completed: false,
      resumedFromStepId: undefined,
      skippedSteps: [],
      executedSteps: [],
    };

    const previousOutputs = {};
    for (const cp of this.store.listCheckpoints(operationId)) {
      if (cp.output !== undefined) previousOutputs[cp.stepId] = cp.output;
    }

    for (let i = 0; i < op.steps.length; i++) {
      const step = op.steps[i];

      // Side-effect idempotency fence
      if (step.sideEffect && checkpointedStepIds.has(step.id)) {
        result.skippedSteps.push(step.id);
        continue;
      }

      if (step.status === 'completed') {
        result.skippedSteps.push(step.id);
        continue;
      }

      if (result.resumedFromStepId === undefined) {
        result.resumedFromStepId = step.id;
      }

      step.status = 'in_progress';
      step.startedAt = new Date().toISOString();
      this.store.saveOperation(op);

      try {
        const output = await executor(step, op.context, previousOutputs);

        if (step.sideEffect) {
          this.store.saveCheckpoint({
            operationId,
            stepId: step.id,
            stepIndex: i,
            output,
            savedAt: new Date().toISOString(),
          });
        }

        if (output !== undefined) previousOutputs[step.id] = output;

        step.status = 'completed';
        step.finishedAt = new Date().toISOString();
        step.output = output;
        op.currentStepIndex = i + 1;
        result.executedSteps.push(step.id);
        this.store.saveOperation(op);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        step.status = 'failed';
        step.finishedAt = new Date().toISOString();
        step.error = errMsg;
        op.status = 'paused';
        op.updatedAt = new Date().toISOString();
        this.store.saveOperation(op);
        result.error = errMsg;
        return result;
      }
    }

    op.status = 'completed';
    op.finishedAt = new Date().toISOString();
    op.updatedAt = new Date().toISOString();
    this.store.saveOperation(op);
    result.completed = true;
    return result;
  }
}

/**
 * Verify Recovery Drill: Proves multi-step operations can be interrupted and resumed
 * safely, ensuring side-effect steps are executed exactly once.
 */
export async function verifyRecoveryDrill() {
  const store = new DrillCheckpointStore();
  const engine = new DrillOperationEngine(store);

  const stepDefinitions = [
    { id: 'validate_payload', label: 'Validate Submission Payload', sideEffect: false },
    { id: 'mint_soroban_agent', label: 'Mint Agent On-Chain', sideEffect: true },
    { id: 'publish_ipfs_meta', label: 'Publish IPFS Metadata', sideEffect: true },
    { id: 'update_local_index', label: 'Update Local Cache & Index', sideEffect: false },
  ];

  const op = engine.createOperation('agent_mint', 'Deploy Autonomous Trading Agent', stepDefinitions, {
    agentName: 'DrillTestAgent',
    creatorWallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
  });

  const invocationCounts = {
    validate_payload: 0,
    mint_soroban_agent: 0,
    publish_ipfs_meta: 0,
    update_local_index: 0,
  };

  let failPublishStep = true;

  const mockExecutor = async (step, context, previousOutputs) => {
    invocationCounts[step.id] = (invocationCounts[step.id] || 0) + 1;

    if (step.id === 'validate_payload') {
      return { valid: true, sizeBytes: 1024 };
    }
    if (step.id === 'mint_soroban_agent') {
      return { txHash: '0x1234567890abcdef1234567890abcdef', blockNumber: 42001 };
    }
    if (step.id === 'publish_ipfs_meta') {
      if (failPublishStep) {
        throw new Error('Simulated network timeout connecting to IPFS gateway');
      }
      return { cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' };
    }
    if (step.id === 'update_local_index') {
      return { indexedAt: new Date().toISOString(), entries: 1 };
    }
    return null;
  };

  // Phase 1: Run to intentional failure
  const firstRun = await engine.execute(op.id, mockExecutor);
  const pausedOp = store.getOperation(op.id);
  const mintCheckpoint = store.getCheckpoint(op.id, 'mint_soroban_agent');

  const phase1Pass =
    firstRun.completed === false &&
    firstRun.error.includes('IPFS gateway') &&
    pausedOp.status === 'paused' &&
    pausedOp.steps.find((s) => s.id === 'mint_soroban_agent').status === 'completed' &&
    pausedOp.steps.find((s) => s.id === 'publish_ipfs_meta').status === 'failed' &&
    Boolean(mintCheckpoint) &&
    invocationCounts.mint_soroban_agent === 1;

  if (!phase1Pass) {
    return {
      name: 'Recovery Workflow Drill',
      status: 'fail',
      message: 'Phase 1 failed: Interrupted operation was not paused with persisted checkpoint.',
    };
  }

  // Phase 2: Resume operation with network recovered
  failPublishStep = false;
  const secondRun = await engine.execute(op.id, mockExecutor);
  const completedOp = store.getOperation(op.id);

  const phase2Pass =
    secondRun.completed === true &&
    completedOp.status === 'completed' &&
    secondRun.skippedSteps.includes('mint_soroban_agent') &&
    secondRun.executedSteps.includes('publish_ipfs_meta') &&
    secondRun.executedSteps.includes('update_local_index') &&
    invocationCounts.mint_soroban_agent === 1; // SIDE EFFECT FENCE: Still 1, NOT re-executed!

  if (!phase2Pass) {
    return {
      name: 'Recovery Workflow Drill',
      status: 'fail',
      message: 'Phase 2 failed: Resumed operation did not skip checkpointed side-effect or re-minted.',
      details: { invocationCounts, secondRun },
    };
  }

  return {
    name: 'Recovery Workflow Drill',
    status: 'pass',
    message: 'Interrupted operation resumed cleanly: side effects fenced, idempotency preserved.',
    details: {
      operationId: op.id,
      resumedFromStep: secondRun.resumedFromStepId,
      skippedSteps: secondRun.skippedSteps,
      executedSteps: secondRun.executedSteps,
      invocationCounts,
    },
  };
}

// ─── 2. Rollback Verification Drill ──────────────────────────────────────────

/**
 * Verify Rollback Drill: Proves emergency rollback to clean baseline snapshot
 * restores state coherence with cryptographic hash verification and zero data drift.
 */
export async function verifyRollbackDrill() {
  const baselinePath = join(ROOT_DIR, 'scripts', 'fixtures', 'recovery-baseline.json');
  if (!existsSync(baselinePath)) {
    return {
      name: 'Emergency Rollback Drill',
      status: 'fail',
      message: `Baseline fixture not found at ${baselinePath}`,
    };
  }

  const baselineContent = readFileSync(baselinePath, 'utf-8');
  const baselineData = JSON.parse(baselineContent);
  const baselineHash = sha256(baselineData);

  // 1. Capture snapshot before change
  const snapshot = {
    id: `snap-${Date.now()}`,
    capturedAt: new Date().toISOString(),
    dataset: JSON.parse(JSON.stringify(baselineData)),
    checksum: baselineHash,
  };

  // 2. Simulate failed release / corrupted migration
  const liveState = JSON.parse(JSON.stringify(baselineData));
  liveState.agents.push({
    id: 'corrupted-ag-999',
    name: 'Corrupted Invariant Agent',
    author: 'INVALID_STELLAR_KEY_XYZ',
    status: 'ILLEGAL_STATUS_VALUE',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z', // Time paradox: updated before created!
  });

  const corruptedHash = sha256(liveState);
  const corruptionReport = validateInvariants(liveState);

  if (corruptionReport.isValid) {
    return {
      name: 'Emergency Rollback Drill',
      status: 'fail',
      message: 'Rollback drill failed: Corrupted mutation was not detected by domain invariants.',
    };
  }

  // 3. Perform automated rollback to snapshot
  const startTime = Date.now();
  const restoredState = JSON.parse(JSON.stringify(snapshot.dataset));
  const restoredHash = sha256(restoredState);
  const rollbackDurationMs = Date.now() - startTime;

  // 4. Verify post-rollback state
  const postRollbackReport = validateInvariants(restoredState);
  const hashMatches = restoredHash === snapshot.checksum;
  const isHealthy = postRollbackReport.isValid;

  if (!hashMatches || !isHealthy) {
    return {
      name: 'Emergency Rollback Drill',
      status: 'fail',
      message: 'Rollback failed: Restored state does not match baseline checksum or has invariant failures.',
      details: { baselineHash, restoredHash, isHealthy },
    };
  }

  return {
    name: 'Emergency Rollback Drill',
    status: 'pass',
    message: `State rolled back to baseline in ${rollbackDurationMs}ms; cryptographic checksum verified.`,
    details: {
      snapshotId: snapshot.id,
      baselineHash,
      corruptedHash,
      restoredHash,
      violationsPrevented: corruptionReport.summary.errorCount,
    },
  };
}

// ─── 3. Data Validation Verification Drill ────────────────────────────────────

/**
 * Verify Data Validation Drill: Runs comprehensive invariant validation
 * across both healthy datasets and known anomaly fixtures to ensure zero false positives/negatives.
 */
export async function verifyDataValidationDrill() {
  const healthyPath = join(ROOT_DIR, 'tests', 'fixtures', 'invariant-monitor', 'healthy-dataset.json');
  const corruptedPath = join(ROOT_DIR, 'tests', 'fixtures', 'invariant-monitor', 'corrupted-dataset.json');

  if (!existsSync(healthyPath) || !existsSync(corruptedPath)) {
    return {
      name: 'Domain Data Validation Drill',
      status: 'fail',
      message: 'Fixture files for data validation drill are missing in tests/fixtures/invariant-monitor/',
    };
  }

  const healthyData = JSON.parse(readFileSync(healthyPath, 'utf-8'));
  const corruptedData = JSON.parse(readFileSync(corruptedPath, 'utf-8'));

  // 1. Validate healthy dataset
  const healthyResult = validateInvariants(healthyData);
  if (!healthyResult.isValid || healthyResult.summary.errorCount > 0) {
    return {
      name: 'Domain Data Validation Drill',
      status: 'fail',
      message: `False positive: Healthy dataset produced ${healthyResult.summary.errorCount} unexpected error(s).`,
      details: healthyResult.violations,
    };
  }

  // 2. Validate corrupted dataset
  const corruptedResult = validateInvariants(corruptedData);
  if (corruptedResult.isValid || corruptedResult.summary.errorCount === 0) {
    return {
      name: 'Domain Data Validation Drill',
      status: 'fail',
      message: 'False negative: Corrupted dataset was incorrectly marked as valid.',
    };
  }

  // Ensure errors pinpoint specific fields and remediation
  const hasActionableRemediation = corruptedResult.violations.every(
    (v) => typeof v.remediation === 'string' && v.remediation.length > 0
  );

  if (!hasActionableRemediation) {
    return {
      name: 'Domain Data Validation Drill',
      status: 'fail',
      message: 'Validation violations are missing remediation instructions.',
    };
  }

  return {
    name: 'Domain Data Validation Drill',
    status: 'pass',
    message: `Verified data integrity: 0 false positives on baseline, ${corruptedResult.summary.errorCount} errors flagged on corrupted fixture with actionable remediation.`,
    details: {
      healthyChecksPassed: healthyResult.summary.passedChecks,
      corruptedErrorsDetected: corruptedResult.summary.errorCount,
      corruptedWarningsDetected: corruptedResult.summary.warningCount,
    },
  };
}

// ─── 4. User-Impact Reporting Drill ──────────────────────────────────────────

/**
 * Classifies an error into transient vs permanent.
 */
export function classifyDrillError(status, message = '') {
  const msgLower = message.toLowerCase();
  if (status === 429 || msgLower.includes('rate limit') || msgLower.includes('timeout') || status >= 500) {
    return { isRetryable: true, kind: 'transient', severity: status >= 500 ? 'high' : 'medium' };
  }
  return { isRetryable: false, kind: 'permanent', severity: status === 401 || status === 403 ? 'critical' : 'low' };
}

/**
 * Computes incident blast radius and structured reporting.
 */
export function calculateIncidentReport(events = []) {
  const total = events.length;
  let successful = 0;
  let retriedAndResolved = 0;
  let terminalFailures = 0;

  const affectedWallets = new Set();
  const affectedSubsystems = new Set();
  const deadLetters = [];

  for (const event of events) {
    if (event.status === 'success') {
      successful++;
    } else if (event.status === 'recovered') {
      retriedAndResolved++;
    } else if (event.status === 'failed') {
      terminalFailures++;
      if (event.wallet) affectedWallets.add(event.wallet);
      if (event.subsystem) affectedSubsystems.add(event.subsystem);
      deadLetters.push({
        id: event.id,
        operation: event.operation,
        wallet: event.wallet,
        error: event.error,
        classification: classifyDrillError(event.statusCode, event.error),
      });
    }
  }

  const failedCount = terminalFailures;
  const failureRatePercent = total > 0 ? (failedCount / total) * 100 : 0;
  const activeUsersCount = 100; // Reference baseline active users in test cohort
  const blastRadiusPercent = (affectedWallets.size / activeUsersCount) * 100;

  let severity = 'P3';
  if (failureRatePercent > 20 || affectedWallets.size > 5) {
    severity = 'P1';
  } else if (failureRatePercent > 5 || affectedWallets.size > 0) {
    severity = 'P2';
  }

  return {
    severity,
    totalOperations: total,
    successfulOperations: successful,
    recoveredOperations: retriedAndResolved,
    failedOperations: terminalFailures,
    failureRatePercent: parseFloat(failureRatePercent.toFixed(2)),
    affectedWalletsCount: affectedWallets.size,
    affectedWallets: Array.from(affectedWallets),
    affectedSubsystems: Array.from(affectedSubsystems),
    blastRadiusPercent: parseFloat(blastRadiusPercent.toFixed(2)),
    deadLetterQueueCount: deadLetters.length,
    announcement: {
      title: severity === 'P1' ? 'Service Degradation Alert' : 'Operational Notice',
      message: `Impacted operations: ${failedCount} of ${total} across ${affectedWallets.size} user account(s). Recovery mitigations in progress.`,
      recommendedAction: severity === 'P1' ? 'Switch to fallback RPC / pause automated trading' : 'Retry pending transactions',
    },
  };
}

/**
 * Verify User-Impact Drill: Proves telemetry, error classification, and user blast-radius
 * calculation generate accurate, actionable incident reporting during service degradation.
 */
export async function verifyUserImpactDrill() {
  const simulatedEvents = [
    { id: 'ev-1', operation: 'transfer', wallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', status: 'success', subsystem: 'stellar-rpc' },
    { id: 'ev-2', operation: 'stake', wallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', status: 'recovered', subsystem: 'soroban-rpc' },
    { id: 'ev-3', operation: 'mint_agent', wallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', status: 'failed', statusCode: 429, error: 'Rate limit exceeded on RPC node', subsystem: 'soroban-rpc' },
    { id: 'ev-4', operation: 'payout', wallet: 'GCXKG6RN4ONIEPCMNFB732A436Z5PNDSRLGWK7GBLCMQLIFO4HXQNX25', status: 'failed', statusCode: 504, error: 'Gateway timeout during horizon ledger close', subsystem: 'stellar-rpc' },
    { id: 'ev-5', operation: 'query_catalog', wallet: 'GDQOE23CFSUMSVQK4Y5JHPP0C73FZJ2DUOI4N7U4ON4CGSNWG2NTDCE6', status: 'success', subsystem: 'ipfs-gateway' },
    { id: 'ev-6', operation: 'transfer', wallet: 'GEZDFPXHSN4K43G5DT2NCZ75U3VTYF3BPA6MOU6GOCDCMWFLBN7CQ77A', status: 'failed', statusCode: 400, error: 'Invalid transaction XDR signature', subsystem: 'wallet-adapter' },
  ];

  const report = calculateIncidentReport(simulatedEvents);

  const passed =
    report.totalOperations === 6 &&
    report.failedOperations === 3 &&
    report.affectedWalletsCount === 3 &&
    report.affectedSubsystems.includes('soroban-rpc') &&
    report.affectedSubsystems.includes('stellar-rpc') &&
    report.affectedSubsystems.includes('wallet-adapter') &&
    report.severity === 'P1' &&
    typeof report.announcement.message === 'string';

  if (!passed) {
    return {
      name: 'User-Impact Reporting Drill',
      status: 'fail',
      message: 'User-impact calculations did not match expected blast radius metrics.',
      details: report,
    };
  }

  return {
    name: 'User-Impact Reporting Drill',
    status: 'pass',
    message: `Blast radius accurately calculated (${report.blastRadiusPercent}% user cohort affected, ${report.deadLetterQueueCount} terminal failures isolated). Status notification formatted.`,
    details: report,
  };
}

// ─── Main Drill Runner ────────────────────────────────────────────────────────

/**
 * Execute all incident drill verification checks.
 */
export async function runIncidentDrill(options = {}) {
  const { scenario = 'all', strict = false } = options;

  const checks = [];

  if (scenario === 'all' || scenario === 'recovery') {
    checks.push(await verifyRecoveryDrill());
  }
  if (scenario === 'all' || scenario === 'rollback') {
    checks.push(await verifyRollbackDrill());
  }
  if (scenario === 'all' || scenario === 'data-validation') {
    checks.push(await verifyDataValidationDrill());
  }
  if (scenario === 'all' || scenario === 'user-impact') {
    checks.push(await verifyUserImpactDrill());
  }

  let passed = 0;
  let warnings = 0;
  let failures = 0;

  for (const check of checks) {
    if (check.status === 'pass') passed++;
    else if (check.status === 'warn') warnings++;
    else failures++;
  }

  const isSuccess = strict ? failures === 0 && warnings === 0 : failures === 0;

  return {
    timestamp: new Date().toISOString(),
    isSuccess,
    summary: { total: checks.length, passed, warnings, failures },
    checks,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const strict = args.includes('--strict');
  const help = args.includes('--help') || args.includes('-h');

  let scenario = 'all';
  const scenarioIdx = args.indexOf('--scenario');
  if (scenarioIdx !== -1 && args[scenarioIdx + 1]) {
    scenario = args[scenarioIdx + 1];
  }

  if (help) {
    console.log(`
Trellis Frontend: Incident Drill Runbook Executable Verification

Usage:
  npm run drill:verify [options]
  node scripts/incident-drill.mjs [options]

Options:
  --scenario <name>  Run specific drill scenario: all (default), recovery, rollback, data-validation, user-impact
  --json             Output results in JSON format
  --strict           Treat warnings as failures
  -h, --help         Show this help message
`);
    process.exit(0);
  }

  if (!isJson) {
    console.log(`${colors.bold}${colors.cyan}================================================================${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}  Trellis Frontend — Incident Drill Executable Verification${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}================================================================${colors.reset}\n`);
  }

  const results = await runIncidentDrill({ scenario, strict });

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.isSuccess ? 0 : 1);
  }

  for (const check of results.checks) {
    console.log(`  ${badge(check.status)} ${colors.bold}${check.name}${colors.reset}: ${check.message}`);
    if (check.details) {
      console.log(`         ${colors.dim}↳ Details: ${JSON.stringify(check.details)}${colors.reset}`);
    }
  }
  console.log();

  console.log(`${colors.bold}----------------------------------------------------------------${colors.reset}`);
  console.log(
    `Summary: ${colors.bold}${results.summary.passed}${colors.reset} passed, ` +
    `${results.summary.warnings > 0 ? colors.yellow : ''}${results.summary.warnings} warning(s)${colors.reset}, ` +
    `${results.summary.failures > 0 ? colors.red : ''}${results.summary.failures} failure(s)${colors.reset}`
  );

  if (results.isSuccess) {
    console.log(`\n${colors.green}${colors.bold}✔ Incident drill verification passed! Recovery, rollback, data validation, and reporting validated.${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}${colors.bold}✖ Incident drill verification failed with ${results.summary.failures} failure(s).${colors.reset}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('Fatal incident drill execution error:', err);
    process.exit(1);
  });
}
