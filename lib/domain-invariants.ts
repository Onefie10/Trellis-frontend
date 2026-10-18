/**
 * Trellis Domain Invariant Engine
 *
 * Provides non-mutating disaster recovery validation of core domain invariants
 * across entities, relationships, timestamps, and settlement references.
 */

import type { Agent } from "./types";
import type { TestCase, TestExecution } from "./db/types";
import type { ProvenanceRecord } from "./provenance/types";
import type { BugReport } from "../types/bug-report";
import type { ReferralRecord, PayoutRequest } from "../features/affiliate-dashboard/types";
import { STELLAR_ADDRESS_RE, MINIMUM_PAYOUT_XLM } from "./affiliate-store";

export type InvariantCategory =
  | "uniqueness"
  | "relational_integrity"
  | "settlement_and_financial"
  | "schema_and_enums"
  | "chronology_and_timestamps";

export type InvariantViolationCode =
  | "DUPLICATE_ID"
  | "ORPHANED_RECORD"
  | "INVALID_STATUS_ENUM"
  | "INVALID_STELLAR_ADDRESS"
  | "SETTLEMENT_REFERENCE_MISSING"
  | "FINANCIAL_BALANCE_VIOLATION"
  | "INVALID_NUMERIC_METRIC"
  | "TIMESTAMP_CHRONOLOGY_VIOLATION"
  | "SELF_REFERRAL_VIOLATION"
  | "INVALID_TIMESTAMP_FORMAT";

export interface InvariantViolation {
  code: InvariantViolationCode;
  category: InvariantCategory;
  entityType: string;
  entityId: string;
  severity: "error" | "warning";
  message: string;
  remediation: string;
  details?: Record<string, unknown>;
}

export interface DomainDataset {
  agents?: Agent[];
  testCases?: TestCase[];
  testExecutions?: TestExecution[];
  provenanceRecords?: ProvenanceRecord[];
  referralCodes?: { code: string; ownerWallet: string; createdAt?: string }[];
  referrals?: ReferralRecord[];
  payouts?: PayoutRequest[];
  earningsLedger?: { wallet: string; earnedXlm: number }[];
  bugReports?: BugReport[];
}

export interface InvariantValidationReport {
  timestamp: string;
  isValid: boolean;
  summary: {
    totalChecks: number;
    passedChecks: number;
    errorCount: number;
    warningCount: number;
    entitiesScanned: Record<string, number>;
  };
  violations: InvariantViolation[];
}

export interface ValidationOptions {
  strict?: boolean;
}

function isValidIsoDate(str: unknown): boolean {
  if (typeof str !== "string") return false;
  const timestamp = Date.parse(str);
  return !Number.isNaN(timestamp);
}

/**
 * Validates domain invariants across all entities in a dataset without mutating any state.
 */
export function validateDomainInvariants(
  dataset: DomainDataset = {},
  options: ValidationOptions = {}
): InvariantValidationReport {
  const violations: InvariantViolation[] = [];
  let totalChecks = 0;

  const agents = dataset.agents ?? [];
  const testCases = dataset.testCases ?? [];
  const testExecutions = dataset.testExecutions ?? [];
  const provenanceRecords = dataset.provenanceRecords ?? [];
  const referralCodes = dataset.referralCodes ?? [];
  const referrals = dataset.referrals ?? [];
  const payouts = dataset.payouts ?? [];
  const earningsLedger = dataset.earningsLedger ?? [];
  const bugReports = dataset.bugReports ?? [];

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

  // Helper to record a check
  const check = () => {
    totalChecks++;
  };

  // ---------------------------------------------------------------------------
  // 1. Uniqueness Checks
  // ---------------------------------------------------------------------------
  function checkUniqueness<T extends { id: string }>(items: T[], entityType: string) {
    const seen = new Set<string>();
    for (const item of items) {
      check();
      if (!item.id || item.id.trim() === "") {
        violations.push({
          code: "DUPLICATE_ID",
          category: "uniqueness",
          entityType,
          entityId: "UNKNOWN",
          severity: "error",
          message: `Empty or missing ID encountered in ${entityType}`,
          remediation: `Ensure all ${entityType} records have valid, unique primary identifiers.`,
        });
        continue;
      }
      if (seen.has(item.id)) {
        violations.push({
          code: "DUPLICATE_ID",
          category: "uniqueness",
          entityType,
          entityId: item.id,
          severity: "error",
          message: `Duplicate ${entityType} identifier detected: '${item.id}'`,
          remediation: `Deduplicate or re-index ${entityType} records before proceeding with restoration.`,
        });
      } else {
        seen.add(item.id);
      }
    }
  }

  checkUniqueness(agents, "Agent");
  checkUniqueness(testCases, "TestCase");
  checkUniqueness(testExecutions, "TestExecution");
  checkUniqueness(provenanceRecords, "ProvenanceRecord");
  checkUniqueness(referrals, "ReferralRecord");
  checkUniqueness(payouts, "PayoutRequest");
  checkUniqueness(bugReports, "BugReport");

  // Check referral code uniqueness
  const seenCodes = new Set<string>();
  for (const rc of referralCodes) {
    check();
    if (seenCodes.has(rc.code)) {
      violations.push({
        code: "DUPLICATE_ID",
        category: "uniqueness",
        entityType: "ReferralCode",
        entityId: rc.code,
        severity: "error",
        message: `Duplicate referral code detected: '${rc.code}'`,
        remediation: "Ensure referral codes are globally unique in affiliate registry.",
      });
    } else {
      seenCodes.add(rc.code);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Relational Integrity Checks
  // ---------------------------------------------------------------------------
  const testCaseIdSet = new Set(testCases.map((tc) => tc.id));
  for (const te of testExecutions) {
    check();
    if (!testCaseIdSet.has(te.testCaseId)) {
      violations.push({
        code: "ORPHANED_RECORD",
        category: "relational_integrity",
        entityType: "TestExecution",
        entityId: te.id,
        severity: "error",
        message: `Orphaned TestExecution '${te.id}': testCaseId '${te.testCaseId}' does not exist in test cases repository`,
        remediation: `Restore missing TestCase '${te.testCaseId}' or purge orphaned execution records.`,
        details: { testCaseId: te.testCaseId },
      });
    }
  }

  // Referral code mapping
  const codeOwnerMap = new Map(referralCodes.map((rc) => [rc.code, rc.ownerWallet]));
  for (const ref of referrals) {
    check();
    if (referralCodes.length > 0 && !codeOwnerMap.has(ref.referralCode)) {
      violations.push({
        code: "ORPHANED_RECORD",
        category: "relational_integrity",
        entityType: "ReferralRecord",
        entityId: ref.id,
        severity: "error",
        message: `Referral record '${ref.id}' references unknown referralCode '${ref.referralCode}'`,
        remediation: `Verify affiliate registry contains code '${ref.referralCode}'.`,
        details: { referralCode: ref.referralCode },
      });
    }

    // Check self-referral invariant
    const owner = codeOwnerMap.get(ref.referralCode);
    if (owner && owner === ref.referredUserAddress) {
      check();
      violations.push({
        code: "SELF_REFERRAL_VIOLATION",
        category: "relational_integrity",
        entityType: "ReferralRecord",
        entityId: ref.id,
        severity: "error",
        message: `Self-referral invariant breached on record '${ref.id}': owner '${owner}' referred themselves`,
        remediation: "Disqualify self-referral record and adjust affiliate ledger accordingly.",
        details: { wallet: owner },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Settlement & Financial Integrity Checks
  // ---------------------------------------------------------------------------
  // Check Stellar address formatting on payouts, referrals, and bug reports
  for (const payout of payouts) {
    check();
    if (!STELLAR_ADDRESS_RE.test(payout.walletAddress)) {
      violations.push({
        code: "INVALID_STELLAR_ADDRESS",
        category: "settlement_and_financial",
        entityType: "PayoutRequest",
        entityId: payout.id,
        severity: "error",
        message: `Payout '${payout.id}' contains invalid Stellar wallet address: '${payout.walletAddress}'`,
        remediation: "Correct recipient wallet address to a valid G... Stellar public key.",
      });
    }

    // Amount validation
    check();
    const amount = parseFloat(payout.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      violations.push({
        code: "INVALID_NUMERIC_METRIC",
        category: "settlement_and_financial",
        entityType: "PayoutRequest",
        entityId: payout.id,
        severity: "error",
        message: `Payout '${payout.id}' contains invalid amount '${payout.amount}'`,
        remediation: "Ensure payout amount is a valid positive number.",
      });
    } else if (amount < MINIMUM_PAYOUT_XLM) {
      violations.push({
        code: "FINANCIAL_BALANCE_VIOLATION",
        category: "settlement_and_financial",
        entityType: "PayoutRequest",
        entityId: payout.id,
        severity: "warning",
        message: `Payout '${payout.id}' amount (${amount} XLM) is below minimum threshold of ${MINIMUM_PAYOUT_XLM} XLM`,
        remediation: `Adjust payout to meet the minimum threshold of ${MINIMUM_PAYOUT_XLM} XLM.`,
      });
    }

    // Settlement reference check: completed payouts MUST have transactionHash
    check();
    if (payout.status === "completed" && (!payout.transactionHash || payout.transactionHash.trim() === "")) {
      violations.push({
        code: "SETTLEMENT_REFERENCE_MISSING",
        category: "settlement_and_financial",
        entityType: "PayoutRequest",
        entityId: payout.id,
        severity: "error",
        message: `Completed payout '${payout.id}' is missing on-chain transaction settlement reference (transactionHash)`,
        remediation: "Verify on-chain settlement status and attach transaction hash.",
      });
    }
  }

  // Provenance on-chain submission txHash check
  for (const prov of provenanceRecords) {
    if (prov.action === "on_chain_submission") {
      check();
      if (!prov.txHash || prov.txHash.trim() === "") {
        violations.push({
          code: "SETTLEMENT_REFERENCE_MISSING",
          category: "settlement_and_financial",
          entityType: "ProvenanceRecord",
          entityId: prov.id,
          severity: "error",
          message: `On-chain submission provenance record '${prov.id}' is missing txHash`,
          remediation: "Attach blockchain transaction hash to on-chain action record.",
        });
      }
    }
  }

  // Financial balance ledger: total payouts per wallet must not exceed earned earnings
  const earnedMap = new Map(earningsLedger.map((e) => [e.wallet, e.earnedXlm]));
  const completedPayoutsByWallet = new Map<string, number>();
  for (const p of payouts) {
    if (p.status === "completed") {
      const current = completedPayoutsByWallet.get(p.walletAddress) ?? 0;
      completedPayoutsByWallet.set(p.walletAddress, current + (parseFloat(p.amount) || 0));
    }
  }

  for (const [wallet, totalPaid] of completedPayoutsByWallet.entries()) {
    check();
    const totalEarned = earnedMap.get(wallet);
    if (totalEarned !== undefined && totalPaid > totalEarned) {
      violations.push({
        code: "FINANCIAL_BALANCE_VIOLATION",
        category: "settlement_and_financial",
        entityType: "EarningsLedger",
        entityId: wallet,
        severity: "error",
        message: `Financial balance invariant breached for wallet '${wallet}': total completed payouts (${totalPaid} XLM) exceed cumulative credited earnings (${totalEarned} XLM)`,
        remediation: "Audit payout history and freeze anomalous affiliate balances.",
        details: { wallet, totalPaid, totalEarned },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Schema & Enums Checks
  // ---------------------------------------------------------------------------
  const validAgentStatuses = new Set(["active", "inactive", "draft"]);
  for (const a of agents) {
    check();
    if (!validAgentStatuses.has(a.status)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "Agent",
        entityId: a.id,
        severity: "error",
        message: `Agent '${a.id}' has invalid status '${a.status}' (expected: active, inactive, draft)`,
        remediation: "Update agent status to a recognized enum value.",
      });
    }
  }

  const validExecutionStatuses = new Set(["pending", "running", "completed", "failed"]);
  for (const te of testExecutions) {
    check();
    if (!validExecutionStatuses.has(te.status)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "TestExecution",
        entityId: te.id,
        severity: "error",
        message: `TestExecution '${te.id}' has invalid status '${te.status}' (expected: pending, running, completed, failed)`,
        remediation: "Normalize execution status to valid domain enum.",
      });
    }

    // Quality score boundary check (0 - 100)
    check();
    if (typeof te.qualityScore === "number") {
      if (te.qualityScore < 0 || te.qualityScore > 100) {
        violations.push({
          code: "INVALID_NUMERIC_METRIC",
          category: "schema_and_enums",
          entityType: "TestExecution",
          entityId: te.id,
          severity: "error",
          message: `Quality score for TestExecution '${te.id}' (${te.qualityScore}) out of bounds [0, 100]`,
          remediation: "Clamp quality score to valid range 0 to 100.",
        });
      }
    }

    // Resource metrics check
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
          code: "INVALID_NUMERIC_METRIC",
          category: "schema_and_enums",
          entityType: "TestExecution",
          entityId: te.id,
          severity: "error",
          message: `Negative resource metrics detected in TestExecution '${te.id}'`,
          remediation: "Inspect benchmark collector and ensure metrics cannot be negative.",
        });
      }
    }
  }

  const validProvenanceStatuses = new Set(["success", "failure", "pending"]);
  const validProvenanceActions = new Set([
    "input_received",
    "provider_call",
    "on_chain_submission",
    "output_generated",
    "error_encountered",
  ]);
  for (const pr of provenanceRecords) {
    check();
    if (!validProvenanceStatuses.has(pr.status)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "ProvenanceRecord",
        entityId: pr.id,
        severity: "error",
        message: `Provenance record '${pr.id}' has invalid status '${pr.status}'`,
        remediation: "Normalize provenance record status enum.",
      });
    }
    check();
    if (!validProvenanceActions.has(pr.action)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "ProvenanceRecord",
        entityId: pr.id,
        severity: "error",
        message: `Provenance record '${pr.id}' has invalid action '${pr.action}'`,
        remediation: "Normalize provenance action enum.",
      });
    }
  }

  const validPayoutStatuses = new Set(["pending", "processing", "completed", "failed"]);
  for (const p of payouts) {
    check();
    if (!validPayoutStatuses.has(p.status)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "PayoutRequest",
        entityId: p.id,
        severity: "error",
        message: `PayoutRequest '${p.id}' has invalid status '${p.status}'`,
        remediation: "Normalize payout status enum.",
      });
    }
  }

  const validBugStatuses = new Set(["submitted", "under_review", "in_progress", "resolved", "rejected"]);
  const validBugPriorities = new Set(["low", "medium", "high", "critical"]);
  for (const br of bugReports) {
    check();
    if (!validBugStatuses.has(br.status)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "BugReport",
        entityId: br.id,
        severity: "error",
        message: `BugReport '${br.id}' has invalid status '${br.status}'`,
        remediation: "Normalize bug report status enum.",
      });
    }
    check();
    if (!validBugPriorities.has(br.priority)) {
      violations.push({
        code: "INVALID_STATUS_ENUM",
        category: "schema_and_enums",
        entityType: "BugReport",
        entityId: br.id,
        severity: "error",
        message: `BugReport '${br.id}' has invalid priority '${br.priority}'`,
        remediation: "Normalize bug report priority enum.",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Chronology & Timestamp Checks
  // ---------------------------------------------------------------------------
  for (const te of testExecutions) {
    check();
    if (!isValidIsoDate(te.startTime)) {
      violations.push({
        code: "INVALID_TIMESTAMP_FORMAT",
        category: "chronology_and_timestamps",
        entityType: "TestExecution",
        entityId: te.id,
        severity: "error",
        message: `TestExecution '${te.id}' has malformed startTime: '${te.startTime}'`,
        remediation: "Format timestamp as valid ISO-8601 string.",
      });
    }
    if (te.endTime) {
      check();
      if (!isValidIsoDate(te.endTime)) {
        violations.push({
          code: "INVALID_TIMESTAMP_FORMAT",
          category: "chronology_and_timestamps",
          entityType: "TestExecution",
          entityId: te.id,
          severity: "error",
          message: `TestExecution '${te.id}' has malformed endTime: '${te.endTime}'`,
          remediation: "Format timestamp as valid ISO-8601 string.",
        });
      } else if (Date.parse(te.endTime) < Date.parse(te.startTime)) {
        violations.push({
          code: "TIMESTAMP_CHRONOLOGY_VIOLATION",
          category: "chronology_and_timestamps",
          entityType: "TestExecution",
          entityId: te.id,
          severity: "error",
          message: `TestExecution '${te.id}' chronology inverted: endTime (${te.endTime}) precedes startTime (${te.startTime})`,
          remediation: "Correct execution interval timestamps.",
        });
      }
    }
  }

  for (const br of bugReports) {
    check();
    if (isValidIsoDate(br.createdAt) && isValidIsoDate(br.updatedAt)) {
      if (Date.parse(br.updatedAt) < Date.parse(br.createdAt)) {
        violations.push({
          code: "TIMESTAMP_CHRONOLOGY_VIOLATION",
          category: "chronology_and_timestamps",
          entityType: "BugReport",
          entityId: br.id,
          severity: "error",
          message: `BugReport '${br.id}' updatedAt (${br.updatedAt}) is earlier than createdAt (${br.createdAt})`,
          remediation: "Ensure update timestamp is greater than or equal to creation timestamp.",
        });
      }
    }
  }

  for (const ref of referrals) {
    if (ref.convertedAt && isValidIsoDate(ref.createdAt) && isValidIsoDate(ref.convertedAt)) {
      check();
      if (Date.parse(ref.convertedAt) < Date.parse(ref.createdAt)) {
        violations.push({
          code: "TIMESTAMP_CHRONOLOGY_VIOLATION",
          category: "chronology_and_timestamps",
          entityType: "ReferralRecord",
          entityId: ref.id,
          severity: "error",
          message: `Referral '${ref.id}' convertedAt (${ref.convertedAt}) is earlier than createdAt (${ref.createdAt})`,
          remediation: "Ensure conversion timestamp follows creation timestamp.",
        });
      }
    }
  }

  // Summary aggregation
  const errorCount = violations.filter((v) => v.severity === "error").length;
  const warningCount = violations.filter((v) => v.severity === "warning").length;
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
