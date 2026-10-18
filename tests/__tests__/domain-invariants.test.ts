import { validateInvariants, loadDataset } from "../../scripts/validate-domain-invariants.mjs";
import { validateDomainInvariants } from "../../lib/domain-invariants";

describe("Disaster Recovery: Domain Invariant Validation", () => {
  describe("Baseline Recovery Dataset", () => {
    it("validates that the recovery baseline fixture passes all invariants without error", () => {
      const baseline = loadDataset();
      const report = validateInvariants(baseline);

      expect(report.isValid).toBe(true);
      expect(report.summary.errorCount).toBe(0);
      expect(report.summary.totalChecks).toBeGreaterThan(0);
      expect(report.violations.length).toBe(0);
    });

    it("works identically with TypeScript library export", () => {
      const baseline = loadDataset();
      const report = validateDomainInvariants(baseline);

      expect(report.isValid).toBe(true);
      expect(report.summary.errorCount).toBe(0);
      expect(report.violations.length).toBe(0);
    });
  });

  describe("Uniqueness Invariants", () => {
    it("detects duplicate test case IDs", () => {
      const dataset = {
        testCases: [
          {
            id: "tc-dup",
            name: "Case 1",
            contractId: "C1",
            functionName: "f",
            args: [],
            network: "testnet" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "tc-dup",
            name: "Case 2",
            contractId: "C2",
            functionName: "f",
            args: [],
            network: "testnet" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "DUPLICATE_ID");
      expect(violation).toBeDefined();
      expect(violation?.entityType).toBe("TestCase");
      expect(violation?.entityId).toBe("tc-dup");
    });

    it("detects duplicate referral codes", () => {
      const dataset = {
        referralCodes: [
          { code: "DUPCODE1", ownerWallet: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" },
          { code: "DUPCODE1", ownerWallet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "DUPLICATE_ID");
      expect(violation).toBeDefined();
      expect(violation?.entityType).toBe("ReferralCode");
    });
  });

  describe("Relational Integrity Invariants", () => {
    it("detects orphaned test executions referencing nonexistent test cases", () => {
      const dataset = {
        testCases: [
          {
            id: "tc-valid",
            name: "Valid",
            contractId: "C1",
            functionName: "f",
            args: [],
            network: "testnet" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        testExecutions: [
          {
            id: "te-orphan",
            testCaseId: "tc-missing-404",
            status: "completed" as const,
            qualityScore: 90,
            logs: [],
            events: [],
            startTime: "2026-01-01T10:00:00.000Z",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "ORPHANED_RECORD");
      expect(violation).toBeDefined();
      expect(violation?.entityType).toBe("TestExecution");
      expect(violation?.entityId).toBe("te-orphan");
      expect(violation?.message).toContain("tc-missing-404");
    });

    it("detects self-referrals violating affiliate invariants", () => {
      const dataset = {
        referralCodes: [
          { code: "MYOWNCODE", ownerWallet: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" },
        ],
        referrals: [
          {
            id: "ref-self",
            referralCode: "MYOWNCODE",
            referredUserAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
            status: "active" as const,
            commissionRate: 10,
            commissionAmount: "50.00",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "SELF_REFERRAL_VIOLATION");
      expect(violation).toBeDefined();
      expect(violation?.entityId).toBe("ref-self");
    });
  });

  describe("Settlement & Financial Invariants", () => {
    it("flags invalid Stellar addresses on payouts", () => {
      const dataset = {
        payouts: [
          {
            id: "pay-invalid-addr",
            walletAddress: "0x1234NotAStellarAddress",
            amount: "150.00",
            status: "pending" as const,
            requestedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "INVALID_STELLAR_ADDRESS");
      expect(violation).toBeDefined();
    });

    it("requires on-chain settlement reference (transactionHash) for completed payouts", () => {
      const dataset = {
        payouts: [
          {
            id: "pay-no-hash",
            walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
            amount: "150.00",
            status: "completed" as const,
            requestedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "SETTLEMENT_REFERENCE_MISSING");
      expect(violation).toBeDefined();
    });

    it("detects ledger imbalance where payouts exceed total earnings", () => {
      const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
      const dataset = {
        earningsLedger: [{ wallet, earnedXlm: 200 }],
        payouts: [
          {
            id: "pay-excess",
            walletAddress: wallet,
            amount: "500.00",
            status: "completed" as const,
            requestedAt: "2026-01-01T00:00:00.000Z",
            transactionHash: "tx-settled-hash-1",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "FINANCIAL_BALANCE_VIOLATION");
      expect(violation).toBeDefined();
      expect(violation?.severity).toBe("error");
    });
  });

  describe("Schema & Enums Invariants", () => {
    it("rejects unauthorized status enums", () => {
      const dataset = {
        agents: [
          {
            id: "ag-bad",
            name: "Agent",
            description: "",
            author: "",
            rating: 5,
            users: 1,
            behavior: "",
            capabilities: [],
            status: "compromised" as any,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "INVALID_STATUS_ENUM");
      expect(violation).toBeDefined();
      expect(violation?.entityType).toBe("Agent");
    });

    it("rejects out-of-bounds quality scores and negative metrics", () => {
      const dataset = {
        testCases: [{ id: "tc-1" } as any],
        testExecutions: [
          {
            id: "te-bad-score",
            testCaseId: "tc-1",
            status: "completed" as const,
            qualityScore: 125, // Invalid > 100
            logs: [],
            events: [],
            startTime: "2026-01-01T00:00:00.000Z",
            metrics: {
              cpuInstructions: -50, // Negative metric
              ramBytes: 1024,
              ledgerReadBytes: 0,
              ledgerWriteBytes: 0,
              readCount: 0,
              writeCount: 0,
              costXlm: "0",
            },
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const metricsViolations = report.violations.filter((v) => v.code === "INVALID_NUMERIC_METRIC");
      expect(metricsViolations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Chronology & Timestamp Invariants", () => {
    it("detects inverted timestamps where endTime precedes startTime", () => {
      const dataset = {
        testCases: [{ id: "tc-1" } as any],
        testExecutions: [
          {
            id: "te-inverted-time",
            testCaseId: "tc-1",
            status: "completed" as const,
            qualityScore: 95,
            logs: [],
            events: [],
            startTime: "2026-01-02T12:00:00.000Z",
            endTime: "2026-01-01T12:00:00.000Z", // Precedes startTime
          },
        ],
      };

      const report = validateInvariants(dataset);
      expect(report.isValid).toBe(false);
      const violation = report.violations.find((v) => v.code === "TIMESTAMP_CHRONOLOGY_VIOLATION");
      expect(violation).toBeDefined();
      expect(violation?.entityId).toBe("te-inverted-time");
    });
  });

  describe("Read-Only Guarantee", () => {
    it("does not mutate the source dataset in memory", () => {
      const original = {
        agents: [
          {
            id: "ag-frozen",
            name: "Agent",
            description: "",
            author: "",
            rating: 5,
            users: 10,
            behavior: "",
            capabilities: ["nlp"],
            status: "active" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const snapshotBefore = JSON.stringify(original);
      validateInvariants(original);
      const snapshotAfter = JSON.stringify(original);

      expect(snapshotBefore).toEqual(snapshotAfter);
    });
  });
});
