import {
  paginateBugReports,
  buildCursor,
  parseCursor,
  getCursorBoundary,
  filterStateToURLParams,
  urlParamsToFilterParams,
  applyOptimisticUpdate,
} from "@/lib/bug-reports-pagination";
import type { BugReport } from "@/types/bug-report";

function makeReport(
  id: string,
  createdAt: string,
  status: BugReport["status"] = "submitted",
  priority: BugReport["priority"] = "medium",
  category: BugReport["category"] = "functionality",
  reporterAddress = "addr1",
  reporterEmail = "test@test.com"
): BugReport {
  return {
    id,
    title: id,
    description: "Test description",
    stepsToReproduce: "Steps",
    expectedBehavior: "Expected",
    actualBehavior: "Actual",
    priority,
    category,
    screenshots: [],
    reporterAddress,
    reporterEmail,
    status,
    createdAt,
    updatedAt: createdAt,
    rewardAmount: 10,
    rewardStatus: "pending",
  };
}

describe("Bug Reports Cursor-based Pagination", () => {
  describe("Cursor encoding/decoding", () => {
    it("encodes a cursor correctly", () => {
      const cursor = buildCursor("2026-01-03T00:00:00Z", "report-3");
      const decoded = parseCursor(cursor);
      expect(decoded).toEqual({ createdAt: "2026-01-03T00:00:00Z", id: "report-3" });
    });

    it("decodes a null cursor", () => {
      expect(parseCursor(null)).toBeNull();
    });

    it("decodes an invalid cursor", () => {
      expect(parseCursor("invalid")).toBeNull();
    });

    it("decodes an empty string cursor", () => {
      expect(parseCursor("")).toBeNull();
    });

    it("produces opaque base64url tokens", () => {
      const cursor = buildCursor("2026-01-03T00:00:00Z", "id-abc");
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cursor).not.toContain("=");
    });
  });

  describe("Cursor boundary navigation", () => {
    it("returns records after the cursor position", () => {
      const reports = [
        makeReport("a", "2026-01-03"),
        makeReport("b", "2026-01-02"),
        makeReport("c", "2026-01-01"),
      ];
      const firstPage = paginateBugReports(reports, { limit: 2 });
      const secondPage = paginateBugReports(reports, {
        cursor: firstPage.nextCursor,
        limit: 2,
      });

      expect(firstPage.records.map((r) => r.id)).toEqual(["a", "b"]);
      expect(secondPage.records.map((r) => r.id)).toEqual(["c"]);
    });

    it("hasPrevious and previousCursor work correctly", () => {
      const reports = [
        makeReport("a", "2026-01-03"),
        makeReport("b", "2026-01-02"),
        makeReport("c", "2026-01-01"),
      ];
      const firstPage = paginateBugReports(reports, { limit: 2 });

      expect(firstPage.hasPrevious).toBe(false);
      expect(firstPage.previousCursor).toBeNull();

      const secondPage = paginateBugReports(reports, {
        cursor: firstPage.nextCursor!,
        limit: 1,
      });
      expect(secondPage.hasPrevious).toBe(true);
      expect(secondPage.previousCursor).not.toBeNull();
    });

    it("handles boundary navigation at the start", () => {
      const reports = [makeReport("a", "2026-01-01")];
      const page = paginateBugReports(reports, { limit: 10 });
      expect(page.hasPrevious).toBe(false);
      expect(page.hasMore).toBe(false);
    });

    it("handles boundary navigation at the end", () => {
      const reports = [makeReport("a", "2026-01-01")];
      const page = paginateBugReports(reports, { limit: 10 });
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("maintains continuous ordering when new reports arrive", () => {
      const initial = [
        makeReport("three", "2026-01-03"),
        makeReport("two", "2026-01-02"),
        makeReport("one", "2026-01-01"),
      ];
      const firstPage = paginateBugReports(initial, { limit: 2 });
      const secondPage = paginateBugReports(
        [makeReport("four", "2026-01-04"), ...initial],
        { cursor: firstPage.nextCursor, limit: 2 },
      );

      expect(firstPage.records.map((item) => item.id)).toEqual(["three", "two"]);
      expect(secondPage.records.map((item) => item.id)).toEqual(["one"]);
    });

    it("cursor from getCursorBoundary matches encoded cursor", () => {
      const report = makeReport("x", "2026-06-15");
      const boundary = getCursorBoundary("before", report);
      const decoded = parseCursor(boundary);
      expect(decoded).toEqual({ createdAt: "2026-06-15", id: "x" });
    });
  });

  describe("Filter persistence", () => {
    it("converts filter state to URL params", () => {
      const params = filterStateToURLParams({
        status: "resolved",
        severity: "high",
        author: "0xabc",
        tag: "security",
      });
      expect(params).toEqual({
        status: "resolved",
        severity: "high",
        author: "0xabc",
        tag: "security",
      });
    });

    it("omits 'all' filters from URL params", () => {
      const params = filterStateToURLParams({
        status: "all",
        severity: "all",
        author: "",
        tag: "all",
      });
      expect(Object.keys(params)).toHaveLength(0);
    });

    it("converts URL params to filter state", () => {
      const filters = urlParamsToFilterParams({ status: "resolved", severity: "high", author: null, tag: null });
      expect(filters.status).toBe("resolved");
      expect(filters.severity).toBe("high");
      expect(filters.author).toBe("");
      expect(filters.tag).toBe("all");
    });

    it("defaults to 'all' for empty URL params", () => {
      const filters = urlParamsToFilterParams({});
      expect(filters.status).toBe("all");
      expect(filters.severity).toBe("all");
      expect(filters.tag).toBe("all");
    });
  });

  describe("Optimistic updates", () => {
    it("applies optimistic update to matching report", () => {
      const reports = [
        makeReport("a", "2026-01-01", "submitted"),
        makeReport("b", "2026-01-02", "resolved"),
      ];
      const updated = applyOptimisticUpdate(reports, "a", { status: "under_review" });
      expect(updated[0].status).toBe("under_review");
      expect(updated[1].status).toBe("resolved");
    });

    it("does not modify non-matching reports", () => {
      const reports = [makeReport("a", "2026-01-01")];
      const updated = applyOptimisticUpdate(reports, "b", { status: "resolved" });
      expect(updated[0].status).toBe("submitted");
    });

    it("preserves all other fields during optimistic update", () => {
      const reports = [makeReport("a", "2026-01-01")];
      const updated = applyOptimisticUpdate(reports, "a", { rewardStatus: "paid", updatedAt: "2026-06-15" });
      expect(updated[0].rewardStatus).toBe("paid");
      expect(updated[0].updatedAt).toBe("2026-06-15");
      expect(updated[0].id).toBe("a");
    });
  });

  describe("Status filtering before paging", () => {
    it("applies status filters before paging", () => {
      const page = paginateBugReports(
        [makeReport("resolved", "2026-01-02", "resolved"), makeReport("open", "2026-01-01")],
        { status: "resolved", limit: 10 },
      );
      expect(page.records.map((item) => item.id)).toEqual(["resolved"]);
    });

    it("continues after a record is deleted", () => {
      const initial = [
        makeReport("three", "2026-01-03"),
        makeReport("two", "2026-01-02"),
        makeReport("one", "2026-01-01"),
      ];
      const firstPage = paginateBugReports(initial, { limit: 2 });
      const secondPage = paginateBugReports(
        [makeReport("three", "2026-01-03"), makeReport("one", "2026-01-01")],
        { cursor: firstPage.nextCursor, limit: 2 },
      );
      expect(secondPage.records.map((item) => item.id)).toEqual(["one"]);
    });

    it("returns an empty page when all records after the cursor were deleted", () => {
      const firstPage = paginateBugReports(
        [makeReport("three", "2026-01-03"), makeReport("two", "2026-01-02")],
        { limit: 1 },
      );
      const nextPage = paginateBugReports(
        [makeReport("three", "2026-01-03")],
        { cursor: firstPage.nextCursor, limit: 1 },
      );

      expect(nextPage.records).toEqual([]);
      expect(nextPage.hasMore).toBe(false);
      expect(nextPage.nextCursor).toBeNull();
    });

    it("restarts at the first authorized record when the visibility scope changes", () => {
      const reports = [
        makeReport("private", "2026-01-03", "submitted", "medium", "functionality", "private-address"),
        makeReport("shared-2", "2026-01-02", "submitted", "medium", "functionality", "shared-address"),
        makeReport("shared-1", "2026-01-01", "submitted", "medium", "functionality", "shared-address"),
      ];
      const firstPage = paginateBugReports(reports, {
        limit: 1,
        visibilityScope: "viewer:admin:policy-v1",
      });
      const afterPermissionChange = paginateBugReports(reports, {
        cursor: firstPage.nextCursor,
        limit: 1,
        author: "shared-address",
        visibilityScope: "viewer:member:policy-v2",
      });

      expect(afterPermissionChange.records.map((item) => item.id)).toEqual(["shared-2"]);
    });
  });
});
