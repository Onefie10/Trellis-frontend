import type { BugReport } from "../types/bug-report";

export interface OperationalHealth {
  generatedAt: string;
  categories: Array<{
    key: "unresolved-exceptions" | "stale-records" | "reconciliation-drift" | "user-incidents";
    label: string;
    count: number;
    severity: "info" | "warning" | "critical";
    href: string;
  }>;
}

export interface OperationalMetricSample {
  ts: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  activeConnections: number;
  rpcLatencyMs: number | null;
}

export const MAX_OPERATIONAL_METRIC_SAMPLES = 60;
export const OPERATIONAL_MEMORY_WARNING_RATIO = 0.8;
export const OPERATIONAL_MEMORY_CRITICAL_RATIO = 0.9;

export function isOperationalMetricSample(value: unknown): value is OperationalMetricSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.ts === "number" && Number.isFinite(sample.ts) &&
    typeof sample.heapUsedBytes === "number" && Number.isFinite(sample.heapUsedBytes) && sample.heapUsedBytes >= 0 &&
    typeof sample.heapTotalBytes === "number" && Number.isFinite(sample.heapTotalBytes) && sample.heapTotalBytes > 0 &&
    typeof sample.activeConnections === "number" && Number.isFinite(sample.activeConnections) && sample.activeConnections >= 0 &&
    (sample.rpcLatencyMs === null ||
      (typeof sample.rpcLatencyMs === "number" && Number.isFinite(sample.rpcLatencyMs) && sample.rpcLatencyMs >= 0))
  );
}

/** Appends one sample without mutating the prior buffer and keeps it bounded. */
export function appendOperationalMetricSample(
  samples: readonly OperationalMetricSample[],
  sample: OperationalMetricSample,
  maxSamples = MAX_OPERATIONAL_METRIC_SAMPLES,
): OperationalMetricSample[] {
  if (!Number.isInteger(maxSamples) || maxSamples < 1) {
    throw new Error("maxSamples must be a positive integer");
  }
  return [...samples, sample].slice(-maxSamples);
}

export function buildOperationalHealth(
  reports: readonly BugReport[],
  now = Date.now(),
  staleAfterMs = 7 * 24 * 60 * 60 * 1000,
): OperationalHealth {
  const unresolved = reports.filter((report) => report.status !== "resolved");
  const stale = unresolved.filter(
    (report) => now - Date.parse(report.updatedAt) >= staleAfterMs,
  );
  const drift = reports.filter(
    (report) => report.status === "resolved" && report.rewardStatus === "pending",
  );
  const incidents = reports.filter(
    (report) => report.priority === "critical" && report.status !== "resolved",
  );

  return {
    generatedAt: new Date(now).toISOString(),
    categories: [
      {
        key: "unresolved-exceptions",
        label: "Unresolved exceptions",
        count: unresolved.length,
        severity: unresolved.length > 0 ? "warning" : "info",
        href: "/bug-reports?status=all",
      },
      {
        key: "stale-records",
        label: "Stale records",
        count: stale.length,
        severity: stale.length > 0 ? "warning" : "info",
        href: "/bug-reports?status=all&stale=true",
      },
      {
        key: "reconciliation-drift",
        label: "Reconciliation drift",
        count: drift.length,
        severity: drift.length > 0 ? "critical" : "info",
        href: "/bug-reports?status=resolved",
      },
      {
        key: "user-incidents",
        label: "User-impacting incidents",
        count: incidents.length,
        severity: incidents.length > 0 ? "critical" : "info",
        href: "/bug-reports?status=all&priority=critical",
      },
    ],
  };
}

/** Severity levels shared with the client telemetry contract. */
export type ExceptionSeverity = "warning" | "error" | "critical";

/** Bounded exception category; `rpc` failures back the RPC-error alert metric. */
export type ExceptionKind = "rpc" | "api" | "ui" | "render" | "wallet" | "other";

/**
 * A single sanitized application exception.
 *
 * The shape follows `docs/telemetry-event-contract.md`: every field is a
 * low-cardinality, non-identifying dimension, so the dashboard can group and
 * chart exceptions without storing user or wallet data.
 */
export interface ExceptionEvent {
  id: string;
  /** Event timestamp in milliseconds. */
  ts: number;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  /** Bounded feature/component label, e.g. `"wallet"`. */
  component: string;
  /** Bounded platform label, e.g. `"macOS"`. */
  browserOS: string;
  /** Release/build identifier, e.g. `"v1.4.0"`. */
  release: string;
  /** Stable error code from the telemetry contract, e.g. `"rpc_unavailable"`. */
  code?: string;
  /** Optional normalized route template where the exception occurred, e.g. `"/api/agents/:param"`. */
  route?: string;
}

export type ExceptionGroupDimension = "component" | "browserOS" | "release" | "kind";

export interface ExceptionFilters {
  component?: string;
  browserOS?: string;
  release?: string;
  kind?: ExceptionKind;
}

export interface ExceptionGroup {
  key: string;
  count: number;
}

export interface ErrorTrendOptions extends ExceptionFilters {
  /** Total time range to chart, in milliseconds. */
  windowMs: number;
  /** Width of each bucket, in milliseconds. */
  bucketMs: number;
  /** Reference "now" in milliseconds; defaults to `Date.now()`. */
  now?: number;
}

export interface ErrorTrendBucket {
  bucketStart: number;
  bucketEnd: number;
  /** UTC `HH:MM` label for chart axes. */
  label: string;
  count: number;
  /** Bucket count normalised to errors per minute. */
  ratePerMinute: number;
  bySeverity: Record<ExceptionSeverity, number>;
}

export type AlertMetric = "exceptions" | "rpc-exceptions" | "critical-exceptions";

export interface AlertRule {
  id: string;
  name: string;
  metric: AlertMetric;
  /** A window breaches when its observed count is strictly greater than this. */
  threshold: number;
  windowMs: number;
  severity: "warning" | "critical";
  /** Defaults to enabled when omitted. */
  enabled?: boolean;
  filters?: ExceptionFilters;
}

export interface AlertBreach {
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  observed: number;
  severity: "warning" | "critical";
  windowStart: number;
  windowEnd: number;
}

export interface ExceptionTrendReport {
  generatedAt: number;
  windowMs: number;
  bucketMs: number;
  /** Exceptions inside the chart window after filters are applied. */
  total: number;
  buckets: ErrorTrendBucket[];
  groups: Record<ExceptionGroupDimension, ExceptionGroup[]>;
  breaches: AlertBreach[];
}

export interface AlertRuleInput {
  id?: string;
  name?: string;
  metric: AlertMetric;
  threshold: number;
  windowMinutes: number;
  severity?: AlertRule["severity"];
  filters?: ExceptionFilters;
}

const MINUTE_MS = 60 * 1000;

const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  exceptions: "Exceptions",
  "rpc-exceptions": "RPC errors",
  "critical-exceptions": "Critical exceptions",
};

/** Maintainer defaults, including the `> 15 RPC errors in 5 min` rule from the issue. */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    id: "rpc-errors-5m",
    name: "RPC errors over threshold",
    metric: "rpc-exceptions",
    threshold: 15,
    windowMs: 5 * MINUTE_MS,
    severity: "critical",
  },
  {
    id: "exceptions-15m",
    name: "Exception volume spike",
    metric: "exceptions",
    threshold: 30,
    windowMs: 15 * MINUTE_MS,
    severity: "warning",
  },
  {
    id: "critical-exceptions-10m",
    name: "Critical exception burst",
    metric: "critical-exceptions",
    threshold: 5,
    windowMs: 10 * MINUTE_MS,
    severity: "critical",
  },
];

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function toMinuteLabel(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** True when every populated filter dimension matches the event. */
export function matchesExceptionFilters(
  event: ExceptionEvent,
  filters: ExceptionFilters = {},
): boolean {
  if (filters.component && event.component !== filters.component) return false;
  if (filters.browserOS && event.browserOS !== filters.browserOS) return false;
  if (filters.release && event.release !== filters.release) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  return true;
}

export function filterExceptionEvents(
  events: readonly ExceptionEvent[],
  filters: ExceptionFilters = {},
): ExceptionEvent[] {
  return events.filter((event) => matchesExceptionFilters(event, filters));
}

/** Counts exceptions per dimension, highest count first, then alphabetically. */
export function groupExceptionEvents(
  events: readonly ExceptionEvent[],
  dimension: ExceptionGroupDimension,
): ExceptionGroup[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = event[dimension];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts, ([key, count]) => ({ key, count })).sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key),
  );
}

/**
 * Buckets exceptions into contiguous, fixed-width time slots ending at `now`.
 *
 * The window is half-open (`[now - windowMs, now)`), so an event is counted in
 * exactly one bucket. `ratePerMinute` normalises partial buckets so short
 * windows remain comparable with longer ones.
 */
export function buildErrorTrend(
  events: readonly ExceptionEvent[],
  options: ErrorTrendOptions,
): ErrorTrendBucket[] {
  const { windowMs, bucketMs } = options;
  assertPositive("windowMs", windowMs);
  assertPositive("bucketMs", bucketMs);

  const now = options.now ?? Date.now();
  const windowStart = now - windowMs;
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));
  const minutesPerBucket = bucketMs / MINUTE_MS;

  const buckets: ErrorTrendBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = windowStart + index * bucketMs;
    return {
      bucketStart,
      bucketEnd: bucketStart + bucketMs,
      label: toMinuteLabel(bucketStart),
      count: 0,
      ratePerMinute: 0,
      bySeverity: { warning: 0, error: 0, critical: 0 },
    };
  });

  for (const event of filterExceptionEvents(events, options)) {
    if (event.ts < windowStart || event.ts >= now) continue;
    const index = Math.min(bucketCount - 1, Math.floor((event.ts - windowStart) / bucketMs));
    const bucket = buckets[index];
    bucket.count += 1;
    bucket.bySeverity[event.severity] += 1;
  }

  for (const bucket of buckets) {
    bucket.ratePerMinute = Math.round((bucket.count / minutesPerBucket) * 100) / 100;
  }

  return buckets;
}

/** Maps an event to the alert metric it contributes to. */
export function matchesAlertMetric(event: ExceptionEvent, metric: AlertMetric): boolean {
  if (metric === "exceptions") return true;
  if (metric === "rpc-exceptions") return event.kind === "rpc";
  return event.severity === "critical";
}

/**
 * Evaluates maintainer alert rules over the half-open window
 * `[now - rule.windowMs, now)` and returns the breached rules.
 *
 * A rule breaches only when the observed count is strictly greater than its
 * threshold, matching the `> 15 RPC errors in 5 mins` semantics.
 */
export function evaluateAlertRules(
  events: readonly ExceptionEvent[],
  rules: readonly AlertRule[],
  now = Date.now(),
): AlertBreach[] {
  const breaches: AlertBreach[] = [];

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const windowStart = now - rule.windowMs;
    const observed = events.filter(
      (event) =>
        event.ts >= windowStart &&
        event.ts < now &&
        matchesAlertMetric(event, rule.metric) &&
        matchesExceptionFilters(event, rule.filters),
    ).length;

    if (observed > rule.threshold) {
      breaches.push({
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        threshold: rule.threshold,
        observed,
        severity: rule.severity,
        windowStart,
        windowEnd: now,
      });
    }
  }

  return breaches.sort(
    (a, b) => b.observed / b.threshold - a.observed / a.threshold || a.ruleId.localeCompare(b.ruleId),
  );
}

/** Human-readable summary of a rule, e.g. `RPC errors > 15 in 5 min`. */
export function describeAlertRule(rule: Pick<AlertRule, "metric" | "threshold" | "windowMs">): string {
  return `${ALERT_METRIC_LABELS[rule.metric]} > ${rule.threshold} in ${rule.windowMs / MINUTE_MS} min`;
}

/**
 * Validates and normalises a rule coming from the maintainer rule creator.
 * Throws when the threshold or window is not usable.
 */
export function createAlertRule(input: AlertRuleInput): AlertRule {
  const threshold = Math.round(input.threshold);
  assertPositive("Alert threshold", threshold);

  const windowMinutes = Math.round(input.windowMinutes);
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 24 * 60) {
    throw new Error("Alert window must be between 1 and 1440 minutes");
  }

  const metric = input.metric;
  return {
    id: input.id ?? `alert-${metric}-${threshold}-${windowMinutes}m`,
    name:
      (input.name ?? "").trim() ||
      `${ALERT_METRIC_LABELS[metric]} > ${threshold} in ${windowMinutes} min`,
    metric,
    threshold,
    windowMs: windowMinutes * MINUTE_MS,
    severity: input.severity ?? "warning",
    enabled: true,
    ...(input.filters ? { filters: input.filters } : {}),
  };
}

/** Builds the chart, grouping and breach payload rendered by the operations page. */
export function buildExceptionTrendReport(
  events: readonly ExceptionEvent[],
  options: {
    windowMs: number;
    bucketMs: number;
    now?: number;
    filters?: ExceptionFilters;
    rules?: readonly AlertRule[];
  },
): ExceptionTrendReport {
  const now = options.now ?? Date.now();
  const filters = options.filters ?? {};
  const windowStart = now - options.windowMs;

  const inWindow = events.filter(
    (event) =>
      event.ts >= windowStart && event.ts < now && matchesExceptionFilters(event, filters),
  );

  return {
    generatedAt: now,
    windowMs: options.windowMs,
    bucketMs: options.bucketMs,
    total: inWindow.length,
    buckets: buildErrorTrend(events, {
      windowMs: options.windowMs,
      bucketMs: options.bucketMs,
      now,
      ...filters,
    }),
    groups: {
      component: groupExceptionEvents(inWindow, "component"),
      browserOS: groupExceptionEvents(inWindow, "browserOS"),
      release: groupExceptionEvents(inWindow, "release"),
      kind: groupExceptionEvents(inWindow, "kind"),
    },
    breaches: evaluateAlertRules(events, options.rules ?? DEFAULT_ALERT_RULES, now),
  };
}

const PRIORITY_SEVERITY: Record<BugReport["priority"], ExceptionSeverity> = {
  critical: "critical",
  high: "error",
  medium: "warning",
  low: "warning",
};

const CATEGORY_KIND: Record<BugReport["category"], ExceptionKind> = {
  security: "api",
  functionality: "other",
  performance: "render",
  ui: "ui",
  other: "other",
};

/**
 * Projects a bug report into the exception stream. Bug reports are the
 * dashboard's existing "unresolved exceptions", so maintainer data already on
 * hand feeds the trend chart and the alert rules.
 */
export function bugReportToExceptionEvent(report: BugReport): ExceptionEvent {
  const updated = Date.parse(report.updatedAt);
  const created = Date.parse(report.createdAt);
  return {
    id: `BR-EX-${report.id}`,
    ts: updated || created || 0,
    kind: CATEGORY_KIND[report.category],
    severity: PRIORITY_SEVERITY[report.priority],
    component: report.category,
    browserOS: "unknown",
    release: "unknown",
    code: `bug_report_${report.category}`,
  };
}

/** Probe outcome shape used across health probe runners. */
export interface ProbeOutcome {
  key: string;
  ok: boolean;
  latencyMs: number | null;
  statusCode?: number | null;
  error?: string | null;
  skipped?: boolean;
}

export type ExternalServiceKey = "horizon" | "soroban-rpc" | "ipfs" | "algolia";
export type ServiceHealthStatus = "healthy" | "degraded" | "down";

export interface ProbeSampleRecord {
  ts: number;
  latencyMs: number;
  success: boolean;
  statusCode?: number | null;
  error?: string | null;
  timedOut?: boolean;
}

export interface RollingLatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
  samplesCount: number;
}

export interface ExternalServiceHealth {
  service: ExternalServiceKey | string;
  label: string;
  endpoint: string;
  status: ServiceHealthStatus;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  rollingLatency: RollingLatencyStats;
  uptimePercentage: number;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SyntheticProbeConfig {
  service: ExternalServiceKey | string;
  label: string;
  url: string;
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  degradedLatencyThresholdMs?: number;
  probeFn?: () => Promise<{
    success: boolean;
    latencyMs: number;
    error?: string;
    statusCode?: number;
    timedOut?: boolean;
  }>;
}

export const DEFAULT_DEGRADED_LATENCY_THRESHOLD_MS = 1500;
export const DEFAULT_PROBE_TIMEOUT_MS = 3000;
export const MAX_PROBE_SAMPLES_PER_SERVICE = 100;

export function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export function computeRollingLatency(samples: readonly ProbeSampleRecord[]): RollingLatencyStats {
  const successfulLatencies = samples
    .filter((s) => s.success && typeof s.latencyMs === "number" && Number.isFinite(s.latencyMs))
    .map((s) => s.latencyMs);

  if (successfulLatencies.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, samplesCount: samples.length };
  }

  const sum = successfulLatencies.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / successfulLatencies.length);
  const min = Math.min(...successfulLatencies);
  const max = Math.max(...successfulLatencies);

  return {
    p50: computePercentile(successfulLatencies, 50),
    p95: computePercentile(successfulLatencies, 95),
    p99: computePercentile(successfulLatencies, 99),
    min,
    max,
    avg,
    samplesCount: samples.length,
  };
}

export function evaluateServiceHealth(
  samples: readonly ProbeSampleRecord[],
  degradedLatencyThresholdMs = DEFAULT_DEGRADED_LATENCY_THRESHOLD_MS,
): {
  status: ServiceHealthStatus;
  rollingLatency: RollingLatencyStats;
  uptimePercentage: number;
  consecutiveFailures: number;
  lastError: string | null;
} {
  if (samples.length === 0) {
    return {
      status: "healthy",
      rollingLatency: { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, samplesCount: 0 },
      uptimePercentage: 100,
      consecutiveFailures: 0,
      lastError: null,
    };
  }

  const rollingLatency = computeRollingLatency(samples);
  const successCount = samples.filter((s) => s.success).length;
  const uptimePercentage = Math.round((successCount / samples.length) * 1000) / 10;

  let consecutiveFailures = 0;
  let lastError: string | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (!samples[i].success) {
      consecutiveFailures++;
      if (!lastError && samples[i].error) {
        lastError = samples[i].error!;
      }
    } else {
      break;
    }
  }

  const recentWindow = samples.slice(-5);
  const recentTimeouts = recentWindow.filter((s) => s.timedOut).length;
  const failureRate = (samples.length - successCount) / samples.length;

  let status: ServiceHealthStatus = "healthy";

  if (consecutiveFailures >= 3 || failureRate >= 0.75) {
    status = "down";
  } else if (
    rollingLatency.p95 >= degradedLatencyThresholdMs ||
    recentTimeouts > 0 ||
    consecutiveFailures > 0 ||
    failureRate >= 0.15
  ) {
    status = "degraded";
  }

  return { status, rollingLatency, uptimePercentage, consecutiveFailures, lastError };
}

export async function executeSyntheticProbe(
  config: SyntheticProbeConfig,
  fetchFn?: typeof fetch,
): Promise<ProbeSampleRecord> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const started = Date.now();

  if (config.probeFn) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<{
        success: boolean;
        latencyMs: number;
        error?: string;
        statusCode?: number;
        timedOut?: boolean;
      }>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Probe timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const res = await Promise.race([config.probeFn(), timeoutPromise]);
      return {
        ts: Date.now(),
        latencyMs: res.latencyMs ?? (Date.now() - started),
        success: res.success,
        statusCode: res.statusCode ?? null,
        error: res.error ?? null,
        timedOut: res.timedOut ?? false,
      };
    } catch (err: unknown) {
      const isTimeout = (err as Error)?.message?.includes("timed out");
      return {
        ts: Date.now(),
        latencyMs: timeoutMs,
        success: false,
        statusCode: null,
        error: (err as Error)?.message || "Probe failed",
        timedOut: isTimeout,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const doFetch = fetchFn ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) {
    return {
      ts: Date.now(),
      latencyMs: 0,
      success: false,
      statusCode: null,
      error: "No fetch implementation available",
      timedOut: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(config.url, {
      method: config.method ?? "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;
    const ok = response.status < 500 && response.status !== 429;
    return {
      ts: Date.now(),
      latencyMs,
      success: ok,
      statusCode: response.status,
      error: ok ? null : `HTTP ${response.status}`,
      timedOut: false,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - started;
    const isTimeout =
      (error as { name?: string })?.name === "AbortError" ||
      (error as Error)?.message?.includes("aborted") ||
      latencyMs >= timeoutMs;

    return {
      ts: Date.now(),
      latencyMs: isTimeout ? timeoutMs : latencyMs,
      success: false,
      statusCode: null,
      error: isTimeout ? `Probe timed out after ${timeoutMs}ms` : (error as Error)?.message || "Probe request failed",
      timedOut: isTimeout,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_SYNTHETIC_PROBE_TARGETS: readonly SyntheticProbeConfig[] = [
  {
    service: "horizon",
    label: "Stellar Horizon API",
    url: process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org/fee_stats",
    timeoutMs: 3000,
    degradedLatencyThresholdMs: 1200,
  },
  {
    service: "soroban-rpc",
    label: "Stellar Soroban RPC",
    url: process.env.NEXT_PUBLIC_STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    method: "GET",
    timeoutMs: 3000,
    degradedLatencyThresholdMs: 1500,
  },
  {
    service: "ipfs",
    label: "IPFS Gateway",
    url: process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://ipfs.io/ipfs/bafybeifx7yeb55kdqb75",
    method: "HEAD",
    timeoutMs: 4000,
    degradedLatencyThresholdMs: 2000,
  },
  {
    service: "algolia",
    label: "Algolia Search",
    url: "https://status.algolia.com/api/v1/status",
    timeoutMs: 3000,
    degradedLatencyThresholdMs: 1000,
  },
];

export class SyntheticProbeManager {
  private samples: Map<string, ProbeSampleRecord[]> = new Map();
  private targets: Map<string, SyntheticProbeConfig> = new Map();

  constructor(initialTargets: readonly SyntheticProbeConfig[] = DEFAULT_SYNTHETIC_PROBE_TARGETS) {
    for (const target of initialTargets) {
      this.targets.set(target.service, target);
      this.samples.set(target.service, []);
    }
  }

  registerTarget(target: SyntheticProbeConfig): void {
    this.targets.set(target.service, target);
    if (!this.samples.has(target.service)) {
      this.samples.set(target.service, []);
    }
  }

  recordSample(service: string, sample: ProbeSampleRecord): void {
    const list = this.samples.get(service) ?? [];
    list.push(sample);
    if (list.length > MAX_PROBE_SAMPLES_PER_SERVICE) {
      list.shift();
    }
    this.samples.set(service, list);
  }

  getSamples(service: string): readonly ProbeSampleRecord[] {
    return this.samples.get(service) ?? [];
  }

  clearSamples(service?: string): void {
    if (service) {
      this.samples.set(service, []);
    } else {
      this.samples.clear();
      for (const key of Array.from(this.targets.keys())) {
        this.samples.set(key, []);
      }
    }
  }

  async runProbes(fetchFn?: typeof fetch): Promise<ExternalServiceHealth[]> {
    const results = await Promise.all(
      Array.from(this.targets.values()).map(async (target) => {
        const sample = await executeSyntheticProbe(target, fetchFn);
        this.recordSample(target.service, sample);
        return this.getServiceHealth(target.service);
      }),
    );
    return results;
  }

  getServiceHealth(service: string): ExternalServiceHealth {
    const target = this.targets.get(service);
    const samples = this.samples.get(service) ?? [];
    const evaluation = evaluateServiceHealth(
      samples,
      target?.degradedLatencyThresholdMs ?? DEFAULT_DEGRADED_LATENCY_THRESHOLD_MS,
    );
    const lastSample = samples[samples.length - 1];

    return {
      service,
      label: target?.label ?? service,
      endpoint: target?.url ?? "",
      status: evaluation.status,
      lastCheckedAt: lastSample ? new Date(lastSample.ts).toISOString() : null,
      lastLatencyMs: lastSample ? lastSample.latencyMs : null,
      rollingLatency: evaluation.rollingLatency,
      uptimePercentage: evaluation.uptimePercentage,
      consecutiveFailures: evaluation.consecutiveFailures,
      lastError: evaluation.lastError,
    };
  }

  getAllServicesHealth(): ExternalServiceHealth[] {
    return Array.from(this.targets.keys()).map((service) => this.getServiceHealth(service));
  }
}

/** Global singleton instance for synthetic probes. */
export const syntheticProbeManager = new SyntheticProbeManager();

export interface FailingRouteStat {
  route: string;
  failureCount: number;
  criticalCount: number;
  errorRatePct: number;
  dominantKind: ExceptionKind;
  lastSeenAt: string;
}

export interface ServiceUptimeSummary {
  service: string;
  label: string;
  status: ServiceHealthStatus;
  uptimePercentage: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  consecutiveFailures: number;
}

export interface OperationalUptimeStats {
  overallUptimePercentage: number;
  slaTargetPercentage: number;
  slaMet: boolean;
  healthyServicesCount: number;
  degradedServicesCount: number;
  downServicesCount: number;
  totalServicesCount: number;
  avgRpcLatencyMs: number | null;
  p95RpcLatencyMs: number | null;
  peakHeapUsageRatio: number;
  services: ServiceUptimeSummary[];
}

export interface OperationalErrorTrendSummary {
  windowMinutes: number;
  totalExceptions: number;
  criticalExceptions: number;
  rpcExceptions: number;
  peakErrorsPerMinute: number;
  avgErrorsPerMinute: number;
  trendDirection: "improving" | "stable" | "degrading";
  activeBreaches: AlertBreach[];
  buckets: ErrorTrendBucket[];
}

export interface ExecutiveOperationalReport {
  generatedAt: string;
  windowMinutes: number;
  healthCategories: OperationalHealth["categories"];
  uptime: OperationalUptimeStats;
  errorTrends: OperationalErrorTrendSummary;
  topFailingRoutes: FailingRouteStat[];
}

export interface BuildExecutiveOperationalReportInput {
  now?: number;
  windowMinutes?: number;
  bucketMinutes?: number;
  health?: OperationalHealth | null;
  exceptionEvents?: readonly ExceptionEvent[];
  trendReport?: ExceptionTrendReport | null;
  metricSamples?: readonly OperationalMetricSample[];
  externalServices?: readonly ExternalServiceHealth[];
  filters?: ExceptionFilters;
  rules?: readonly AlertRule[];
  slaTargetPercentage?: number;
  topRoutesLimit?: number;
}

const ROUTE_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const ROUTE_NUMERIC_SEGMENT_RE = /(\/)[0-9]{2,}(?=\/|$)/g;
const ROUTE_STELLAR_KEY_RE = /\b[GC][A-Z2-7]{55}\b/g;

/**
 * Normalizes a route path into a bounded, privacy-safe route template by
 * stripping query strings/hashes and collapsing dynamic IDs into `:param`.
 */
export function normalizeOperationalRoute(rawRoute: string): string {
  const trimmed = rawRoute.trim().split(/[?#]/)[0]?.trim() ?? "";
  if (!trimmed) return "/unknown";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash
    .replace(ROUTE_UUID_RE, ":param")
    .replace(ROUTE_STELLAR_KEY_RE, ":param")
    .replace(ROUTE_NUMERIC_SEGMENT_RE, "$1:param")
    .replace(/\/{2,}/g, "/");
}

/**
 * Derives a normalized route template from an ExceptionEvent, using its explicit
 * `route` when present or mapping its component and kind to a canonical path.
 */
export function deriveExceptionRoute(event: ExceptionEvent): string {
  if (event.route && event.route.trim()) {
    return normalizeOperationalRoute(event.route);
  }
  const component = event.component.trim() || "unknown";
  if (component.startsWith("/")) {
    return normalizeOperationalRoute(component);
  }
  const slug = component.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-");
  if (event.kind === "rpc") {
    return normalizeOperationalRoute(`/api/rpc/${slug}`);
  }
  if (event.kind === "api") {
    return normalizeOperationalRoute(`/api/${slug}`);
  }
  return normalizeOperationalRoute(`/${slug}`);
}

/**
 * Aggregates and ranks the top failing routes from an exception stream.
 */
export function aggregateTopFailingRoutes(
  events: readonly ExceptionEvent[],
  limit = 5,
): FailingRouteStat[] {
  if (events.length === 0 || limit <= 0) return [];

  const totalEvents = events.length;
  const groups = new Map<
    string,
    {
      failureCount: number;
      criticalCount: number;
      kindCounts: Map<ExceptionKind, number>;
      lastTs: number;
    }
  >();

  for (const event of events) {
    const route = deriveExceptionRoute(event);
    const existing = groups.get(route) ?? {
      failureCount: 0,
      criticalCount: 0,
      kindCounts: new Map<ExceptionKind, number>(),
      lastTs: 0,
    };
    existing.failureCount += 1;
    if (event.severity === "critical") {
      existing.criticalCount += 1;
    }
    existing.kindCounts.set(event.kind, (existing.kindCounts.get(event.kind) ?? 0) + 1);
    if (event.ts > existing.lastTs) {
      existing.lastTs = event.ts;
    }
    groups.set(route, existing);
  }

  return Array.from(groups.entries())
    .map(([route, stats]) => {
      let dominantKind: ExceptionKind = "other";
      let maxKindCount = -1;
      for (const [kind, count] of stats.kindCounts.entries()) {
        if (count > maxKindCount) {
          maxKindCount = count;
          dominantKind = kind;
        }
      }
      return {
        route,
        failureCount: stats.failureCount,
        criticalCount: stats.criticalCount,
        errorRatePct: Math.round((stats.failureCount / totalEvents) * 1000) / 10,
        dominantKind,
        lastSeenAt: new Date(stats.lastTs || 0).toISOString(),
      };
    })
    .sort(
      (a, b) =>
        b.failureCount - a.failureCount ||
        b.criticalCount - a.criticalCount ||
        a.route.localeCompare(b.route),
    )
    .slice(0, limit);
}

/**
 * Aggregates uptime statistics across external synthetic probes and live gateway metric samples.
 */
export function aggregateOperationalUptimeStats(options: {
  externalServices?: readonly ExternalServiceHealth[];
  metricSamples?: readonly OperationalMetricSample[];
  slaTargetPercentage?: number;
} = {}): OperationalUptimeStats {
  const slaTargetPercentage = options.slaTargetPercentage ?? 99.9;
  const servicesList = options.externalServices ?? [];
  const metricSamples = options.metricSamples ?? [];

  const services: ServiceUptimeSummary[] = servicesList.map((svc) => ({
    service: svc.service,
    label: svc.label,
    status: svc.status,
    uptimePercentage: svc.uptimePercentage,
    p50LatencyMs: svc.rollingLatency.p50,
    p95LatencyMs: svc.rollingLatency.p95,
    consecutiveFailures: svc.consecutiveFailures,
  }));

  const healthyServicesCount = services.filter((s) => s.status === "healthy").length;
  const degradedServicesCount = services.filter((s) => s.status === "degraded").length;
  const downServicesCount = services.filter((s) => s.status === "down").length;

  const overallUptimePercentage =
    services.length > 0
      ? Math.round(
          (services.reduce((sum, s) => sum + s.uptimePercentage, 0) / services.length) * 10,
        ) / 10
      : 100;

  const rpcLatencies = metricSamples
    .map((s) => s.rpcLatencyMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);

  const avgRpcLatencyMs =
    rpcLatencies.length > 0
      ? Math.round(rpcLatencies.reduce((sum, v) => sum + v, 0) / rpcLatencies.length)
      : services.length > 0
        ? Math.round(
            services.reduce((sum, s) => sum + s.p50LatencyMs, 0) / services.length,
          ) || null
        : null;

  const p95RpcLatencyMs =
    rpcLatencies.length > 0
      ? computePercentile(rpcLatencies, 95)
      : services.length > 0
        ? Math.max(...services.map((s) => s.p95LatencyMs)) || null
        : null;

  const peakHeapUsageRatio =
    metricSamples.length > 0
      ? Math.round(
          Math.max(
            ...metricSamples.map((s) =>
              s.heapTotalBytes > 0 ? s.heapUsedBytes / s.heapTotalBytes : 0,
            ),
          ) * 1000,
        ) / 1000
      : 0;

  return {
    overallUptimePercentage,
    slaTargetPercentage,
    slaMet: overallUptimePercentage >= slaTargetPercentage && downServicesCount === 0,
    healthyServicesCount,
    degradedServicesCount,
    downServicesCount,
    totalServicesCount: services.length,
    avgRpcLatencyMs,
    p95RpcLatencyMs,
    peakHeapUsageRatio,
    services,
  };
}

/**
 * Builds the complete executive operational report combining health categories,
 * uptime stats, error trend summaries, and top failing routes.
 */
export function buildExecutiveOperationalReport(
  input: BuildExecutiveOperationalReportInput = {},
): ExecutiveOperationalReport {
  const now = input.now ?? Date.now();
  const windowMinutes = Math.max(1, input.windowMinutes ?? 60);
  const bucketMinutes = Math.max(1, input.bucketMinutes ?? Math.round(windowMinutes / 12));
  const windowMs = windowMinutes * MINUTE_MS;
  const bucketMs = bucketMinutes * MINUTE_MS;
  const filters = input.filters ?? {};
  const events = input.exceptionEvents ?? [];

  const trendReport =
    input.trendReport ??
    buildExceptionTrendReport(events, {
      windowMs,
      bucketMs,
      now,
      filters,
      rules: input.rules ?? DEFAULT_ALERT_RULES,
    });

  const windowStart = now - windowMs;
  const inWindowEvents = events.filter(
    (event) =>
      event.ts >= windowStart && event.ts < now && matchesExceptionFilters(event, filters),
  );

  const criticalExceptions = inWindowEvents.filter((e) => e.severity === "critical").length;
  const rpcExceptions = inWindowEvents.filter((e) => e.kind === "rpc").length;
  const buckets = trendReport.buckets;
  const peakErrorsPerMinute =
    buckets.length > 0 ? Math.max(...buckets.map((b) => b.ratePerMinute)) : 0;
  const avgErrorsPerMinute =
    Math.round((trendReport.total / windowMinutes) * 100) / 100;

  const midpoint = Math.floor(buckets.length / 2);
  const firstHalfCount = buckets
    .slice(0, midpoint)
    .reduce((sum, b) => sum + b.count, 0);
  const secondHalfCount = buckets
    .slice(midpoint)
    .reduce((sum, b) => sum + b.count, 0);

  let trendDirection: OperationalErrorTrendSummary["trendDirection"] = "stable";
  if ( buckets.length >= 2) {
    if (secondHalfCount > firstHalfCount * 1.25 && secondHalfCount - firstHalfCount >= 2) {
      trendDirection = "degrading";
    } else if (firstHalfCount > secondHalfCount * 1.25 && firstHalfCount - secondHalfCount >= 2) {
      trendDirection = "improving";
    }
  }

  const healthCategories =
    input.health?.categories ?? buildOperationalHealth([], now).categories;

  return {
    generatedAt: input.health?.generatedAt ?? new Date(now).toISOString(),
    windowMinutes,
    healthCategories,
    uptime: aggregateOperationalUptimeStats({
      externalServices: input.externalServices,
      metricSamples: input.metricSamples,
      slaTargetPercentage: input.slaTargetPercentage,
    }),
    errorTrends: {
      windowMinutes,
      totalExceptions: trendReport.total,
      criticalExceptions,
      rpcExceptions,
      peakErrorsPerMinute,
      avgErrorsPerMinute,
      trendDirection,
      activeBreaches: trendReport.breaches,
      buckets,
    },
    topFailingRoutes: aggregateTopFailingRoutes(
      inWindowEvents,
      input.topRoutesLimit ?? 5,
    ),
  };
}

/**
 * Escapes a single CSV field according to RFC 4180 and neutralizes formula injection prefixes.
 */
export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (/^[=+\-@]/.test(str) && !/^-[0-9]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const OPERATIONAL_CSV_HEADERS = [
  "timestamp",
  "isoTimestamp",
  "series",
  "heapUsedBytes",
  "heapTotalBytes",
  "heapUsagePct",
  "activeConnections",
  "rpcLatencyMs",
  "exceptionCount",
  "errorRatePerMinute",
  "warningCount",
  "errorCount",
  "criticalCount",
] as const;

/**
 * Formats raw operational time-series metric samples and error trend buckets into a structured CSV document.
 */
export function formatOperationalMetricsCsv(
  samples: readonly OperationalMetricSample[],
  buckets: readonly ErrorTrendBucket[] = [],
): string {
  const rows: Array<Array<string | number | null | undefined>> = [
    [...OPERATIONAL_CSV_HEADERS],
  ];

  const sortedSamples = [...samples].sort((a, b) => a.ts - b.ts);
  for (const sample of sortedSamples) {
    const heapPct =
      sample.heapTotalBytes > 0
        ? ((sample.heapUsedBytes / sample.heapTotalBytes) * 100).toFixed(2)
        : "0.00";
    rows.push([
      sample.ts,
      new Date(sample.ts).toISOString(),
      "system_performance",
      sample.heapUsedBytes,
      sample.heapTotalBytes,
      heapPct,
      sample.activeConnections,
      sample.rpcLatencyMs ?? "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  const sortedBuckets = [...buckets].sort((a, b) => a.bucketStart - b.bucketStart);
  for (const bucket of sortedBuckets) {
    rows.push([
      bucket.bucketStart,
      new Date(bucket.bucketStart).toISOString(),
      "exception_trend",
      "",
      "",
      "",
      "",
      "",
      bucket.count,
      bucket.ratePerMinute.toFixed(2),
      bucket.bySeverity.warning,
      bucket.bySeverity.error,
      bucket.bySeverity.critical,
    ]);
  }

  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\n");
}

const PDF_PAGE_WIDTH = 612;
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN_LEFT = 44;
const PDF_MARGIN_RIGHT = 44;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT;
const PDF_TOP_START_Y = PDF_PAGE_HEIGHT - 52;
const PDF_BOTTOM_LIMIT_Y = 56;

function escapePdfString(text: string): string {
  const ascii = text
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2022/g, "*")
    .replace(/[^\x20-\x7E]/g, "?");
  return ascii
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncatePdfCell(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

class OperationalPdfBuilder {
  private pages: string[][] = [[]];
  private cursorY = PDF_TOP_START_Y;

  private get currentCommands(): string[] {
    return this.pages[this.pages.length - 1];
  }

  ensureSpace(heightNeeded: number): void {
    if (this.cursorY - heightNeeded < PDF_BOTTOM_LIMIT_Y) {
      this.newPage();
    }
  }

  newPage(): void {
    this.pages.push([]);
    this.cursorY = PDF_TOP_START_Y;
  }

  moveDown(pts: number): void {
    this.cursorY -= pts;
  }

  drawRect(
    x: number,
    y: number,
    width: number,
    height: number,
    fillRgb: [number, number, number],
  ): void {
    const [r, g, b] = fillRgb.map((c) => Number(c.toFixed(3)));
    this.currentCommands.push(
      `q ${r} ${g} ${b} rg ${x.toFixed(1)} ${y.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)} re f Q`,
    );
  }

  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    strokeRgb: [number, number, number] = [0.82, 0.85, 0.9],
    lineWidth = 0.75,
  ): void {
    const [r, g, b] = strokeRgb.map((c) => Number(c.toFixed(3)));
    this.currentCommands.push(
      `q ${r} ${g} ${b} RG ${lineWidth} w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S Q`,
    );
  }

  drawText(
    text: string,
    x: number,
    y: number,
    options: {
      font?: "F1" | "F2" | "F3";
      size?: number;
      color?: [number, number, number];
    } = {},
  ): void {
    const font = options.font ?? "F1";
    const size = options.size ?? 10;
    const [r, g, b] = (options.color ?? [0.1, 0.14, 0.2]).map((c) =>
      Number(c.toFixed(3)),
    );
    this.currentCommands.push(
      `BT /${font} ${size} Tf ${r} ${g} ${b} rg ${x.toFixed(1)} ${y.toFixed(1)} Td (${escapePdfString(text)}) Tj ET`,
    );
  }

  drawSectionHeader(title: string): void {
    this.ensureSpace(36);
    this.moveDown(10);
    this.drawRect(
      PDF_MARGIN_LEFT,
      this.cursorY - 18,
      PDF_CONTENT_WIDTH,
      22,
      [0.93, 0.96, 0.95],
    );
    this.drawText(title, PDF_MARGIN_LEFT + 8, this.cursorY - 11, {
      font: "F2",
      size: 11,
      color: [0.06, 0.28, 0.22],
    });
    this.moveDown(26);
  }

  drawKeyValueRow(label: string, value: string): void {
    this.ensureSpace(16);
    this.drawText(label, PDF_MARGIN_LEFT + 6, this.cursorY - 10, {
      font: "F2",
      size: 9.5,
      color: [0.22, 0.27, 0.34],
    });
    this.drawText(value, PDF_MARGIN_LEFT + 190, this.cursorY - 10, {
      font: "F1",
      size: 9.5,
      color: [0.08, 0.12, 0.18],
    });
    this.moveDown(15);
  }

  drawTable(
    headers: readonly { label: string; xOffset: number; maxChars?: number }[],
    rows: readonly string[][],
  ): void {
    this.ensureSpace(28);
    const headerY = this.cursorY - 12;
    this.drawRect(
      PDF_MARGIN_LEFT,
      headerY - 4,
      PDF_CONTENT_WIDTH,
      18,
      [0.12, 0.18, 0.26],
    );
    for (const col of headers) {
      this.drawText(col.label, PDF_MARGIN_LEFT + col.xOffset, headerY, {
        font: "F2",
        size: 8.5,
        color: [0.96, 0.98, 1],
      });
    }
    this.moveDown(20);

    rows.forEach((row, rowIndex) => {
      this.ensureSpace(16);
      const rowY = this.cursorY - 10;
      if (rowIndex % 2 === 1) {
        this.drawRect(
          PDF_MARGIN_LEFT,
          rowY - 4,
          PDF_CONTENT_WIDTH,
          15,
          [0.97, 0.98, 0.99],
        );
      }
      row.forEach((cell, colIndex) => {
        const col = headers[colIndex];
        if (!col) return;
        const formatted = col.maxChars
          ? truncatePdfCell(cell, col.maxChars)
          : cell;
        this.drawText(formatted, PDF_MARGIN_LEFT + col.xOffset, rowY, {
          font: colIndex === 0 ? "F3" : "F1",
          size: 8.5,
          color: [0.12, 0.16, 0.22],
        });
      });
      this.moveDown(15);
    });

    this.drawLine(
      PDF_MARGIN_LEFT,
      this.cursorY,
      PDF_PAGE_WIDTH - PDF_MARGIN_RIGHT,
      this.cursorY,
    );
    this.moveDown(6);
  }

  build(reportGeneratedAt: string): Uint8Array {
    const totalPages = this.pages.length;

    this.pages.forEach((commands, idx) => {
      const footerY = 28;
      commands.push(
        `q 0.82 0.85 0.9 RG 0.5 w ${PDF_MARGIN_LEFT} ${footerY + 12} m ${PDF_PAGE_WIDTH - PDF_MARGIN_RIGHT} ${footerY + 12} l S Q`,
      );
      commands.push(
        `BT /F1 8 Tf 0.4 0.45 0.52 rg ${PDF_MARGIN_LEFT} ${footerY} Td (${escapePdfString(
          `Trellis Maintainer Operations Report | Generated ${reportGeneratedAt} | Redacted Governance Summary`,
        )}) Tj ET`,
      );
      commands.push(
        `BT /F2 8 Tf 0.4 0.45 0.52 rg ${PDF_PAGE_WIDTH - PDF_MARGIN_RIGHT - 55} ${footerY} Td (${escapePdfString(
          `Page ${idx + 1} of ${totalPages}`,
        )}) Tj ET`,
      );
    });

    const objects: string[] = [];
    const pageObjectIds: number[] = [];

    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push("");
    objects.push(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    objects.push(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    objects.push(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    );
    objects.push(
      `<< /Title (Trellis Executive Operational Health Report) /Creator (Trellis Operations Dashboard) /CreationDate (D:${reportGeneratedAt.replace(/[-:T.Z]/g, "").slice(0, 14)}Z) >>`,
    );

    for (const pageCommands of this.pages) {
      const pageObjId = objects.length + 1;
      const contentObjId = objects.length + 2;
      pageObjectIds.push(pageObjId);

      const streamBody = pageCommands.join("\n");
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjId} 0 R >>`,
      );
      objects.push(
        `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`,
      );
    }

    objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;

    const chunks: string[] = ["%PDF-1.4\n"];
    const offsets: number[] = [0];
    let byteOffset = chunks[0].length;

    objects.forEach((objBody, idx) => {
      offsets.push(byteOffset);
      const serialized = `${idx + 1} 0 obj\n${objBody}\nendobj\n`;
      chunks.push(serialized);
      byteOffset += serialized.length;
    });

    const xrefOffset = byteOffset;
    const xrefLines = [
      "xref",
      `0 ${objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    ];
    const trailer = [
      ...xrefLines,
      "trailer",
      `<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF\n",
    ].join("\n");

    chunks.push(trailer);
    return new TextEncoder().encode(chunks.join(""));
  }
}

/**
 * Generates a printable client-side PDF 1.4 document from an ExecutiveOperationalReport.
 */
export function generateOperationalReportPdf(
  report: ExecutiveOperationalReport,
): Uint8Array {
  const pdf = new OperationalPdfBuilder();

  pdf.drawRect(
    PDF_MARGIN_LEFT,
    PDF_PAGE_HEIGHT - 102,
    PDF_CONTENT_WIDTH,
    56,
    [0.05, 0.14, 0.22],
  );
  pdf.drawText(
    "TRELLIS OPERATIONAL HEALTH - EXECUTIVE REPORT",
    PDF_MARGIN_LEFT + 14,
    PDF_PAGE_HEIGHT - 68,
    { font: "F2", size: 14, color: [0.31, 0.75, 0.61] },
  );
  pdf.drawText(
    `Generated: ${report.generatedAt}   |   Evaluation Window: ${report.windowMinutes} min   |   SLA Status: ${
      report.uptime.slaMet ? "PASSING" : "ATTENTION REQUIRED"
    }`,
    PDF_MARGIN_LEFT + 14,
    PDF_PAGE_HEIGHT - 88,
    { font: "F1", size: 9, color: [0.88, 0.92, 0.96] },
  );
  pdf.moveDown(62);

  pdf.drawSectionHeader("1. Uptime & Service Reliability Statistics");
  pdf.drawKeyValueRow(
    "Overall Service Uptime:",
    `${report.uptime.overallUptimePercentage.toFixed(1)}% (SLA Target: ${report.uptime.slaTargetPercentage.toFixed(1)}% - ${
      report.uptime.slaMet ? "SLA Met" : "SLA Breached"
    })`,
  );
  pdf.drawKeyValueRow(
    "Monitored Services:",
    `${report.uptime.totalServicesCount} total (${report.uptime.healthyServicesCount} healthy, ${report.uptime.degradedServicesCount} degraded, ${report.uptime.downServicesCount} down)`,
  );
  pdf.drawKeyValueRow(
    "RPC Probe Latency (Avg / P95):",
    report.uptime.avgRpcLatencyMs !== null
      ? `${report.uptime.avgRpcLatencyMs} ms avg / ${report.uptime.p95RpcLatencyMs ?? report.uptime.avgRpcLatencyMs} ms p95`
      : "No RPC latency samples recorded",
  );
  pdf.drawKeyValueRow(
    "Peak Gateway Heap Utilization:",
    `${(report.uptime.peakHeapUsageRatio * 100).toFixed(1)}%`,
  );

  if (report.uptime.services.length > 0) {
    pdf.moveDown(4);
    pdf.drawTable(
      [
        { label: "Service", xOffset: 6, maxChars: 24 },
        { label: "Status", xOffset: 170, maxChars: 12 },
        { label: "Uptime %", xOffset: 255, maxChars: 10 },
        { label: "P50 (ms)", xOffset: 335, maxChars: 10 },
        { label: "P95 (ms)", xOffset: 405, maxChars: 10 },
        { label: "Consec. Failures", xOffset: 460, maxChars: 10 },
      ],
      report.uptime.services.map((svc) => [
        svc.label || svc.service,
        svc.status.toUpperCase(),
        `${svc.uptimePercentage.toFixed(1)}%`,
        String(svc.p50LatencyMs),
        String(svc.p95LatencyMs),
        String(svc.consecutiveFailures),
      ]),
    );
  }

  pdf.drawSectionHeader("2. Operational Health Categories");
  if (report.healthCategories.length > 0) {
    pdf.drawTable(
      [
        { label: "Category", xOffset: 6, maxChars: 34 },
        { label: "Count", xOffset: 250, maxChars: 12 },
        { label: "Severity", xOffset: 340, maxChars: 14 },
        { label: "Action Path", xOffset: 420, maxChars: 24 },
      ],
      report.healthCategories.map((cat) => [
        cat.label,
        String(cat.count),
        cat.severity.toUpperCase(),
        cat.href,
      ]),
    );
  }

  pdf.drawSectionHeader("3. Error Trends & Alert Rule Evaluation");
  pdf.drawKeyValueRow(
    "Total Window Exceptions:",
    `${report.errorTrends.totalExceptions} (${report.errorTrends.criticalExceptions} critical, ${report.errorTrends.rpcExceptions} RPC errors)`,
  );
  pdf.drawKeyValueRow(
    "Error Rate (Avg / Peak):",
    `${report.errorTrends.avgErrorsPerMinute.toFixed(2)} errors/min avg   |   ${report.errorTrends.peakErrorsPerMinute.toFixed(2)} errors/min peak`,
  );
  pdf.drawKeyValueRow(
    "Error Trend Direction:",
    report.errorTrends.trendDirection.toUpperCase(),
  );
  pdf.drawKeyValueRow(
    "Active Alert Breaches:",
    report.errorTrends.activeBreaches.length === 0
      ? "None (all rules within threshold)"
      : report.errorTrends.activeBreaches
          .map(
            (b) =>
              `${b.ruleName} (${b.observed} > ${b.threshold}, ${b.severity})`,
          )
          .join("; "),
  );

  if (report.errorTrends.buckets.length > 0) {
    pdf.moveDown(4);
    pdf.drawTable(
      [
        { label: "Bucket (UTC)", xOffset: 6, maxChars: 16 },
        { label: "Total", xOffset: 130, maxChars: 10 },
        { label: "Rate / min", xOffset: 205, maxChars: 12 },
        { label: "Critical", xOffset: 300, maxChars: 10 },
        { label: "Error", xOffset: 380, maxChars: 10 },
        { label: "Warning", xOffset: 450, maxChars: 10 },
      ],
      report.errorTrends.buckets.slice(-12).map((bucket) => [
        bucket.label,
        String(bucket.count),
        bucket.ratePerMinute.toFixed(2),
        String(bucket.bySeverity.critical),
        String(bucket.bySeverity.error),
        String(bucket.bySeverity.warning),
      ]),
    );
  }

  pdf.drawSectionHeader("4. Top Failing Routes");
  if (report.topFailingRoutes.length === 0) {
    pdf.drawKeyValueRow(
      "Failing Routes:",
      "No route failures recorded in the selected evaluation window.",
    );
  } else {
    pdf.drawTable(
      [
        { label: "Route Template", xOffset: 6, maxChars: 30 },
        { label: "Failures", xOffset: 205, maxChars: 10 },
        { label: "Critical", xOffset: 270, maxChars: 10 },
        { label: "Share %", xOffset: 335, maxChars: 10 },
        { label: "Dominant Kind", xOffset: 400, maxChars: 12 },
        { label: "Last Seen", xOffset: 475, maxChars: 10 },
      ],
      report.topFailingRoutes.map((route) => [
        route.route,
        String(route.failureCount),
        String(route.criticalCount),
        `${route.errorRatePct.toFixed(1)}%`,
        route.dominantKind.toUpperCase(),
        route.lastSeenAt.slice(11, 19) || route.lastSeenAt,
      ]),
    );
  }

  return pdf.build(report.generatedAt);
}

function triggerOperationalDownload(blob: Blob, filename: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Generates and downloads the printable PDF operational health report in the browser.
 */
export function downloadOperationalReportPdf(
  report: ExecutiveOperationalReport,
  filename?: string,
): Uint8Array {
  const pdfBytes = generateOperationalReportPdf(report);
  const dateSuffix = report.generatedAt.slice(0, 10);
  const resolvedFilename =
    filename ?? `operational-health-report-${dateSuffix}.pdf`;
  const copy = new Uint8Array(pdfBytes.byteLength);
  copy.set(pdfBytes);
  const blob = new Blob([copy.buffer], { type: "application/pdf" });
  triggerOperationalDownload(blob, resolvedFilename);
  return pdfBytes;
}

/**
 * Formats and downloads raw operational time-series metric data as a CSV file in the browser.
 */
export function downloadOperationalMetricsCsv(
  samples: readonly OperationalMetricSample[],
  buckets: readonly ErrorTrendBucket[] = [],
  filename?: string,
): string {
  const csv = formatOperationalMetricsCsv(samples, buckets);
  const dateSuffix = new Date().toISOString().slice(0, 10);
  const resolvedFilename =
    filename ?? `operational-metrics-${dateSuffix}.csv`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  triggerOperationalDownload(blob, resolvedFilename);
  return csv;
}



