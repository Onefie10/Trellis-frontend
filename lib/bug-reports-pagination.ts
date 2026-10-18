import type { BugReport } from "@/types/bug-report";

export type BugReportStatus = BugReport["status"];

export interface BugReportPage {
  records: BugReport[];
  nextCursor: string | null;
  previousCursor: string | null;
  hasMore: boolean;
  hasPrevious: boolean;
}

export interface FilterState {
  status: BugReportStatus | "all";
  severity: string | "all";
  author: string | "";
  tag: string | "all";
  buildVersion?: string | "all";
}

interface Cursor {
  createdAt: string;
  id: string;
  /** Prevent reusing a boundary with a different filter or visibility scope. */
  filterScope?: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      (cursor.filterScope !== undefined && typeof cursor.filterScope !== "string")
    ) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

export function buildCursor(createdAt: string, id: string): string {
  return encodeCursor({ createdAt, id });
}

export function parseCursor(value: string | null): Cursor | null {
  return decodeCursor(value);
}

export function getCursorBoundary(
  direction: "before" | "after",
  record: BugReport
): string {
  return encodeCursor({ createdAt: record.createdAt, id: record.id });
}

export function paginateBugReports(
  reports: readonly BugReport[],
  options: {
    cursor?: string | null;
    limit?: number;
    status?: BugReportStatus | "all";
    severity?: string | "all";
    author?: string;
    tag?: string | "all";
    buildVersion?: string | "all";
    /** Stable server-side identity/permission revision, never a client value. */
    visibilityScope?: string;
  } = {},
): BugReportPage {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const filterScope = JSON.stringify([
    options.status ?? "all",
    options.severity ?? "all",
    options.author ?? "",
    options.tag ?? "all",
    options.buildVersion ?? "all",
    options.visibilityScope ?? "",
  ]);
  const filtered = [...reports]
    .filter((report) => !options.status || options.status === "all" || report.status === options.status)
    .filter((report) => !options.severity || options.severity === "all" || (report.priority as string) === options.severity)
    .filter((report) => !options.author || !report.reporterAddress || report.reporterAddress === options.author || report.reporterEmail === options.author)
    .filter((report) => !options.tag || options.tag === "all" || report.category === options.tag)
    .filter(
      (report) =>
        !options.buildVersion ||
        options.buildVersion === "all" ||
        report.buildVersion === options.buildVersion,
    )
    .sort((left, right) => {
      const dateOrder = right.createdAt.localeCompare(left.createdAt);
      return dateOrder || right.id.localeCompare(left.id);
    });
  const cursor = decodeCursor(options.cursor ?? null);
  const activeCursor = cursor?.filterScope && cursor.filterScope !== filterScope ? null : cursor;
  const cursorIndex = activeCursor
    ? filtered.findIndex(
        (report) =>
          report.createdAt < activeCursor.createdAt ||
          (report.createdAt === activeCursor.createdAt && report.id < activeCursor.id),
      )
    : 0;
  // A cursor can outlive every record below its boundary. `findIndex` then
  // returns -1; treating that as slice(-1) would repeat the final record.
  const start = cursorIndex < 0 ? filtered.length : cursorIndex;
  const records = filtered.slice(start, start + limit);
  const last = records.at(-1);
  const first = records[0];
  const hasMore = start + records.length < filtered.length;
  const hasPrevious = start > 0;
  const previousCursor = hasPrevious && first
    ? encodeCursor({ createdAt: first.createdAt, id: first.id, filterScope })
    : null;

  return {
    records,
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id, filterScope })
      : null,
    previousCursor,
    hasMore,
    hasPrevious,
  };
}

export function filterStateToURLParams(filters: FilterState): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.status && filters.status !== "all") {
    params.status = filters.status;
  }
  if (filters.severity && filters.severity !== "all") {
    params.severity = filters.severity;
  }
  if (filters.author) {
    params.author = filters.author;
  }
  if (filters.tag && filters.tag !== "all") {
    params.tag = filters.tag;
  }
  if (filters.buildVersion && filters.buildVersion !== "all") {
    params.buildVersion = filters.buildVersion;
  }
  return params;
}

export function urlParamsToFilterParams(searchParams: Record<string, string | null>): FilterState {
  return {
    status: (searchParams.status as BugReportStatus) || "all",
    severity: searchParams.severity || "all",
    author: searchParams.author || "",
    tag: searchParams.tag || "all",
    buildVersion: searchParams.buildVersion || "all",
  };
}

export function applyOptimisticUpdate(
  reports: BugReport[],
  reportId: string,
  updates: Partial<Pick<BugReport, "status" | "rewardStatus" | "updatedAt">>
): BugReport[] {
  return reports.map((report) => {
    if (report.id === reportId) {
      return { ...report, ...updates };
    }
    return report;
  });
}

/* -------------------------------------------------------------------------- */
/* Duplicate report detection                                                 */
/* -------------------------------------------------------------------------- */

/** Similarity at or above this score counts as a probable duplicate. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/** Weight of the title token-set overlap versus the description overlap. */
const TITLE_WEIGHT = 0.6;
const DESCRIPTION_WEIGHT = 0.4;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

/** Lowercase, strip punctuation, and collapse whitespace. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Meaningful tokens, with stop words removed. */
export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Tokens this close are treated as the same word, which lets typos and simple
 * inflections match ("respond" vs "responding", "wallet" vs "walet").
 */
const TOKEN_MATCH_SIMILARITY = 0.7;

/** Jaccard index over token sets: |A ∩ B| / |A ∪ B|. */
export function jaccardSimilarity(left: string, right: string): number {
  const a = [...new Set(tokenize(left))];
  const b = [...new Set(tokenize(right))];
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Tokens are matched fuzzily so that "responding" and "respond" (or a typo)
  // still count as the same word when the reporter paraphrases an issue.
  const remaining = new Set(b);
  let intersection = 0;
  for (const token of a) {
    let bestMatch: string | null = null;
    let bestScore = 0;
    for (const candidate of remaining) {
      const score = levenshteinSimilarity(token, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }
    if (bestMatch !== null && bestScore >= TOKEN_MATCH_SIMILARITY) {
      remaining.delete(bestMatch);
      intersection += 1;
    }
  }

  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Levenshtein edit distance between two strings. */
export function levenshteinDistance(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Normalized Levenshtein similarity in the range [0, 1]. */
export function levenshteinSimilarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshteinDistance(a, b) / longest;
}

/**
 * Blended similarity score in the range [0, 1] combining Jaccard token overlap
 * (robust to reordered wording) with Levenshtein similarity (robust to typos).
 */
export function similarityScore(left: string, right: string): number {
  const jaccard = jaccardSimilarity(left, right);
  const levenshtein = levenshteinSimilarity(left, right);
  return Number((jaccard * 0.7 + levenshtein * 0.3).toFixed(4));
}

/**
 * Similarity between a report and a comparison target, weighting the title more
 * heavily than the description.
 */
export function reportSimilarity(
  report: Pick<BugReport, "title" | "description">,
  candidate: Pick<BugReport, "title" | "description">,
): number {
  const titleScore = similarityScore(report.title, candidate.title);
  const descriptionScore = similarityScore(report.description, candidate.description);
  return Number(
    (titleScore * TITLE_WEIGHT + descriptionScore * DESCRIPTION_WEIGHT).toFixed(4),
  );
}

export interface SimilarReportMatch {
  report: BugReport;
  score: number;
  titleScore: number;
  descriptionScore: number;
}

/**
 * Ranks existing reports by similarity to the draft and returns probable
 * duplicates, strongest match first.
 */
export function findSimilarReports(
  draft: Pick<BugReport, "title" | "description">,
  existing: readonly BugReport[],
  options: { threshold?: number; limit?: number; excludeId?: string } = {},
): SimilarReportMatch[] {
  const threshold = options.threshold ?? DUPLICATE_SIMILARITY_THRESHOLD;
  const limit = options.limit ?? 3;

  return existing
    .filter((report) => report.id !== options.excludeId)
    .map((report) => {
      const titleScore = similarityScore(draft.title, report.title);
      const descriptionScore = similarityScore(draft.description, report.description);
      return {
        report,
        score: Number(
          (titleScore * TITLE_WEIGHT + descriptionScore * DESCRIPTION_WEIGHT).toFixed(4),
        ),
        titleScore,
        descriptionScore,
      };
    })
    .filter((match) => match.score >= threshold)
    .sort((left, right) => right.score - left.score || left.report.id.localeCompare(right.report.id))
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Build version grouping and regression alerts                               */
/* -------------------------------------------------------------------------- */

/** Distinct build versions present in a report set, newest tag first. */
export function getBuildVersions(reports: readonly BugReport[]): string[] {
  const versions = new Set<string>();
  for (const report of reports) {
    if (report.buildVersion) versions.add(report.buildVersion);
  }
  return [...versions].sort(compareBuildVersions).reverse();
}

/**
 * Compares two build version tags numerically segment by segment so "v1.10.0"
 * sorts above "v1.9.0". Non-numeric segments fall back to string comparison.
 */
export function compareBuildVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/i, "").split(/[.-]/);
  const rightParts = right.replace(/^v/i, "").split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? "0";
    const b = rightParts[index] ?? "0";
    const aNumber = Number(a);
    const bNumber = Number(b);
    const bothNumeric = !Number.isNaN(aNumber) && !Number.isNaN(bNumber);
    if (bothNumeric && aNumber !== bNumber) {
      return aNumber < bNumber ? -1 : 1;
    }
    if (a !== b && !bothNumeric) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

export interface BuildVersionGroup {
  buildVersion: string;
  count: number;
  unresolved: number;
  severities: Record<string, number>;
}

/** Groups reports by build version with counts for the maintainer dashboard. */
export function groupReportsByBuildVersion(
  reports: readonly BugReport[],
): BuildVersionGroup[] {
  const groups = new Map<string, BuildVersionGroup>();

  for (const report of reports) {
    const version = report.buildVersion;
    if (!version) continue;
    const group = groups.get(version) ?? {
      buildVersion: version,
      count: 0,
      unresolved: 0,
      severities: {},
    };
    group.count += 1;
    if (report.status !== "resolved" && report.status !== "rejected") {
      group.unresolved += 1;
    }
    group.severities[report.priority] = (group.severities[report.priority] ?? 0) + 1;
    groups.set(version, group);
  }

  return [...groups.values()].sort((left, right) =>
    compareBuildVersions(right.buildVersion, left.buildVersion),
  );
}

export interface RegressionAlert {
  buildVersion: string;
  reportCount: number;
  criticalCount: number;
  message: string;
}

/**
 * Raises a regression alert when several reports land on the newest build,
 * signalling that the latest release likely introduced the defects.
 */
export function detectRegression(
  reports: readonly BugReport[],
  options: { threshold?: number; latestVersion?: string } = {},
): RegressionAlert | null {
  const threshold = options.threshold ?? 2;
  const versions = getBuildVersions(reports);
  const target = options.latestVersion ?? versions[0];
  if (!target) return null;

  const matching = reports.filter((report) => report.buildVersion === target);
  if (matching.length < threshold) return null;

  const criticalCount = matching.filter((report) => report.priority === "critical").length;
  return {
    buildVersion: target,
    reportCount: matching.length,
    criticalCount,
    message:
      `${matching.length} reports filed against the latest build ${target}` +
      (criticalCount > 0 ? `, including ${criticalCount} critical` : "") +
      ". Possible regression introduced by this release.",
  };
}

