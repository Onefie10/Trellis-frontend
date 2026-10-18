import {
  TIMELINE_COLUMNS,
  buildTimelineExport,
  escapeCsvCell,
  eventToRow,
  exportFilename,
  exportSummary,
  timelineToCsv,
  timelineToJson,
  toCsv,
} from "../redaction/exporter";
import { redactTimelineEvent, redactTimelineEvents } from "../redaction/redactor";
import type { RedactedTimelineEvent } from "../redaction/redactor";
import {
  EMPTY_TIMELINE_QUERY,
  buildQueryFromInputs,
  filterTimelineEvents,
  isQueryActive,
  matchesQuery,
  parseDateInput,
} from "../filters";
import type { TimelineEvent } from "../types";

const NOW = new Date("2026-09-27T05:30:00.000Z");

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt-1",
    userId: "user-1",
    type: "claim_settled",
    visibility: "private",
    timestamp: Date.parse("2026-09-27T05:00:00.000Z"),
    title: "Claim settled",
    description: "Your claim was settled.",
    ...overrides,
  };
}

function redacted(overrides: Partial<TimelineEvent> = {}): RedactedTimelineEvent {
  return redactTimelineEvent(event(overrides)).value;
}

describe("CSV cell escaping", () => {
  it("leaves ordinary values unquoted", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell(42)).toBe("42");
    expect(escapeCsvCell(true)).toBe("true");
  });

  it("renders null and undefined as empty cells", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("quotes cells containing a comma, quote or newline", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(escapeCsvCell("-5")).toBe("'-5");
    expect(escapeCsvCell("@import")).toBe("'@import");
    expect(escapeCsvCell("\tcmd")).toBe("'\tcmd");
  });

  it("serialises objects as JSON", () => {
    expect(escapeCsvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe("toCsv", () => {
  it("writes a header, CRLF rows and a trailing newline", () => {
    expect(toCsv(["a", "b"], [[1, 2]])).toBe("a,b\r\n1,2\r\n");
  });

  it("handles an empty row set", () => {
    expect(toCsv(["a"], [])).toBe("a\r\n");
  });
});

describe("timeline export", () => {
  it("uses a fixed, documented column order", () => {
    const csv = timelineToCsv([redacted()]);
    const [header] = csv.split("\r\n");
    expect(header).toBe(TIMELINE_COLUMNS.join(","));
    expect(TIMELINE_COLUMNS).toContain("isoTimestamp");
    expect(TIMELINE_COLUMNS).toContain("redactionFindings");
  });

  it("exposes the derived severity in each row", () => {
    const row = eventToRow(redacted({ type: "claim_rejected" }));
    expect(row[TIMELINE_COLUMNS.indexOf("severity")]).toBe("error");
    expect(row[TIMELINE_COLUMNS.indexOf("isoTimestamp")]).toBe("2026-09-27T05:00:00.000Z");
  });

  it("exports only redacted text", () => {
    const csv = timelineToCsv([
      redacted({ description: "settled from 10.0.0.5 for alice@example.com" }),
    ]);
    expect(csv).toContain("[REDACTED:IPV4]");
    expect(csv).toContain("[REDACTED:EMAIL]");
    expect(csv).not.toContain("10.0.0.5");
    expect(csv).not.toContain("alice@example.com");
  });

  it("produces valid JSON with a count and redacted events", () => {
    const parsed = JSON.parse(timelineToJson([redacted(), redacted({ id: "evt-2" })]));
    expect(parsed.count).toBe(2);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].severity).toBe("success");
    expect(typeof parsed.exportedAt).toBe("string");
  });

  it("builds a CSV export descriptor", () => {
    const exported = buildTimelineExport(
      [redacted({ description: "from 10.0.0.1" })],
      "csv",
      { now: NOW },
    );
    expect(exported.format).toBe("csv");
    expect(exported.filename).toBe("timeline-2026-09-27T05-30-00-000Z.csv");
    expect(exported.mimeType).toContain("text/csv");
    expect(exported.rowCount).toBe(1);
    expect(exported.redactedCount).toBe(1);
    expect(exported.byteLength).toBeGreaterThan(0);
    expect(exported.findings).toEqual([expect.objectContaining({ label: "IPV4", count: 1 })]);
  });

  it("builds a JSON export descriptor with its own extension", () => {
    const exported = buildTimelineExport([redacted()], "json", { now: NOW });
    expect(exported.filename).toBe("timeline-2026-09-27T05-30-00-000Z.json");
    expect(exported.mimeType).toContain("application/json");
    expect(JSON.parse(exported.contents).count).toBe(1);
  });

  it("says so when nothing needed redacting", () => {
    const exported = buildTimelineExport([redacted()], "json", { now: NOW });
    expect(exported.redactedCount).toBe(0);
    expect(exportSummary(exported)).toMatch(/no sensitive data was present/i);
  });

  it("names what was redacted in the confirmation", () => {
    const { value, redactedCount } = redactTimelineEvents([
      event({ description: "from 10.0.0.1" }),
    ]);
    expect(redactedCount).toBe(1);
    const exported = buildTimelineExport(value, "csv", { now: NOW, redactedCount });
    expect(exportSummary(exported)).toMatch(/1 value\(s\) redacted/);
    expect(exportSummary(exported)).toMatch(/IPV4/);
  });

  it("produces a filename-safe timestamp", () => {
    expect(exportFilename("csv", NOW)).toBe("timeline-2026-09-27T05-30-00-000Z.csv");
    expect(exportFilename("json", NOW)).toMatch(/\.json$/);
  });

  it("keeps CSV free of a leaked Stellar secret key", () => {
    const secret = `S${"A".repeat(55)}`;
    const csv = timelineToCsv([redacted({ description: `leaked ${secret}` })]);
    expect(csv).not.toContain(secret);
    expect(csv).toContain("STELLAR_SECRET_KEY");
  });
});

describe("date range parsing", () => {
  it("returns local midnight for a start bound", () => {
    expect(parseDateInput("2026-09-27", "start")).toBe(
      new Date(2026, 8, 27, 0, 0, 0, 0).getTime(),
    );
  });

  it("returns the last millisecond of the day for an end bound", () => {
    expect(parseDateInput("2026-09-27", "end")).toBe(
      new Date(2026, 8, 27, 23, 59, 59, 999).getTime(),
    );
  });

  it("rejects blank and malformed input", () => {
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("27/09/2026")).toBeNull();
    expect(parseDateInput("2026-9-7")).toBeNull();
  });
});

describe("timeline query building", () => {
  it("starts inactive", () => {
    expect(isQueryActive(EMPTY_TIMELINE_QUERY)).toBe(false);
    expect(isQueryActive({ text: "   " })).toBe(false);
  });

  it("becomes active once any control is used", () => {
    expect(isQueryActive({ text: "payout" })).toBe(true);
    expect(isQueryActive({ from: 1 })).toBe(true);
    expect(isQueryActive({ severities: ["error"] })).toBe(true);
    expect(isQueryActive({ types: ["claim_settled"] })).toBe(true);
  });

  it("ignores a blank date input and drops unknown severities", () => {
    const query = buildQueryFromInputs({
      text: "payout",
      from: "",
      to: "2026-09-27",
      severities: ["error", "nonsense"],
    });
    expect(query.from).toBeNull();
    expect(query.to).toBe(parseDateInput("2026-09-27", "end"));
    expect(query.severities).toEqual(["error"]);
  });
});

describe("filtering", () => {
  const events: TimelineEvent[] = [
    event({ id: "a", type: "claim_settled", description: "Payout settled", timestamp: 1000 }),
    event({ id: "b", type: "claim_rejected", description: "Rejected", timestamp: 2000 }),
    event({
      id: "c",
      type: "payout_requested",
      description: "Requested",
      resourceId: "agency-77",
      timestamp: 3000,
    }),
  ];

  it("matches free text case-insensitively across title and description", () => {
    expect(filterTimelineEvents(events, { text: "SETTLED" }).map((e) => e.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("matches on the resource id even when the description does not", () => {
    expect(filterTimelineEvents(events, { text: "agency-77" }).map((e) => e.id)).toEqual(["c"]);
  });

  it("applies inclusive date bounds", () => {
    expect(filterTimelineEvents(events, { from: 2000, to: 3000 }).map((e) => e.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("filters by severity", () => {
    expect(filterTimelineEvents(events, { severities: ["error"] }).map((e) => e.id)).toEqual([
      "b",
    ]);
    expect(
      filterTimelineEvents(events, { severities: ["error", "warning"] }).map((e) => e.id),
    ).toEqual(["b", "c"]);
  });

  it("filters by event type", () => {
    expect(
      filterTimelineEvents(events, { types: ["claim_settled"] }).map((e) => e.id),
    ).toEqual(["a"]);
  });

  it("combines criteria with AND semantics", () => {
    expect(
      filterTimelineEvents(events, { text: "requested", severities: ["error"] }),
    ).toEqual([]);
    expect(
      filterTimelineEvents(events, { text: "requested", severities: ["warning"] }).map((e) => e.id),
    ).toEqual(["c"]);
  });

  it("treats an empty query as a pass-through", () => {
    expect(filterTimelineEvents(events, EMPTY_TIMELINE_QUERY)).toHaveLength(3);
    expect(matchesQuery(events[0], {})).toBe(true);
  });

  it("searches the redacted description, not the raw payload", () => {
    const scrubbed = redactTimelineEvents([
      event({ id: "d", description: "settled from 10.0.0.5" }),
    ]).value;
    expect(filterTimelineEvents(scrubbed, { text: "10.0.0.5" })).toEqual([]);
    expect(filterTimelineEvents(scrubbed, { text: "IPV4" })).toHaveLength(1);
  });
});
