/**
 * Deterministic transaction simulation preflight for high-risk operations
 * (#175).
 *
 * Before a user is asked to sign a high-risk operation, the operation runs
 * through a set of pure rule checks. The result is one of three user-facing
 * verdicts:
 *
 *   `success`   — no problems found; the operation may be submitted
 *   `warning`   — the operation may proceed but the user must be shown why it
 *                 is risky and how to fix it (remediation steps)
 *   `blocked`   — a known-invalid operation; the UI must refuse to submit
 *
 * Determinism: every rule is a pure function of the request and the state
 * snapshot, time is injected, and rule order is fixed — the same inputs always
 * produce the same result, in tests and in production. No network calls, no
 * randomness, no reliance on wall-clock `Date.now()`.
 *
 * Composition: `runPreflight` executes the declared rules for an operation,
 * folds them into one verdict (`blocked` beats `warning` beats `success`),
 * and integrates the emergency-pause gate (#177) as the first rule so a paused
 * operation is always `blocked` regardless of anything else, plus the config
 * compatibility gate (#178) so an operation never runs against configuration
 * it was not validated for.
 */

import {
  getConfigDeprecationWarning,
  OPERATION_CONFIG_DEPENDENCIES,
  validateProtocolCompatibility,
  type CompatibilityWarning,
  type ProtocolConfigRegistry,
} from './config-versioning';
import type { PauseManager } from './emergency-pause';
import { shortFingerprint } from './canonical';
import type {
  ProtocolEnvironment,
  ProtocolOperation,
} from './operations';

/** A high-risk operation request, before any signing or submission. */
export interface PreflightRequest {
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  /** Wallet initiating the operation. */
  readonly actorId: string;
  /** Operation payload; hashed into the request id, never logged verbatim. */
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * State snapshot the rules evaluate against (balances, allowances, current
   * config versions, …). Captured by the caller; the runner never fetches.
   */
  readonly state: PreflightStateSnapshot;
}

export interface PreflightStateSnapshot {
  /** The configuration versions this request was built against. */
  readonly configVersions: Readonly<Record<string, string>>;
  /** Balances in base units (stroops), keyed by asset. */
  readonly balances?: Readonly<Record<string, string>>;
  /** Estimated fee for the operation in stroops. */
  readonly estimatedFeeStroops?: string;
  /** Sequence number the transaction was composed against. */
  readonly sequenceAtComposition?: string;
  /** Current sequence number for the account, when known. */
  readonly currentSequence?: string;
  /** Allowance/approval for the operation, when relevant. */
  readonly allowanceOk?: boolean;
}

/** The three user-facing preflight verdicts. */
export type PreflightStatus = 'success' | 'warning' | 'blocked';

/** Severity contributed by one rule. */
export type PreflightRuleStatus = 'pass' | 'warning' | 'block';

export interface PreflightRuleResult {
  readonly ruleId: string;
  readonly status: PreflightRuleStatus;
  /** User-safe explanation; required for warning and block. */
  readonly message?: string;
  /** What the user can do about it; required for warning and block. */
  readonly remediation?: string;
  /** Machine-readable code for tests, telemetry and support. */
  readonly code?: string;
}

export interface PreflightResult {
  readonly requestId: string;
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  readonly status: PreflightStatus;
  readonly rules: readonly PreflightRuleResult[];
  /** Warnings with user-safe explanation + remediation (empty on clean success). */
  readonly warnings: readonly PreflightRuleResult[];
  /** Blocking results (empty unless status is `blocked`). */
  readonly blockers: readonly PreflightRuleResult[];
  /** Deprecation warnings surfaced by the compatibility layer (#178). */
  readonly configWarnings: readonly CompatibilityWarning[];
  readonly createdAt: number;
}

/** A pure preflight rule. Must not throw; return a `block` result instead. */
export type PreflightRule = (request: PreflightRequest) => PreflightRuleResult;

// ---------------------------------------------------------------------------
// Always-on rules, in fixed order.
// ---------------------------------------------------------------------------

/** Rule 1: emergency pause gate (#177). Injected manager; no-op pass without. */
export function pauseGateRule(request: PreflightRequest): PreflightRuleResult {
  return { ruleId: 'pause_gate', status: 'pass' };
}

/** Rule 2: config compatibility gate (#178). Injected registry; no-op without. */
export function configCompatibilityRule(request: PreflightRequest): PreflightRuleResult {
  return { ruleId: 'config_compatibility', status: 'pass' };
}

/** Rule 3: stale-state detection — sequence moved since composition. */
export function accountSequenceFreshnessRule(request: PreflightRequest): PreflightRuleResult {
  const { sequenceAtComposition, currentSequence } = request.state;
  if (!sequenceAtComposition || !currentSequence) {
    return { ruleId: 'account_sequence_freshness', status: 'pass' };
  }
  if (sequenceAtComposition !== currentSequence) {
    return {
      ruleId: 'account_sequence_freshness',
      status: 'block',
      code: 'STALE_STATE',
      message: 'Account state changed since this transaction was prepared.',
      remediation: 'Reload the page and review the operation again before signing.',
    };
  }
  return { ruleId: 'account_sequence_freshness', status: 'pass' };
}

/** Rules that always run, for every operation, in declaration order. */
export const ALWAYS_RULES: readonly PreflightRule[] = [
  pauseGateRule,
  configCompatibilityRule,
  accountSequenceFreshnessRule,
];

// ---------------------------------------------------------------------------
// Operation-specific rules, appended after the always-on rules.
// ---------------------------------------------------------------------------

function transferBalanceRule(request: PreflightRequest): PreflightRuleResult {
  const amount = request.payload.amount;
  const balance = request.state.balances?.XLM;
  if (typeof amount !== 'string' || !balance) {
    return { ruleId: 'transfer_balance', status: 'pass' };
  }
  if (Number(amount) > Number(balance)) {
    return {
      ruleId: 'transfer_balance',
      status: 'block',
      code: 'INSUFFICIENT_BALANCE',
      message: 'The amount exceeds your available XLM balance.',
      remediation: 'Reduce the amount or top up your wallet before retrying.',
    };
  }
  return { ruleId: 'transfer_balance', status: 'pass' };
}

function payoutAllowanceRule(request: PreflightRequest): PreflightRuleResult {
  if (request.state.allowanceOk === false) {
    return {
      ruleId: 'payout_allowance',
      status: 'warning',
      code: 'ALLOWANCE_REQUIRED',
      message: 'The payout contract is not yet approved to move your funds.',
      remediation: 'Approve the payout contract in your wallet, then retry the claim.',
    };
  }
  return { ruleId: 'payout_allowance', status: 'pass' };
}

function mintFeeRule(request: PreflightRequest): PreflightRuleResult {
  const fee = request.state.estimatedFeeStroops;
  if (!fee) return { ruleId: 'mint_fee', status: 'pass' };
  // 10 XLM in stroops as the "this fee looks wrong" ceiling.
  if (Number(fee) > 100_000_000) {
    return {
      ruleId: 'mint_fee',
      status: 'warning',
      code: 'FEE_OUTLIER',
      message: 'The estimated fee for minting is far above the usual range.',
      remediation: 'Wait a moment and retry — network congestion may have inflated the fee.',
    };
  }
  return { ruleId: 'mint_fee', status: 'pass' };
}

/** Per-operation rules. Operations without entries get only the shared rules. */
export const OPERATION_RULES: Readonly<Record<ProtocolOperation, readonly PreflightRule[]>> = {
  transfer_funds: [transferBalanceRule],
  claim_payout: [payoutAllowanceRule],
  mint_agent: [mintFeeRule],
  update_governance: [],
  retry_operation: [],
};

export interface PreflightRunnerOptions {
  /** Pause gate integration; when omitted the pause rule is a no-op pass. */
  pauseManager?: PauseManager;
  /** Config registry for the compatibility rule; omitted disables that rule. */
  configRegistry?: ProtocolConfigRegistry;
  now?: () => number;
  /** Extra rules appended after the built-ins (tests, deployment-specific checks). */
  extraRules?: readonly PreflightRule[];
}

/** Deterministic request id: same request + state → same id. */
function computeRequestId(request: PreflightRequest): string {
  return `pf-${request.operation}-${shortFingerprint([
    request.actorId,
    request.environment,
    request.payload,
    request.state,
  ])}`;
}

function evaluatePauseGate(
  request: PreflightRequest,
  pauseManager: PauseManager | undefined,
): PreflightRuleResult | null {
  if (!pauseManager) return null;
  const rejection = pauseManager.evaluateOperation({
    operation: request.operation,
    environment: request.environment,
    subjectId: request.actorId,
  });
  if (!rejection) return { ruleId: 'pause_gate', status: 'pass' };
  return {
    ruleId: 'pause_gate',
    status: 'block',
    code: rejection.code,
    message: rejection.message,
    remediation: 'Wait for the operation to be re-enabled, or contact support.',
  };
}

function evaluateConfigGate(
  request: PreflightRequest,
  registry: ProtocolConfigRegistry,
): PreflightRuleResult {
  const required = OPERATION_CONFIG_DEPENDENCIES[request.operation] ?? [];
  const versions = required.map((configId) => ({
    configId,
    version: request.state.configVersions[configId] ?? '0.0.0',
  }));
  try {
    const validation = validateProtocolCompatibility(registry, versions);
    if (validation.warnings.length > 0) {
      return {
        ruleId: 'config_compatibility',
        status: 'warning',
        code: validation.warnings[0].code,
        message: validation.warnings[0].message,
        remediation: 'Update your client to the latest version before continuing.',
      };
    }
    return { ruleId: 'config_compatibility', status: 'pass' };
  } catch (error) {
    return {
      ruleId: 'config_compatibility',
      status: 'block',
      code: 'CONFIG_INCOMPATIBLE',
      message:
        error instanceof Error
          ? error.message
          : 'This operation cannot run against the current configuration.',
      remediation: 'Update the app to a version that supports this configuration.',
    };
  }
}

/**
 * Deprecation warnings for the configs this operation depends on. Compatible
 * versions stay submittable; the warnings ride along for the UI to show.
 */
function collectConfigWarnings(
  request: PreflightRequest,
  registry: ProtocolConfigRegistry,
): CompatibilityWarning[] {
  const warnings: CompatibilityWarning[] = [];
  for (const configId of OPERATION_CONFIG_DEPENDENCIES[request.operation] ?? []) {
    const descriptor = registry.get(configId);
    const version = request.state.configVersions[configId];
    if (!descriptor || !version) continue;
    const warning = getConfigDeprecationWarning(descriptor, version);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

/**
 * Run every declared rule for `request` and fold the results into one verdict.
 *
 * Deterministic by construction: rule order is fixed, rules are pure, the
 * pause and compatibility gates are injected and deterministic in tests.
 */
export function runPreflight(
  request: PreflightRequest,
  options: PreflightRunnerOptions = {},
): PreflightResult {
  const declared = [
    ...ALWAYS_RULES,
    ...(OPERATION_RULES[request.operation] ?? []),
    ...(options.extraRules ?? []),
  ];

  const ruleResults: PreflightRuleResult[] = declared.map((rule) => {
    if (rule === pauseGateRule) {
      const gateResult = evaluatePauseGate(request, options.pauseManager);
      if (gateResult) return gateResult;
      return rule(request);
    }
    if (rule === configCompatibilityRule) {
      if (options.configRegistry) return evaluateConfigGate(request, options.configRegistry);
      return rule(request);
    }
    return rule(request);
  });

  const configWarnings = options.configRegistry
    ? collectConfigWarnings(request, options.configRegistry)
    : [];

  const blockers = ruleResults.filter((result) => result.status === 'block');
  const warnings = ruleResults.filter((result) => result.status === 'warning');
  const status: PreflightStatus = blockers.length
    ? 'blocked'
    : warnings.length
      ? 'warning'
      : 'success';

  return {
    requestId: computeRequestId(request),
    operation: request.operation,
    environment: request.environment,
    status,
    rules: ruleResults,
    warnings,
    blockers,
    configWarnings,
    createdAt: options.now?.() ?? 0,
  };
}

/**
 * True when `result` may be submitted. The UI uses this instead of inferring
 * from status, so "warning" operations stay a deliberate, testable choice.
 */
export function isSubmittable(result: PreflightResult): boolean {
  return result.status === 'success' || result.status === 'warning';
}
