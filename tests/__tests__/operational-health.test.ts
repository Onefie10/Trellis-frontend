import {
  DEFAULT_ALERT_RULES,
  OPERATIONAL_CSV_HEADERS,
  aggregateOperationalUptimeStats,
  aggregateTopFailingRoutes,
  appendOperationalMetricSample,
  bugReportToExceptionEvent,
  buildErrorTrend,
  buildExceptionTrendReport,
  buildExecutiveOperationalReport,
  buildOperationalHealth,
  createAlertRule,
  deriveExceptionRoute,
  escapeCsvCell,
  evaluateAlertRules,
  filterExceptionEvents,
  formatOperationalMetricsCsv,
  generateOperationalReportPdf,
  groupExceptionEvents,
  isOperationalMetricSample,
  normalizeOperationalRoute,
  computePercentile,
  computeRollingLatency,
  evaluateServiceHealth,
  executeSyntheticProbe,
  SyntheticProbeManager,
} from "@/lib/operational-health";
import type { ExceptionEvent, ExternalServiceHealth, OperationalMetricSample, ProbeSampleRecord } from "@/lib/operational-health";
import type { BugReport } from "@/types/bug-report";

const baseReport: BugReport = {
  id: "BR-1",
  title: "Critical issue",
  description: "description",
  stepsToReproduce: "steps",
  expectedBehavior: "expected",
  actualBehavior: "actual",
  priority: "critical",
  category: "functionality",
  screenshots: [],
  reporterAddress: "private-address",
  reporterEmail: "private@example.com",
  status: "submitted",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rewardAmount: 10,
  rewardStatus: "pending",
};

test("aggregates actionable categories without exposing report details", () => {
  const health = buildOperationalHealth([baseReport], Date.parse("2026-01-10T00:00:00.000Z"));
  expect(health.categories.map((category) => category.count)).toEqual([1, 1, 0, 1]);
  expect(JSON.stringify(health)).not.toContain("private@example.com");
  expect(JSON.stringify(health)).not.toContain("private-address");
});

describe("operational metric stream buffer", () => {
  const sample = (ts: number): OperationalMetricSample => ({
    ts,
    heapUsedBytes: 64,
    heapTotalBytes: 128,
    activeConnections: 3,
    rpcLatencyMs: 42,
  });

  test("retains only the newest samples without mutating the previous buffer", () => {
    const original = [sample(1), sample(2)];
    const buffered = appendOperationalMetricSample(original, sample(3), 2);

    expect(buffered.map((entry) => entry.ts)).toEqual([2, 3]);
    expect(original.map((entry) => entry.ts)).toEqual([1, 2]);
  });

  test("validates incoming performance samples", () => {
    expect(isOperationalMetricSample(sample(1))).toBe(true);
    expect(isOperationalMetricSample({ ...sample(1), rpcLatencyMs: null })).toBe(true);
    expect(isOperationalMetricSample({ ...sample(1), heapTotalBytes: 0 })).toBe(false);
    expect(isOperationalMetricSample({ ...sample(1), activeConnections: -1 })).toBe(false);
  });
});

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-02-01T12:00:00.000Z");

function exceptionEvent(overrides: Partial<ExceptionEvent> = {}): ExceptionEvent {
  return {
    id: "ex-1",
    ts: NOW - MINUTE,
    kind: "rpc",
    severity: "error",
    component: "wallet",
    browserOS: "macOS",
    release: "v1.4.0",
    ...overrides,
  };
}

describe("buildErrorTrend", () => {
  test("buckets exceptions into contiguous fixed-width windows", () => {
    const buckets = buildErrorTrend(
      [
        exceptionEvent({ id: "a", ts: NOW - 55_000 }),
        exceptionEvent({ id: "b", ts: NOW - 60_000 }),
        exceptionEvent({ id: "c", ts: NOW - 45_000 }),
        exceptionEvent({ id: "d", ts: NOW - 5_000 }),
        exceptionEvent({ id: "past", ts: NOW - 61_000 }),
        exceptionEvent({ id: "future", ts: NOW }),
      ],
      { windowMs: 6 * 10_000, bucketMs: 10_000, now: NOW },
    );

    expect(buckets).toHaveLength(6);
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 1, 0, 0, 0, 1]);
    expect(buckets.map((bucket) => bucket.ratePerMinute)).toEqual([12, 6, 0, 0, 0, 6]);
    expect(buckets[0].bucketStart).toBe(NOW - 60_000);
    expect(buckets[0].bucketEnd).toBe(NOW - 50_000);
    expect(buckets[0].label).toBe("11:59");
    expect(buckets[5].bucketEnd).toBe(NOW);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index].bucketStart).toBe(buckets[index - 1].bucketEnd);
    }
  });

  test("counts severities per bucket", () => {
    const buckets = buildErrorTrend(
      [
        exceptionEvent({ id: "a", severity: "critical", ts: NOW - 1_000 }),
        exceptionEvent({ id: "b", severity: "warning", ts: NOW - 2_000 }),
      ],
      { windowMs: MINUTE, bucketMs: MINUTE, now: NOW },
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].bySeverity).toEqual({ warning: 1, error: 0, critical: 1 });
  });

  test("applies component, browser OS and release filters", () => {
    const events = [
      exceptionEvent({ id: "a", component: "wallet" }),
      exceptionEvent({ id: "b", component: "arena", browserOS: "Windows", release: "v1.5.0" }),
    ];

    expect(filterExceptionEvents(events, { component: "wallet" }).map((event) => event.id)).toEqual(["a"]);
    expect(filterExceptionEvents(events, { browserOS: "Windows" }).map((event) => event.id)).toEqual(["b"]);
    expect(filterExceptionEvents(events, { release: "v1.5.0" }).map((event) => event.id)).toEqual(["b"]);
    expect(
      buildErrorTrend(events, { windowMs: MINUTE, bucketMs: MINUTE, now: NOW, component: "arena" })[0].count,
    ).toBe(1);
  });

  test("rejects non-positive windows", () => {
    expect(() => buildErrorTrend([], { windowMs: 0, bucketMs: MINUTE, now: NOW })).toThrow();
    expect(() => buildErrorTrend([], { windowMs: MINUTE, bucketMs: 0, now: NOW })).toThrow();
  });
});

describe("groupExceptionEvents", () => {
  test("ranks groups by count then alphabetically", () => {
    const events = [
      exceptionEvent({ id: "a", component: "wallet" }),
      exceptionEvent({ id: "b", component: "arena" }),
      exceptionEvent({ id: "c", component: "wallet" }),
    ];

    expect(groupExceptionEvents(events, "component")).toEqual([
      { key: "wallet", count: 2 },
      { key: "arena", count: 1 },
    ]);
  });
});

describe("evaluateAlertRules", () => {
  const rpcRule = createAlertRule({
    id: "rpc",
    metric: "rpc-exceptions",
    threshold: 15,
    windowMinutes: 5,
    severity: "critical",
  });

  function rpcBurst(count: number, overrides: Partial<ExceptionEvent> = {}): ExceptionEvent[] {
    return Array.from({ length: count }, (_, index) =>
      exceptionEvent({ id: `burst-${index}`, kind: "rpc", ts: NOW - (index + 1) * 1_000, ...overrides }),
    );
  }

  test("breaches only when the count is strictly greater than the threshold", () => {
    expect(evaluateAlertRules(rpcBurst(16), [rpcRule], NOW)).toEqual([
      {
        ruleId: "rpc",
        ruleName: "RPC errors > 15 in 5 min",
        metric: "rpc-exceptions",
        threshold: 15,
        observed: 16,
        severity: "critical",
        windowStart: NOW - 5 * MINUTE,
        windowEnd: NOW,
      },
    ]);
    expect(evaluateAlertRules(rpcBurst(15), [rpcRule], NOW)).toEqual([]);
    expect(evaluateAlertRules(rpcBurst(14), [rpcRule], NOW)).toEqual([]);
  });

  test("ignores events outside the rule window and non-matching metrics", () => {
    const outside = exceptionEvent({ id: "old", ts: NOW - 6 * MINUTE });
    const wrongMetric = exceptionEvent({ id: "api", kind: "api", ts: NOW - 1_000 });
    expect(evaluateAlertRules([outside, wrongMetric], [rpcRule], NOW)).toEqual([]);
  });

  test("honours rule filters and disabled rules", () => {
    const filtered = createAlertRule({
      id: "rpc-wallet",
      metric: "rpc-exceptions",
      threshold: 15,
      windowMinutes: 5,
      filters: { component: "wallet" },
    });
    expect(evaluateAlertRules(rpcBurst(16, { component: "arena" }), [filtered], NOW)).toEqual([]);
    expect(evaluateAlertRules(rpcBurst(16), [filtered], NOW)).toHaveLength(1);
    expect(evaluateAlertRules(rpcBurst(16), [{ ...rpcRule, enabled: false }], NOW)).toEqual([]);
  });

  test("evaluates the default maintainer rules", () => {
    const breaches = evaluateAlertRules(rpcBurst(16), DEFAULT_ALERT_RULES, NOW);
    expect(breaches.map((breach) => breach.ruleId)).toEqual(["rpc-errors-5m"]);
  });
});

describe("createAlertRule", () => {
  test("normalises the threshold and window", () => {
    const rule = createAlertRule({ metric: "rpc-exceptions", threshold: 15.4, windowMinutes: 5 });
    expect(rule.threshold).toBe(15);
    expect(rule.windowMs).toBe(5 * MINUTE);
    expect(rule.severity).toBe("warning");
    expect(rule.name).toBe("RPC errors > 15 in 5 min");
    expect(rule.enabled).toBe(true);
  });

  test("rejects invalid thresholds and windows", () => {
    expect(() => createAlertRule({ metric: "exceptions", threshold: 0, windowMinutes: 5 })).toThrow();
    expect(() => createAlertRule({ metric: "exceptions", threshold: 5, windowMinutes: 0 })).toThrow();
    expect(() => createAlertRule({ metric: "exceptions", threshold: 5, windowMinutes: 2000 })).toThrow();
  });
});

describe("buildExceptionTrendReport", () => {
  test("combines trend buckets, groups and breaches", () => {
    const events = [
      ...Array.from({ length: 16 }, (_, index) =>
        exceptionEvent({
          id: `rpc-${index}`,
          kind: "rpc",
          severity: "critical",
          component: index % 2 === 0 ? "wallet" : "arena",
          browserOS: index % 2 === 0 ? "macOS" : "Windows",
          release: index % 2 === 0 ? "v1.4.0" : "v1.5.0",
          ts: NOW - (index + 1) * 1_000,
        }),
      ),
      exceptionEvent({ id: "outside", ts: NOW - 10 * MINUTE }),
    ];

    const report = buildExceptionTrendReport(events, {
      windowMs: 5 * MINUTE,
      bucketMs: MINUTE,
      now: NOW,
      rules: DEFAULT_ALERT_RULES,
    });

    expect(report.total).toBe(16);
    expect(report.buckets).toHaveLength(5);
    expect(report.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(16);
    expect(report.groups.component).toEqual([
      { key: "arena", count: 8 },
      { key: "wallet", count: 8 },
    ]);
    expect(report.groups.browserOS).toHaveLength(2);
    expect(report.groups.release).toHaveLength(2);
    expect(report.breaches.map((breach) => breach.ruleId)).toEqual(["critical-exceptions-10m", "rpc-errors-5m"]);
  });
});

describe("bugReportToExceptionEvent", () => {
  test("projects a report without leaking reporter data", () => {
    const event = bugReportToExceptionEvent(baseReport);
    expect(event).toEqual({
      id: "BR-EX-BR-1",
      ts: Date.parse("2026-01-01T00:00:00.000Z"),
      kind: "other",
      severity: "critical",
      component: "functionality",
      browserOS: "unknown",
      release: "unknown",
      code: "bug_report_functionality",
    });
    expect(JSON.stringify(event)).not.toContain("private@example.com");
    expect(JSON.stringify(event)).not.toContain("private-address");
  });
});

describe("synthetic probe rolling percentiles", () => {
  test("calculates p50, p95, p99 correctly", () => {
    // Array of 100 values: 10, 20, 30, ... 1000
    const latencies = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    const p50 = computePercentile(latencies, 50);
    const p95 = computePercentile(latencies, 95);
    const p99 = computePercentile(latencies, 99);

    expect(p50).toBeCloseTo(505, 0);
    expect(p95).toBeCloseTo(951, 0);
    expect(p99).toBeCloseTo(990, 0);
  });

  test("handles empty and single element arrays", () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([120], 95)).toBe(120);
  });

  test("computes rolling latency stats including min, max, avg", () => {
    const samples: ProbeSampleRecord[] = [
      { ts: Date.now() - 3000, latencyMs: 100, success: true },
      { ts: Date.now() - 2000, latencyMs: 200, success: true },
      { ts: Date.now() - 1000, latencyMs: 300, success: true },
      { ts: Date.now(), latencyMs: 0, success: false, error: "Network timeout", timedOut: true },
    ];

    const stats = computeRollingLatency(samples);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(300);
    expect(stats.avg).toBe(200);
    expect(stats.p50).toBe(200);
    expect(stats.samplesCount).toBe(4);
  });
});

describe("synthetic probe execution and timeout handling", () => {
  test("records successful probe latency when response is received within timeout", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
    } as Response);

    const result = await executeSyntheticProbe(
      {
        service: "horizon",
        label: "Horizon API",
        url: "https://horizon-testnet.stellar.org",
        timeoutMs: 2000,
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
  });

  test("handles probe timeout gracefully when HTTP request aborts", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const mockFetch = jest.fn().mockRejectedValue(abortError);

    const result = await executeSyntheticProbe(
      {
        service: "soroban-rpc",
        label: "Soroban RPC",
        url: "https://soroban-testnet.stellar.org",
        timeoutMs: 1000,
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  test("handles custom probeFn timeout and failure", async () => {
    const slowProbeFn = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true, latencyMs: 500 }), 300)),
    );

    const result = await executeSyntheticProbe({
      service: "ipfs",
      label: "IPFS Gateway",
      url: "https://ipfs.io",
      timeoutMs: 50,
      probeFn: slowProbeFn,
    });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });
});

describe("evaluateServiceHealth", () => {
  test("returns healthy when latency is within threshold and all samples succeed", () => {
    const samples: ProbeSampleRecord[] = Array.from({ length: 10 }, (_, i) => ({
      ts: Date.now() - i * 1000,
      latencyMs: 150,
      success: true,
    }));

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("healthy");
    expect(health.uptimePercentage).toBe(100);
    expect(health.consecutiveFailures).toBe(0);
  });

  test("triggers degraded status when p95 response latency exceeds threshold", () => {
    const samples: ProbeSampleRecord[] = [
      ...Array.from({ length: 15 }, (_, i) => ({
        ts: Date.now() - (i + 5) * 1000,
        latencyMs: 200,
        success: true,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: Date.now() - i * 1000,
        latencyMs: 2500,
        success: true,
      })),
    ];

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("degraded");
    expect(health.rollingLatency.p95).toBeGreaterThanOrEqual(1500);
  });

  test("triggers degraded status on recent timeout", () => {
    const samples: ProbeSampleRecord[] = [
      { ts: Date.now() - 2000, latencyMs: 200, success: true },
      { ts: Date.now() - 1000, latencyMs: 150, success: true },
      { ts: Date.now(), latencyMs: 3000, success: false, timedOut: true, error: "Timed out" },
    ];

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("degraded");
    expect(health.lastError).toBe("Timed out");
  });

  test("triggers down status when 3 or more consecutive failures occur", () => {
    const samples: ProbeSampleRecord[] = [
      { ts: Date.now() - 4000, latencyMs: 100, success: true },
      { ts: Date.now() - 3000, latencyMs: 1000, success: false, error: "Network error" },
      { ts: Date.now() - 2000, latencyMs: 1000, success: false, error: "Network error" },
      { ts: Date.now() - 1000, latencyMs: 1000, success: false, error: "Network error" },
    ];

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("down");
    expect(health.consecutiveFailures).toBe(3);
  });
});

describe("SyntheticProbeManager", () => {
  test("maintains rolling samples per service and computes health reports", async () => {
    const manager = new SyntheticProbeManager([
      {
        service: "horizon",
        label: "Horizon API",
        url: "https://horizon.example.com",
        degradedLatencyThresholdMs: 500,
      },
      {
        service: "soroban-rpc",
        label: "Soroban RPC",
        url: "https://soroban.example.com",
        degradedLatencyThresholdMs: 500,
      },
      {
        service: "ipfs",
        label: "IPFS Gateway",
        url: "https://ipfs.example.com",
        degradedLatencyThresholdMs: 500,
      },
    ]);

    manager.recordSample("horizon", { ts: Date.now(), latencyMs: 120, success: true });
    manager.recordSample("soroban-rpc", { ts: Date.now(), latencyMs: 800, success: true });
    manager.recordSample("ipfs", { ts: Date.now() - 2000, latencyMs: 200, success: true });
    manager.recordSample("ipfs", { ts: Date.now() - 1000, latencyMs: 220, success: true });
    manager.recordSample("ipfs", { ts: Date.now(), latencyMs: 2000, success: false, timedOut: true, error: "Timed out" });

    const horizonHealth = manager.getServiceHealth("horizon");
    expect(horizonHealth.status).toBe("healthy");
    expect(horizonHealth.rollingLatency.p50).toBe(120);

    const sorobanHealth = manager.getServiceHealth("soroban-rpc");
    expect(sorobanHealth.status).toBe("degraded");

    const ipfsHealth = manager.getServiceHealth("ipfs");
    expect(ipfsHealth.status).toBe("degraded");
    expect(ipfsHealth.lastError).toBe("Timed out");

    const all = manager.getAllServicesHealth();
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.service)).toEqual(["horizon", "soroban-rpc", "ipfs"]);
  });
});

describe("executive report data aggregation and top failing routes", () => {
  test("normalizes dynamic route segments and derives routes from exception events", () => {
    expect(
      normalizeOperationalRoute("/api/agents/550e8400-e29b-41d4-a716-446655440000?tab=logs"),
    ).toBe("/api/agents/:param");
    expect(normalizeOperationalRoute("marketplace/12345/details#top")).toBe(
      "/marketplace/:param/details",
    );

    const explicitRouteEvent = exceptionEvent({
      route: "/api/governance/987654/vote",
    });
    expect(deriveExceptionRoute(explicitRouteEvent)).toBe("/api/governance/:param/vote");

    const rpcEvent = exceptionEvent({ kind: "rpc", component: "soroban-submit" });
    expect(deriveExceptionRoute(rpcEvent)).toBe("/api/rpc/soroban-submit");

    const apiEvent = exceptionEvent({ kind: "api", component: "claims" });
    expect(deriveExceptionRoute(apiEvent)).toBe("/api/claims");
  });

  test("aggregates and ranks top failing routes with critical counts and share percentages", () => {
    const events: ExceptionEvent[] = [
      exceptionEvent({
        id: "r1",
        route: "/api/rpc/simulate",
        kind: "rpc",
        severity: "critical",
        ts: NOW - 10_000,
      }),
      exceptionEvent({
        id: "r2",
        route: "/api/rpc/simulate",
        kind: "rpc",
        severity: "error",
        ts: NOW - 5_000,
      }),
      exceptionEvent({
        id: "r3",
        route: "/api/rpc/simulate",
        kind: "rpc",
        severity: "critical",
        ts: NOW - 2_000,
      }),
      exceptionEvent({
        id: "r4",
        route: "/api/agents/12345",
        kind: "api",
        severity: "error",
        ts: NOW - 8_000,
      }),
      exceptionEvent({
        id: "r5",
        route: "/api/agents/67890",
        kind: "api",
        severity: "warning",
        ts: NOW - 4_000,
      }),
    ];

    const topRoutes = aggregateTopFailingRoutes(events, 5);
    expect(topRoutes).toHaveLength(2);
    expect(topRoutes[0]).toEqual({
      route: "/api/rpc/simulate",
      failureCount: 3,
      criticalCount: 2,
      errorRatePct: 60,
      dominantKind: "rpc",
      lastSeenAt: new Date(NOW - 2_000).toISOString(),
    });
    expect(topRoutes[1]).toEqual({
      route: "/api/agents/:param",
      failureCount: 2,
      criticalCount: 0,
      errorRatePct: 40,
      dominantKind: "api",
      lastSeenAt: new Date(NOW - 4_000).toISOString(),
    });
  });

  test("aggregates uptime statistics and builds executive operational report", () => {
    const externalServices: ExternalServiceHealth[] = [
      {
        service: "horizon",
        label: "Stellar Horizon API",
        endpoint: "https://horizon-testnet.stellar.org",
        status: "healthy",
        lastCheckedAt: new Date(NOW).toISOString(),
        lastLatencyMs: 110,
        rollingLatency: { p50: 110, p95: 180, p99: 210, min: 90, max: 210, avg: 120, samplesCount: 20 },
        uptimePercentage: 100,
        consecutiveFailures: 0,
        lastError: null,
      },
      {
        service: "soroban-rpc",
        label: "Stellar Soroban RPC",
        endpoint: "https://soroban-testnet.stellar.org",
        status: "degraded",
        lastCheckedAt: new Date(NOW).toISOString(),
        lastLatencyMs: 950,
        rollingLatency: { p50: 420, p95: 1600, p99: 1900, min: 200, max: 1900, avg: 510, samplesCount: 20 },
        uptimePercentage: 95,
        consecutiveFailures: 1,
        lastError: "High latency",
      },
    ];

    const metricSamples: OperationalMetricSample[] = [
      { ts: NOW - 20_000, heapUsedBytes: 60, heapTotalBytes: 100, activeConnections: 4, rpcLatencyMs: 120 },
      { ts: NOW - 10_000, heapUsedBytes: 85, heapTotalBytes: 100, activeConnections: 6, rpcLatencyMs: 240 },
    ];

    const uptime = aggregateOperationalUptimeStats({
      externalServices,
      metricSamples,
      slaTargetPercentage: 99.0,
    });

    expect(uptime.overallUptimePercentage).toBe(97.5);
    expect(uptime.slaMet).toBe(false);
    expect(uptime.healthyServicesCount).toBe(1);
    expect(uptime.degradedServicesCount).toBe(1);
    expect(uptime.downServicesCount).toBe(0);
    expect(uptime.avgRpcLatencyMs).toBe(180);
    expect(uptime.peakHeapUsageRatio).toBe(0.85);

    const events: ExceptionEvent[] = [
      exceptionEvent({ id: "e1", ts: NOW - 5 * MINUTE, kind: "rpc", severity: "critical", route: "/api/rpc/invoke" }),
      exceptionEvent({ id: "e2", ts: NOW - 4 * MINUTE, kind: "rpc", severity: "error", route: "/api/rpc/invoke" }),
      exceptionEvent({ id: "e3", ts: NOW - 3 * MINUTE, kind: "api", severity: "warning", route: "/api/claims" }),
    ];

    const execReport = buildExecutiveOperationalReport({
      now: NOW,
      windowMinutes: 60,
      bucketMinutes: 5,
      health: buildOperationalHealth([baseReport], NOW),
      exceptionEvents: events,
      metricSamples,
      externalServices,
    });

    expect(execReport.windowMinutes).toBe(60);
    expect(execReport.uptime.overallUptimePercentage).toBe(97.5);
    expect(execReport.errorTrends.totalExceptions).toBe(3);
    expect(execReport.errorTrends.criticalExceptions).toBe(1);
    expect(execReport.errorTrends.rpcExceptions).toBe(2);
    expect(execReport.errorTrends.trendDirection).toBe("degrading");
    expect(execReport.topFailingRoutes[0].route).toBe("/api/rpc/invoke");
    expect(execReport.topFailingRoutes[0].failureCount).toBe(2);
  });
});

describe("operational metrics CSV formatting", () => {
  test("escapes commas, quotes, newlines, and formula injection characters", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
    expect(escapeCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
  });

  test("formats raw time-series metric samples and error trend buckets into structured CSV", () => {
    const samples: OperationalMetricSample[] = [
      {
        ts: Date.parse("2026-02-01T11:58:00.000Z"),
        heapUsedBytes: 50 * 1024 * 1024,
        heapTotalBytes: 100 * 1024 * 1024,
        activeConnections: 5,
        rpcLatencyMs: 85,
      },
      {
        ts: Date.parse("2026-02-01T11:59:00.000Z"),
        heapUsedBytes: 75 * 1024 * 1024,
        heapTotalBytes: 100 * 1024 * 1024,
        activeConnections: 8,
        rpcLatencyMs: null,
      },
    ];

    const buckets = buildErrorTrend(
      [
        exceptionEvent({ id: "ex-csv-1", ts: NOW - 30_000, severity: "critical" }),
        exceptionEvent({ id: "ex-csv-2", ts: NOW - 20_000, severity: "warning" }),
      ],
      { windowMs: MINUTE, bucketMs: MINUTE, now: NOW },
    );

    const csv = formatOperationalMetricsCsv(samples, buckets);
    const lines = csv.split("\n");

    expect(lines[0]).toBe(OPERATIONAL_CSV_HEADERS.join(","));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("2026-02-01T11:58:00.000Z,system_performance,52428800,104857600,50.00,5,85");
    expect(lines[2]).toContain("2026-02-01T11:59:00.000Z,system_performance,78643200,104857600,75.00,8,");
    expect(lines[3]).toContain("2026-02-01T11:59:00.000Z,exception_trend,,,,,,2,2.00,1,0,1");
  });

  test("generates a printable PDF 1.4 executive report containing uptime, error trends, and top failing routes", () => {
    const execReport = buildExecutiveOperationalReport({
      now: NOW,
      windowMinutes: 60,
      bucketMinutes: 5,
      health: buildOperationalHealth([baseReport], NOW),
      exceptionEvents: [
        exceptionEvent({ id: "pdf-1", ts: NOW - 60_000, kind: "rpc", severity: "critical", route: "/api/rpc/simulate" }),
      ],
      metricSamples: [
        { ts: NOW - 30_000, heapUsedBytes: 50, heapTotalBytes: 100, activeConnections: 4, rpcLatencyMs: 110 },
      ],
    });

    const pdfBytes = generateOperationalReportPdf(execReport);
    const pdfContent = new TextDecoder().decode(pdfBytes);

    expect(pdfContent.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdfContent).toContain("TRELLIS OPERATIONAL HEALTH - EXECUTIVE REPORT");
    expect(pdfContent).toContain("1. Uptime & Service Reliability Statistics");
    expect(pdfContent).toContain("3. Error Trends & Alert Rule Evaluation");
    expect(pdfContent).toContain("4. Top Failing Routes");
    expect(pdfContent).toContain("/api/rpc/simulate");
    expect(pdfContent.trim().endsWith("%%EOF")).toBe(true);
  });
});

