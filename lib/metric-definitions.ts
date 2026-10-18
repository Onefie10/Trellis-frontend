/**
 * Metric Definitions & Privacy Boundaries
 *
 * Documents safe metrics and retention behavior.
 */

export const SAFE_METRICS = {
  // User engagement
  "user.session_start": "User starts a session",
  "user.session_end": "User ends a session",
  "user.feature_used": "User accesses a feature",
  "user.interaction_count": "Number of interactions in a session",

  // Transaction flow
  "transaction.initiated": "User starts a transaction",
  "transaction.completed": "Transaction succeeds",
  "transaction.failed": "Transaction fails",
  "transaction.time_to_complete": "Time taken to complete transaction",

  // System health
  "system.api_call": "API call made",
  "system.api_error": "API error occurred",
  "system.performance": "System performance metric",
  "system.network_latency": "Network latency measurement",

  // Error tracking
  "error.client_error": "Client-side error",
  "error.validation_error": "Validation error",
  "error.network_error": "Network error",
  "error.auth_error": "Authentication error",

  // Wallet operations
  "wallet.connection_attempt": "Wallet connection attempt",
  "wallet.connection_success": "Successful wallet connection",
  "wallet.disconnection": "Wallet disconnection",

  // Idempotency (request deduplication, see lib/idempotency.ts)
  "idempotency.requests": "Idempotent write attempted",
  "idempotency.hits": "Duplicate submission absorbed by a stored or in-flight result",
  "idempotency.collisions": "Idempotency key reused for another payload or while in progress",
  "idempotency.retries": "Idempotent write re-run after a failed or abandoned attempt",
  "idempotency.expired": "Idempotency key used after its replay window",

  // Feature adoption
  "feature.tutorial_started": "User starts tutorial",
  "feature.tutorial_completed": "User completes tutorial",
  "feature.feature_enabled": "Feature is enabled",
  "feature.feature_disabled": "Feature is disabled",
};

export const BLOCKED_FIELDS = [
  "password",
  "secret",
  "token",
  "api_key",
  "private_key",
  "seed",
  "mnemonic",
  "wallet_private_key",
  "email",
  "phone",
  "ssn",
  "credit_card",
  "wallet_address",
  "public_key",
  "signature",
  "payload",
  "transaction_data",
  "user_id",
  "email_address",
  "phone_number",
];

export const RETENTION_POLICY = {
  aggregated_metrics: "90 days",
  error_logs: "30 days",
  performance_data: "7 days",
  user_events: "90 days",
} as const;

/**
 * Check if a metric is safe to record
 */
export function isMetricSafe(metricName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SAFE_METRICS, metricName);
}

/**
 * Check if a field name is safe to include
 */
export function isFieldSafe(fieldName: string): boolean {
  // Treat snake_case, kebab-case and camelCase spellings as the same field so
  // `apiKey` cannot slip past a block for `api_key`.
  const canonicalField = fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return !BLOCKED_FIELDS.some((blocked) =>
    canonicalField.includes(blocked.replace(/[^a-z0-9]/gi, "").toLowerCase()),
  );
}

/**
 * Get metric description
 */
export function getMetricDescription(metricName: string): string {
  return SAFE_METRICS[metricName as keyof typeof SAFE_METRICS] || "Unknown metric";
}

/* -------------------------------------------------------------------------- */
/* OpenTelemetry (OTLP) export                                                */
/* -------------------------------------------------------------------------- */

/** Instrument kinds supported by the client metrics pipeline. */
export type MetricKind = "counter" | "histogram" | "gauge";

export type OtlpProtocol = "http/json" | "http/protobuf" | "grpc";

export type MetricAttributeValue = string | number | boolean;

/** A single measurement recorded by feature code. */
export interface MetricPoint {
  /** Must be a key in {@link SAFE_METRICS} to clear the privacy boundary. */
  name: string;
  kind: MetricKind;
  value: number;
  /** Timestamp in milliseconds since the epoch. */
  timestamp: number;
  attributes?: Record<string, MetricAttributeValue>;
}

/** A batch-aggregated metric ready for OTLP encoding. */
export interface AggregatedMetric {
  name: string;
  kind: MetricKind;
  attributes: Record<string, MetricAttributeValue>;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Last observed value; meaningful for gauges. */
  last: number;
  bucketCounts?: number[];
  explicitBounds?: number[];
  firstTimestamp: number;
  lastTimestamp: number;
}

/**
 * Latitude-style default buckets, appropriate for millisecond measurements.
 * Clients can override them per exporter instance.
 */
export const DEFAULT_HISTOGRAM_BUCKET_BOUNDS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface OtlpExporterConfig {
  endpoint: string | null;
  protocol: OtlpProtocol;
  headers: Record<string, string>;
  serviceName: string;
  scopeName: string;
  intervalMs: number;
  timeoutMs: number;
  maxQueueSize: number;
  /** Emit metric names that are not part of {@link SAFE_METRICS}. */
  allowUnsafeMetrics: boolean;
}

const DEFAULT_OTLP_INTERVAL_MS = 30_000;
const DEFAULT_OTLP_TIMEOUT_MS = 10_000;
const DEFAULT_OTLP_MAX_QUEUE = 5_000;
const OTLP_METRICS_PATH = "/v1/metrics";

type EnvLike = Record<string, string | undefined>;

function readEnv(env: EnvLike, ...names: string[]): string | undefined {
  for (const name of names) {
    // Client bundles only receive NEXT_PUBLIC_* vars, so accept both shapes.
    const raw = env[`NEXT_PUBLIC_${name}`] ?? env[name];
    const trimmed = raw?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Parses the OTLP `key=value,key2=value2` header list format. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/**
 * Resolves a collector endpoint to the metrics signal URL, matching the OTel
 * spec rule: a base endpoint gains `/v1/metrics`, a signal endpoint is kept.
 */
export function resolveOtlpMetricsEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return trimmed.endsWith(OTLP_METRICS_PATH) ? trimmed : `${trimmed}${OTLP_METRICS_PATH}`;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Reads OTLP exporter configuration from the environment. */
export function getOtlpExporterConfig(env: EnvLike = process.env): OtlpExporterConfig {
  const signalEndpoint = readEnv(
    env,
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  );
  const baseEndpoint = readEnv(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const rawProtocol = readEnv(
    env,
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
  );

  return {
    endpoint: resolveOtlpMetricsEndpoint(signalEndpoint ?? baseEndpoint),
    protocol: (rawProtocol as OtlpProtocol) ?? "http/json",
    headers: {
      ...parseOtlpHeaders(readEnv(env, "OTEL_EXPORTER_OTLP_HEADERS")),
      ...parseOtlpHeaders(readEnv(env, "OTEL_EXPORTER_OTLP_METRICS_HEADERS")),
    },
    serviceName: readEnv(env, "OTEL_SERVICE_NAME") ?? "trellis-frontend",
    scopeName: readEnv(env, "OTEL_SCOPE_NAME") ?? "trellis.client.metrics",
    intervalMs: parsePositiveInt(
      readEnv(env, "OTEL_METRIC_EXPORT_INTERVAL"),
      DEFAULT_OTLP_INTERVAL_MS,
    ),
    timeoutMs: parsePositiveInt(
      readEnv(env, "OTEL_EXPORTER_OTLP_TIMEOUT"),
      DEFAULT_OTLP_TIMEOUT_MS,
    ),
    maxQueueSize: parsePositiveInt(
      readEnv(env, "OTEL_METRIC_MAX_QUEUE_SIZE"),
      DEFAULT_OTLP_MAX_QUEUE,
    ),
    allowUnsafeMetrics: readEnv(env, "OTEL_METRIC_ALLOW_UNSAFE") === "true",
  };
}

/** Applies the telemetry privacy boundary to metric attributes. */
export function sanitizeMetricAttributes(
  attributes: Record<string, MetricAttributeValue> | undefined,
): Record<string, MetricAttributeValue> {
  if (!attributes) return {};
  const safe: Record<string, MetricAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isFieldSafe(key)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (typeof value === "string") {
      const scrubbed = value
        .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted]")
        .replace(/\bG[A-Z2-7]{55}\b/g, "[redacted]");
      safe[key] = scrubbed;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * Returns `null` when a point must not leave the client, either because the
 * metric name is outside the safe allow-list or the value is not finite.
 */
export function normalizeMetricPoint(
  point: MetricPoint,
  options: { allowUnsafeMetrics?: boolean } = {},
): MetricPoint | null {
  if (!options.allowUnsafeMetrics && !isMetricSafe(point.name)) return null;
  if (!Number.isFinite(point.value)) return null;
  return {
    name: point.name,
    kind: point.kind,
    value: point.value,
    timestamp: Number.isFinite(point.timestamp) ? point.timestamp : Date.now(),
    attributes: sanitizeMetricAttributes(point.attributes),
  };
}

/** Stable grouping key so equal attribute sets aggregate into one series. */
export function canonicalAttributesKey(
  attributes: Record<string, MetricAttributeValue> | undefined,
): string {
  if (!attributes) return "";
  return Object.keys(attributes)
    .sort()
    .map((key) => `${key}=${String(attributes[key])}`)
    .join("|");
}

function buildBuckets(value: number, bounds: readonly number[]): number[] {
  const counts = new Array<number>(bounds.length + 1).fill(0);
  const index = bounds.findIndex((bound) => value <= bound);
  counts[index === -1 ? bounds.length : index] += 1;
  return counts;
}

/**
 * Groups points into OTLP-ready metrics: counters sum, gauges keep the last
 * value, and histograms accumulate counts, sums, and bucket counts.
 */
export function aggregateMetricPoints(
  points: readonly MetricPoint[],
  options: {
    allowUnsafeMetrics?: boolean;
    bucketBounds?: readonly number[];
  } = {},
): AggregatedMetric[] {
  const bucketBounds = options.bucketBounds ?? DEFAULT_HISTOGRAM_BUCKET_BOUNDS;
  const groups = new Map<string, AggregatedMetric>();

  for (const rawPoint of points) {
    const point = normalizeMetricPoint(rawPoint, options);
    if (!point) continue;

    const attributes = point.attributes ?? {};
    const key = `${point.kind}:${point.name}:${canonicalAttributesKey(attributes)}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        name: point.name,
        kind: point.kind,
        attributes,
        count: 1,
        sum: point.value,
        min: point.value,
        max: point.value,
        last: point.value,
        bucketCounts:
          point.kind === "histogram"
            ? buildBuckets(point.value, bucketBounds)
            : undefined,
        explicitBounds:
          point.kind === "histogram" ? [...bucketBounds] : undefined,
        firstTimestamp: point.timestamp,
        lastTimestamp: point.timestamp,
      });
      continue;
    }

    existing.count += 1;
    existing.sum += point.value;
    existing.min = Math.min(existing.min, point.value);
    existing.max = Math.max(existing.max, point.value);
    existing.last = point.value;
    existing.firstTimestamp = Math.min(existing.firstTimestamp, point.timestamp);
    existing.lastTimestamp = Math.max(existing.lastTimestamp, point.timestamp);
    if (existing.bucketCounts && point.kind === "histogram") {
      const increments = buildBuckets(point.value, bucketBounds);
      existing.bucketCounts = existing.bucketCounts.map(
        (count, index) => count + (increments[index] ?? 0),
      );
    }
  }

  return [...groups.values()].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0
      ? byName
      : canonicalAttributesKey(left.attributes).localeCompare(
          canonicalAttributesKey(right.attributes),
        );
  });
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpDataPoint {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asDouble: number;
}

interface OtlpHistogramDataPoint {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: number;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
  min?: number;
  max?: number;
}

interface OtlpMetric {
  name: string;
  unit: string;
  sum?: { dataPoints: OtlpDataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
  gauge?: { dataPoints: OtlpDataPoint[] };
  histogram?: { dataPoints: OtlpHistogramDataPoint[]; aggregationTemporality: number };
}

export interface OtlpExportPayload {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: OtlpMetric[];
    }>;
  }>;
}

/** OTLP aggregation temporality: 1 = delta, 2 = cumulative. */
export const AGGREGATION_TEMPORALITY_DELTA = 1;

export function toAttributeValue(value: MetricAttributeValue): OtlpAnyValue {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: value };
}

export function toAttributeList(
  attributes: Record<string, MetricAttributeValue>,
): OtlpKeyValue[] {
  return Object.keys(attributes)
    .sort()
    .map((key) => ({ key, value: toAttributeValue(attributes[key]) }));
}

/** Milliseconds since epoch to the OTLP int64-as-string nanoseconds format. */
export function toUnixNano(timestampMs: number): string {
  return (BigInt(Math.trunc(timestampMs)) * 1_000_000n).toString();
}

/** Encodes aggregated metrics as an OTLP/JSON `ExportMetricsServiceRequest`. */
export function toOtlpPayload(
  metrics: readonly AggregatedMetric[],
  options: {
    serviceName?: string;
    scopeName?: string;
    scopeVersion?: string;
    resourceAttributes?: Record<string, MetricAttributeValue>;
  } = {},
): OtlpExportPayload {
  const resourceAttributes = sanitizeMetricAttributes(
    options.resourceAttributes ?? {},
  );

  const otlpMetrics: OtlpMetric[] = metrics.map((metric) => {
    const attributes = toAttributeList(metric.attributes);
    const startTimeUnixNano = toUnixNano(metric.firstTimestamp);
    const timeUnixNano = toUnixNano(metric.lastTimestamp);

    if (metric.kind === "gauge") {
      return {
        name: metric.name,
        unit: "1",
        gauge: {
          dataPoints: [
            { attributes, startTimeUnixNano, timeUnixNano, asDouble: metric.last },
          ],
        },
      };
    }

    if (metric.kind === "histogram") {
      return {
        name: metric.name,
        unit: "ms",
        histogram: {
          aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
          dataPoints: [
            {
              attributes,
              startTimeUnixNano,
              timeUnixNano,
              count: metric.count,
              sum: metric.sum,
              min: metric.min,
              max: metric.max,
              bucketCounts: (metric.bucketCounts ?? []).map(String),
              explicitBounds: metric.explicitBounds ?? [],
            },
          ],
        },
      };
    }

    return {
      name: metric.name,
      unit: "1",
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
        isMonotonic: true,
        dataPoints: [
          { attributes, startTimeUnixNano, timeUnixNano, asDouble: metric.sum },
        ],
      },
    };
  });

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: options.serviceName ?? "trellis-frontend" },
            },
            { key: "telemetry.sdk.name", value: { stringValue: "trellis.client" } },
            ...toAttributeList(resourceAttributes),
          ],
        },
        scopeMetrics: [
          {
            scope: {
              name: options.scopeName ?? "trellis.client.metrics",
              version: options.scopeVersion ?? "0.1.0",
            },
            metrics: otlpMetrics,
          },
        ],
      },
    ],
  };
}

export interface OtlpExportResult {
  ok: boolean;
  endpoint: string | null;
  metricCount: number;
  pointCount: number;
  /** Transport actually used; gRPC configs fall back to OTLP/HTTP JSON. */
  transport: "http/json";
  protocol: OtlpProtocol;
  status?: number;
  error?: string;
}

/**
 * Periodic batch exporter for client counters, histograms, and gauges.
 *
 * Points are buffered locally and flushed on an interval to the configured
 * OTLP collector endpoint. Failed batches are re-queued so a collector outage
 * does not silently drop measurements.
 */
export class OtlpMetricExporter {
  readonly config: OtlpExporterConfig;
  private queue: MetricPoint[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly bucketBounds: readonly number[];
  private readonly fetchImpl: typeof fetch | null;

  constructor(
    config: Partial<OtlpExporterConfig> = {},
    options: {
      bucketBounds?: readonly number[];
      fetchImpl?: typeof fetch;
      configFromEnv?: EnvLike;
    } = {},
  ) {
    const envConfig =
      options.configFromEnv === undefined
        ? getOtlpExporterConfig()
        : getOtlpExporterConfig(options.configFromEnv);
    this.config = { ...envConfig, ...config };
    this.bucketBounds = options.bucketBounds ?? DEFAULT_HISTOGRAM_BUCKET_BOUNDS;
    this.fetchImpl =
      options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Buffers a measurement, dropping it when it fails the privacy boundary. */
  record(point: MetricPoint): boolean {
    const normalized = normalizeMetricPoint(point, {
      allowUnsafeMetrics: this.config.allowUnsafeMetrics,
    });
    if (!normalized) return false;

    this.queue.push(normalized);
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue.splice(0, this.queue.length - this.config.maxQueueSize);
    }
    return true;
  }

  recordCounter(
    name: string,
    value = 1,
    attributes?: Record<string, MetricAttributeValue>,
  ): boolean {
    return this.record({ name, kind: "counter", value, timestamp: Date.now(), attributes });
  }

  recordGauge(
    name: string,
    value: number,
    attributes?: Record<string, MetricAttributeValue>,
  ): boolean {
    return this.record({ name, kind: "gauge", value, timestamp: Date.now(), attributes });
  }

  recordHistogram(
    name: string,
    value: number,
    attributes?: Record<string, MetricAttributeValue>,
  ): boolean {
    return this.record({ name, kind: "histogram", value, timestamp: Date.now(), attributes });
  }

  /** Aggregates and transmits the currently buffered batch. */
  async flush(): Promise<OtlpExportResult> {
    const batch = this.queue;
    this.queue = [];

    const base: OtlpExportResult = {
      ok: true,
      endpoint: this.config.endpoint,
      metricCount: 0,
      pointCount: batch.length,
      transport: "http/json",
      protocol: this.config.protocol,
    };

    if (batch.length === 0) return base;

    if (!this.config.endpoint) {
      this.requeue(batch);
      return { ...base, ok: false, error: "no_endpoint_configured" };
    }

    if (!this.fetchImpl) {
      this.requeue(batch);
      return { ...base, ok: false, error: "fetch_unavailable" };
    }

    const aggregated = aggregateMetricPoints(batch, {
      allowUnsafeMetrics: this.config.allowUnsafeMetrics,
      bucketBounds: this.bucketBounds,
    });
    const payload = toOtlpPayload(aggregated, {
      serviceName: this.config.serviceName,
      scopeName: this.config.scopeName,
    });

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.config.timeoutMs)
      : null;

    try {
      const response = await this.fetchImpl(this.config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });

      if (!response.ok) {
        this.requeue(batch);
        return {
          ...base,
          ok: false,
          metricCount: aggregated.length,
          status: response.status,
          error: `collector_rejected_batch_${response.status}`,
        };
      }

      return { ...base, metricCount: aggregated.length };
    } catch (error) {
      this.requeue(batch);
      return {
        ...base,
        ok: false,
        metricCount: aggregated.length,
        error: error instanceof Error ? error.message : "export_failed",
      };
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  /** Starts the periodic batch export timer. */
  start(intervalMs?: number): void {
    if (this.timer !== null) return;
    const interval = intervalMs ?? this.config.intervalMs;
    this.timer = setInterval(() => {
      void this.flush();
    }, interval);
    // Never keep a Node process alive purely for metrics export.
    const timer = this.timer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  /** Stops the periodic timer. Buffered points remain until the next flush. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private requeue(batch: MetricPoint[]): void {
    this.queue = [...batch, ...this.queue].slice(-this.config.maxQueueSize);
  }
}

/** Shared exporter used by feature code that records client metrics. */
export const defaultMetricExporter = new OtlpMetricExporter();

/** Records a measurement on the shared exporter. Returns false if filtered. */
export function recordMetricPoint(point: MetricPoint): boolean {
  return defaultMetricExporter.record(point);
}

/** Starts periodic batch export on the shared exporter. */
export function startMetricExport(intervalMs?: number): void {
  defaultMetricExporter.start(intervalMs);
}

/** Stops periodic batch export on the shared exporter. */
export function stopMetricExport(): void {
  defaultMetricExporter.stop();
}