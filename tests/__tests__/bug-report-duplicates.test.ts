import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  compareBuildVersions,
  detectRegression,
  findSimilarReports,
  getBuildVersions,
  groupReportsByBuildVersion,
  jaccardSimilarity,
  levenshteinDistance,
  levenshteinSimilarity,
  normalizeText,
  reportSimilarity,
  similarityScore,
  tokenize,
} from "@/lib/bug-reports-pagination";
import type { BugReport } from "@/types/bug-report";

function makeReport(
  id: string,
  overrides: Partial<BugReport> = {},
): BugReport {
  return {
    id,
    title: `Report ${id}`,
    description: `Description ${id}`,
    stepsToReproduce: "Steps",
    expectedBehavior: "Expected",
    actualBehavior: "Actual",
    priority: "medium",
    category: "functionality",
    screenshots: [],
    reporterAddress: "addr1",
    reporterEmail: "test@test.com",
    status: "submitted",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    rewardAmount: 10,
    rewardStatus: "pending",
    ...overrides,
  };
}

describe("Duplicate report detection", () => {
  describe("Text normalization", () => {
    it("lowercases and strips punctuation", () => {
      expect(normalizeText("  Wallet: FAILS on Connect!! ")).toBe("wallet fails on connect");
    });

    it("removes stop words when tokenizing", () => {
      expect(tokenize("The button is not working")).toEqual(["button", "not", "working"]);
    });

    it("drops single character tokens", () => {
      expect(tokenize("a b cd")).toEqual(["cd"]);
    });
  });

  describe("Jaccard similarity", () => {
    it("scores identical token sets as 1", () => {
      expect(jaccardSimilarity("wallet connect fails", "wallet connect fails")).toBe(1);
    });

    it("scores disjoint token sets as 0", () => {
      expect(jaccardSimilarity("wallet connect", "chart renders")).toBe(0);
    });

    it("scores partial overlap between 0 and 1", () => {
      const score = jaccardSimilarity(
        "wallet connect button fails",
        "wallet connect button broken",
      );
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    it("is order independent", () => {
      expect(jaccardSimilarity("connect wallet fails", "fails connect wallet")).toBe(1);
    });

    it("returns 1 when both inputs are empty", () => {
      expect(jaccardSimilarity("", "")).toBe(1);
    });
  });

  describe("Levenshtein distance and similarity", () => {
    it("measures edit distance for typos", () => {
      expect(levenshteinDistance("wallet", "walet")).toBe(1);
    });

    it("returns 0 distance for identical strings", () => {
      expect(levenshteinDistance("Wallet Connect", "wallet connect")).toBe(0);
    });

    it("normalizes similarity into the 0-1 range", () => {
      expect(levenshteinSimilarity("wallet", "wallet")).toBe(1);
      const score = levenshteinSimilarity("wallet connect", "wallet connec");
      expect(score).toBeGreaterThan(0.9);
      expect(score).toBeLessThan(1);
    });

    it("handles empty input safely", () => {
      expect(levenshteinSimilarity("", "")).toBe(1);
      expect(levenshteinSimilarity("wallet", "")).toBe(0);
    });
  });

  describe("Blended similarity score", () => {
    it("scores identical text as 1", () => {
      expect(similarityScore("wallet connect fails", "wallet connect fails")).toBe(1);
    });

    it("keeps near-duplicate wording above the duplicate threshold", () => {
      const score = similarityScore(
        "wallet connect button does not respond",
        "connect wallet button not responding",
      );
      expect(score).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY_THRESHOLD);
    });

    it("keeps unrelated text below the duplicate threshold", () => {
      const score = similarityScore(
        "wallet connect button does not respond",
        "trading chart tooltip overlaps the price axis",
      );
      expect(score).toBeLessThan(DUPLICATE_SIMILARITY_THRESHOLD);
    });

    it("weights report titles more heavily than descriptions", () => {
      const sharedTitle = reportSimilarity(
        { title: "wallet connect fails", description: "unrelated detail" },
        { title: "wallet connect fails", description: "totally different words here" },
      );
      const sharedDescription = reportSimilarity(
        { title: "wallet connect fails", description: "unrelated detail" },
        { title: "chart tooltip broken", description: "unrelated detail" },
      );
      expect(sharedTitle).toBeGreaterThan(sharedDescription);
    });
  });

  describe("Similar report suggestions", () => {
    const existing = [
      makeReport("dup", {
        title: "Wallet connect button does not respond",
        description: "Clicking connect wallet does nothing on the latest build",
        buildVersion: "v0.2.0",
      }),
      makeReport("other", {
        title: "Chart tooltip overlaps price axis",
        description: "The trading chart tooltip covers the price labels",
        buildVersion: "v0.1.0",
      }),
    ];

    it("returns probable duplicates above the threshold", () => {
      const matches = findSimilarReports(
        {
          title: "Connect wallet button not responding",
          description: "Clicking the connect wallet button does nothing",
        },
        existing,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].report.id).toBe("dup");
      expect(matches[0].score).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY_THRESHOLD);
    });

    it("returns nothing for an unrelated draft", () => {
      const matches = findSimilarReports(
        {
          title: "Staking reward calculation is off by one",
          description: "Reward math rounds down incorrectly for small stakes",
        },
        existing,
      );
      expect(matches).toHaveLength(0);
    });

    it("sorts matches by descending score", () => {
      const matches = findSimilarReports(
        {
          title: "Wallet connect button does not respond",
          description: "connect wallet button nothing",
        },
        [
          ...existing,
          makeReport("closer", {
            title: "Wallet connect button does not respond",
            description: "Clicking connect wallet button does nothing",
          }),
        ],
      );
      expect(matches.length).toBeGreaterThan(1);
      expect(matches[0].report.id).toBe("closer");
    });

    it("respects the configured limit and threshold", () => {
      const matches = findSimilarReports(
        {
          title: "Wallet connect button does not respond",
          description: "Clicking connect wallet does nothing",
        },
        existing,
        { limit: 1, threshold: 0.1 },
      );
      expect(matches).toHaveLength(1);
    });

    it("excludes a report by id", () => {
      const matches = findSimilarReports(
        { title: existing[0].title, description: existing[0].description },
        existing,
        { excludeId: "dup" },
      );
      expect(matches.map((match) => match.report.id)).not.toContain("dup");
    });

    it("breaks ties deterministically by id", () => {
      const matches = findSimilarReports(
        { title: "same title here", description: "same description here" },
        [
          makeReport("zzz", { title: "same title here", description: "same description here" }),
          makeReport("aaa", { title: "same title here", description: "same description here" }),
        ],
      );
      expect(matches.map((match) => match.report.id)).toEqual(["aaa", "zzz"]);
    });

    it("handles an empty existing set", () => {
      expect(findSimilarReports({ title: "anything", description: "at all" }, [])).toEqual([]);
    });
  });

  describe("Build version filtering helpers", () => {
    const reports = [
      makeReport("a", { buildVersion: "v1.9.0" }),
      makeReport("b", { buildVersion: "v1.10.0" }),
      makeReport("c", { buildVersion: "v1.9.0" }),
      makeReport("d"),
    ];

    it("lists distinct versions newest first", () => {
      expect(getBuildVersions(reports)).toEqual(["v1.10.0", "v1.9.0"]);
    });

    it("orders versions numerically rather than lexically", () => {
      expect(compareBuildVersions("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
      expect(compareBuildVersions("v1.2.0", "v1.2.0")).toBe(0);
      expect(compareBuildVersions("v0.9.0", "v1.0.0")).toBeLessThan(0);
    });

    it("ignores reports without a build version", () => {
      expect(getBuildVersions([makeReport("x")])).toEqual([]);
    });

    it("groups reports by build version with counts", () => {
      const groups = groupReportsByBuildVersion(reports);
      expect(groups).toHaveLength(2);
      const v19 = groups.find((group) => group.buildVersion === "v1.9.0");
      expect(v19?.count).toBe(2);
      expect(v19?.severities.medium).toBe(2);
    });

    it("counts unresolved reports per group", () => {
      const groups = groupReportsByBuildVersion([
        makeReport("a", { buildVersion: "v1.0.0", status: "resolved" }),
        makeReport("b", { buildVersion: "v1.0.0", status: "submitted" }),
      ]);
      expect(groups[0].count).toBe(2);
      expect(groups[0].unresolved).toBe(1);
    });
  });

  describe("Regression alerts", () => {
    it("alerts when several reports target the newest build", () => {
      const alert = detectRegression([
        makeReport("a", { buildVersion: "v0.2.0" }),
        makeReport("b", { buildVersion: "v0.2.0" }),
        makeReport("c", { buildVersion: "v0.1.0" }),
      ]);
      expect(alert).not.toBeNull();
      expect(alert?.buildVersion).toBe("v0.2.0");
      expect(alert?.reportCount).toBe(2);
    });

    it("stays quiet when the newest build has a single report", () => {
      const alert = detectRegression([
        makeReport("a", { buildVersion: "v0.2.0" }),
        makeReport("b", { buildVersion: "v0.1.0" }),
        makeReport("c", { buildVersion: "v0.1.0" }),
      ]);
      expect(alert).toBeNull();
    });

    it("counts critical reports in the alert message", () => {
      const alert = detectRegression([
        makeReport("a", { buildVersion: "v0.2.0", priority: "critical" }),
        makeReport("b", { buildVersion: "v0.2.0" }),
      ]);
      expect(alert?.criticalCount).toBe(1);
      expect(alert?.message).toContain("critical");
    });

    it("honours a custom threshold and explicit latest version", () => {
      const reports = [
        makeReport("a", { buildVersion: "v0.2.0" }),
        makeReport("b", { buildVersion: "v0.1.0" }),
        makeReport("c", { buildVersion: "v0.1.0" }),
      ];
      expect(detectRegression(reports, { threshold: 1 })?.buildVersion).toBe("v0.2.0");
      expect(detectRegression(reports, { latestVersion: "v0.1.0" })?.reportCount).toBe(2);
    });

    it("returns null when no report carries a build version", () => {
      expect(detectRegression([makeReport("a")])).toBeNull();
    });
  });
});
