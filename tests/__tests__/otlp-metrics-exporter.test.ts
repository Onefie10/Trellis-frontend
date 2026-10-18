import {
  AGGREGATION_TEMPORALITY_DELTA,
  DEFAULT_HISTOGRAM_BUCKET_BOUNDS,
  OtlpMetricExporter,
  aggregateMetricPoints,
  canonicalAttributesKey,
  getOtlpExporterConfig,
  normalizeMetricPoint,
  parseOtlpHeaders,
  resolveOtlpMetricsEndpoint,
  sanitizeMetricAttributes,
  toOtlpPayload,
  toUnixNano,
} from "@/lib/metric-definitions";
import type { MetricPoint } from "@/lib/metric-definitions";

function point(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    name: "system.api_call",
    kind: "counter",
    value: 1,
    timestamp: 1_700_000_000_000,
    attributes: { route: "wallet" },
    ...overrides,
  };
}

function findMetric(payload: ReturnType<typeof toOtlpPayload>, name: string) {
  return payload.resourceMetrics[0].scopeMetrics[0].metrics.find(
    (metric) => metric.name === name,
  )!;
}

describe("OTLP exporter configuration", () => {
  it("appends the metrics signal path to a base endpoint", () => {
    expect(resolveOtlpMetricsEndpoint("http://localhost:4318")).toBe(
      "http://localhost:4318/v1/metrics",
    );
    expect(resolveOtlpMetricsEndpoint("http://localhost:4318/")).toBe(
      "http://localhost:4318/v1/metrics",
    );
  });

  it("keeps an explicit signal endpoint untouched", () => {
    expect(resolveOtlpMetricsEndpoint("http://collector:4318/v1/metrics")).toBe(
      "http://collector:4318/v1/metrics",
    );
  });

  it("returns null for missing endpoints", () => {
    expect(resolveOtlpMetricsEndpoint(undefined)).toBeNull();
    expect(resolveOtlpMetricsEndpoint("   ")).toBeNull();
  });

  it("parses the OTLP key=value header list", () => {
    expect(parseOtlpHeaders("authorization=Bearer abc, x-tenant=trellis")).toEqual({
      authorization: "Bearer abc",
      "x-tenant": "trellis",
    });
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("garbage")).toEqual({});
  });

  it("reads endpoint, protocol, headers and interval from the environment", () => {
    const config = getOtlpExporterConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer tok",
      OTEL_SERVICE_NAME: "trellis-web",
      OTEL_METRIC_EXPORT_INTERVAL: "15000",
    });

    expect(config.endpoint).toBe("http://otel-collector:4318/v1/metrics");
    expect(config.protocol).toBe("grpc");
    expect(config.headers.authorization).toBe("Bearer tok");
    expect(config.serviceName).toBe("trellis-web");
    expect(config.intervalMs).toBe(15_000);
  });

  it("prefers the metrics-specific endpoint and NEXT_PUBLIC vars", () => {
    const config = getOtlpExporterConfig({
      NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example.com/otlp",
    });

    expect(config.endpoint).toBe("https://metrics.example.com/otlp/v1/metrics");
  });

  it("falls back to safe defaults when the environment is empty", () => {
    const config = getOtlpExporterConfig({});

    expect(config.endpoint).toBeNull();
    expect(config.protocol).toBe("http/json");
    expect(config.serviceName).toBe("trellis-frontend");
    expect(config.intervalMs).toBe(30_000);
    expect(config.allowUnsafeMetrics).toBe(false);
  });
});

describe("Metric privacy boundary", () => {
  it("drops blocked attribute keys and scrubs identifiers", () => {
    const safe = sanitizeMetricAttributes({
      route: "wallet",
      wallet_address: "GABCDEF",
      email: "user@example.com",
      note: "contact user@example.com",
    });

    expect(safe.route).toBe("wallet");
    expect(safe.wallet_address).toBeUndefined();
    expect(safe.email).toBeUndefined();
    expect(safe.note).toBe("contact [redacted]");
  });

  it("keeps numeric and boolean attributes", () => {
    expect(sanitizeMetricAttributes({ retries: 3, cached: true })).toEqual({
      retries: 3,
      cached: true,
    });
  });

  it("rejects metrics outside the safe allow-list", () => {
    expect(normalizeMetricPoint(point({ name: "user.email_captured" }))).toBeNull();
    expect(normalizeMetricPoint(point({ name: "constructor" }))).toBeNull();
    expect(normalizeMetricPoint(point({ name: "toString" }))).toBeNull();
    expect(normalizeMetricPoint(point())).not.toBeNull();
  });

  it("allows unknown metric names only when explicitly opted in", () => {
    const result = normalizeMetricPoint(point({ name: "custom.metric" }), {
      allowUnsafeMetrics: true,
    });
    expect(result?.name).toBe("custom.metric");
  });

  it("rejects non-finite values", () => {
    expect(normalizeMetricPoint(point({ value: Number.NaN }))).toBeNull();
    expect(normalizeMetricPoint(point({ value: Number.POSITIVE_INFINITY }))).toBeNull();
  });
});

describe("Metric batch aggregation", () => {
  it("sums counter points into a single series", () => {
    const aggregated = aggregateMetricPoints([
      point({ value: 2 }),
      point({ value: 3 }),
    ]);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].kind).toBe("counter");
    expect(aggregated[0].count).toBe(2);
    expect(aggregated[0].sum).toBe(5);
    expect(aggregated[0].last).toBe(3);
  });

  it("keeps the last value for gauges", () => {
    const aggregated = aggregateMetricPoints([
      point({ kind: "gauge", value: 10 }),
      point({ kind: "gauge", value: 42 }),
    ]);

    expect(aggregated[0].last).toBe(42);
    expect(aggregated[0].sum).toBe(52);
    expect(aggregated[0].min).toBe(10);
    expect(aggregated[0].max).toBe(42);
  });

  it("buckets histogram samples against the explicit bounds", () => {
    const aggregated = aggregateMetricPoints([
      point({ kind: "histogram", value: 3 }),
      point({ kind: "histogram", value: 40 }),
      point({ kind: "histogram", value: 50_000 }),
    ]);

    const [histogram] = aggregated;
    expect(histogram.explicitBounds).toEqual([...DEFAULT_HISTOGRAM_BUCKET_BOUNDS]);
    expect(histogram.bucketCounts).toHaveLength(DEFAULT_HISTOGRAM_BUCKET_BOUNDS.length + 1);
    // 3 -> first bucket, 40 -> [25,50) , 50_000 -> overflow bucket
    expect(histogram.bucketCounts?.[0]).toBe(1);
    expect(histogram.bucketCounts?.[3]).toBe(1);
    expect(histogram.bucketCounts?.at(-1)).toBe(1);
    expect(histogram.count).toBe(3);
    expect(histogram.sum).toBe(50_043);
    expect(histogram.min).toBe(3);
    expect(histogram.max).toBe(50_000);
  });

  it("honours custom bucket bounds", () => {
    const [histogram] = aggregateMetricPoints(
      [point({ kind: "histogram", value: 7 })],
      { bucketBounds: [1, 5, 10] },
    );

    expect(histogram.explicitBounds).toEqual([1, 5, 10]);
    expect(histogram.bucketCounts).toEqual([0, 0, 1, 0]);
  });

  it("separates series by attributes and kind", () => {
    const aggregated = aggregateMetricPoints([
      point({ attributes: { route: "wallet" } }),
      point({ attributes: { route: "chart" } }),
      point({ kind: "gauge", attributes: { route: "wallet" } }),
    ]);

    expect(aggregated).toHaveLength(3);
    expect(canonicalAttributesKey(aggregated[0].attributes)).toContain("route=");
  });

  it("tracks timestamps across the batch", () => {
    const [counter] = aggregateMetricPoints([
      point({ timestamp: 1_000 }),
      point({ timestamp: 2_000 }),
    ]);

    expect(counter.firstTimestamp).toBe(1_000);
    expect(counter.lastTimestamp).toBe(2_000);
  });

  it("drops unsafe metrics while aggregating", () => {
    const aggregated = aggregateMetricPoints([
      point({ name: "user.secret_leak" }),
      point({ name: "system.api_error" }),
    ]);

    expect(aggregated.map((metric) => metric.name)).toEqual(["system.api_error"]);
  });

  it("returns an empty batch for empty input", () => {
    expect(aggregateMetricPoints([])).toEqual([]);
  });
});

describe("OTLP payload formatting", () => {
  it("encodes counters as monotonic delta sums", () => {
    const aggregated = aggregateMetricPoints([point({ value: 4 })]);
    const payload = toOtlpPayload(aggregated, { serviceName: "trellis-web" });
    const metric = findMetric(payload, "system.api_call");

    expect(metric.sum?.aggregationTemporality).toBe(AGGREGATION_TEMPORALITY_DELTA);
    expect(metric.sum?.isMonotonic).toBe(true);
    expect(metric.sum?.dataPoints[0].asDouble).toBe(4);
    expect(metric.sum?.dataPoints[0].attributes).toEqual([
      { key: "route", value: { stringValue: "wallet" } },
    ]);
  });

  it("encodes gauges with the last observed value", () => {
    const aggregated = aggregateMetricPoints([
      point({ kind: "gauge", name: "system.performance", value: 12.5 }),
    ]);
    const metric = findMetric(toOtlpPayload(aggregated), "system.performance");

    expect(metric.gauge?.dataPoints[0].asDouble).toBe(12.5);
    expect(metric.sum).toBeUndefined();
  });

  it("encodes histograms with string bucket counts and explicit bounds", () => {
    const aggregated = aggregateMetricPoints([
      point({ kind: "histogram", name: "transaction.time_to_complete", value: 30 }),
    ]);
    const metric = findMetric(
      toOtlpPayload(aggregated),
      "transaction.time_to_complete",
    );

    expect(metric.unit).toBe("ms");
    expect(metric.histogram?.aggregationTemporality).toBe(AGGREGATION_TEMPORALITY_DELTA);
    const dataPoint = metric.histogram!.dataPoints[0];
    expect(dataPoint.count).toBe(1);
    expect(dataPoint.sum).toBe(30);
    expect(dataPoint.bucketCounts.every((count) => typeof count === "string")).toBe(true);
    expect(dataPoint.explicitBounds).toEqual([...DEFAULT_HISTOGRAM_BUCKET_BOUNDS]);
  });

  it("converts millisecond timestamps to int64 nanosecond strings", () => {
    expect(toUnixNano(1_700_000_000_000)).toBe("1700000000000000000");

    const aggregated = aggregateMetricPoints([point({ timestamp: 1_700_000_000_000 })]);
    const dataPoint = findMetric(toOtlpPayload(aggregated), "system.api_call").sum!
      .dataPoints[0];
    expect(dataPoint.timeUnixNano).toBe("1700000000000000000");
  });

  it("includes the service resource attribute", () => {
    const payload = toOtlpPayload([], { serviceName: "trellis-frontend" });
    const resource = payload.resourceMetrics[0].resource.attributes;

    expect(resource).toContainEqual({
      key: "service.name",
      value: { stringValue: "trellis-frontend" },
    });
  });

  it("scrubs sensitive resource attributes", () => {
    const payload = toOtlpPayload([], {
      resourceAttributes: { environment: "production", email: "ops@example.com" },
    });
    const keys = payload.resourceMetrics[0].resource.attributes.map((entry) => entry.key);

    expect(keys).toContain("environment");
    expect(keys).not.toContain("email");
  });

  it("sorts attribute lists deterministically", () => {
    const aggregated = aggregateMetricPoints([
      point({ attributes: { zebra: "z", alpha: "a" } }),
    ]);
    const attributes = findMetric(toOtlpPayload(aggregated), "system.api_call").sum!
      .dataPoints[0].attributes;

    expect(attributes.map((entry) => entry.key)).toEqual(["alpha", "zebra"]);
  });
});

describe("OtlpMetricExporter transmission", () => {
  const endpoint = "https://collector.example.com/v1/metrics";

  function makeExporter(fetchImpl: typeof fetch) {
    return new OtlpMetricExporter(
      { endpoint, serviceName: "trellis-frontend" },
      { configFromEnv: {}, fetchImpl },
    );
  }

  it("transmits a formatted OTLP request to the collector", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = makeExporter(fetchImpl as unknown as typeof fetch);

    exporter.recordCounter("system.api_call", 1, { route: "wallet" });
    exporter.recordGauge("system.performance", 128);
    const result = await exporter.flush();

    expect(result.ok).toBe(true);
    expect(result.metricCount).toBe(2);
    expect(result.transport).toBe("http/json");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.map((metric: { name: string }) => metric.name).sort()).toEqual([
      "system.api_call",
      "system.performance",
    ]);
  });

  it("sends configured collector headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = new OtlpMetricExporter(
      { endpoint, headers: { authorization: "Bearer token" } },
      { configFromEnv: {}, fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    exporter.recordCounter("system.api_call");
    await exporter.flush();

    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer token");
  });

  it("clears the queue after a successful flush", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = makeExporter(fetchImpl as unknown as typeof fetch);

    exporter.recordCounter("system.api_call");
    expect(exporter.pendingCount).toBe(1);
    await exporter.flush();
    expect(exporter.pendingCount).toBe(0);
  });

  it("skips the network call when there is nothing buffered", async () => {
    const fetchImpl = jest.fn();
    const exporter = makeExporter(fetchImpl as unknown as typeof fetch);

    const result = await exporter.flush();

    expect(result.ok).toBe(true);
    expect(result.pointCount).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a missing endpoint and keeps the batch", async () => {
    const fetchImpl = jest.fn();
    const exporter = new OtlpMetricExporter(
      { endpoint: null },
      { configFromEnv: {}, fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    exporter.recordCounter("system.api_call");
    const result = await exporter.flush();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_endpoint_configured");
    expect(exporter.pendingCount).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-queues the batch when the collector rejects it", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const exporter = makeExporter(fetchImpl as unknown as typeof fetch);

    exporter.recordCounter("system.api_call");
    const result = await exporter.flush();

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain("503");
    expect(exporter.pendingCount).toBe(1);
  });

  it("re-queues the batch when the request throws", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
    const exporter = makeExporter(fetchImpl as unknown as typeof fetch);

    exporter.recordCounter("system.api_call");
    const result = await exporter.flush();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("network down");
    expect(exporter.pendingCount).toBe(1);
  });

  it("refuses to buffer metrics outside the privacy boundary", () => {
    const exporter = makeExporter(jest.fn() as unknown as typeof fetch);

    expect(exporter.recordCounter("user.email_captured")).toBe(false);
    expect(exporter.pendingCount).toBe(0);
    expect(exporter.recordHistogram("transaction.time_to_complete", 42)).toBe(true);
  });

  it("caps the buffer at the configured queue size", () => {
    const exporter = new OtlpMetricExporter(
      { endpoint, maxQueueSize: 3 },
      { configFromEnv: {}, fetchImpl: jest.fn() as unknown as typeof fetch },
    );

    for (let index = 0; index < 10; index += 1) {
      exporter.recordCounter("system.api_call");
    }

    expect(exporter.pendingCount).toBe(3);
  });

  it("periodically flushes while running", async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = makeExporter(fetchImpl as unknown as typeof fetch);

    exporter.recordCounter("system.api_call");
    exporter.start(1_000);
    expect(exporter.isRunning).toBe(true);

    await jest.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    exporter.stop();
    expect(exporter.isRunning).toBe(false);
    jest.useRealTimers();
  });

  it("does not start a second timer when already running", () => {
    jest.useFakeTimers();
    const exporter = makeExporter(jest.fn() as unknown as typeof fetch);

    exporter.start(1_000);
    exporter.start(1_000);
    exporter.stop();

    expect(exporter.isRunning).toBe(false);
    jest.useRealTimers();
  });
});
