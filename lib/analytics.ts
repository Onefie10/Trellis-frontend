import { isMetricSafe } from "./metric-definitions";
import {
  createPrivacyAuditSnapshot,
  DEFAULT_DAILY_PRIVACY_BUDGET,
  DEFAULT_EPSILON,
  makeAuditEntry,
  MAX_RELEASED_COUNT,
  MIN_EPSILON,
  PRIVACY_AUDIT_STORAGE_KEY,
  privatizeCount,
  readPrivacyAuditState,
  validateEpsilon,
  validatePrivacyBudget,
  writePrivacyAuditState,
  type PrivacyAuditSnapshot,
} from "../features/analytics/privacy";

/**
 * Privacy-Preserving Analytics
 *
 * Maintains usage and reliability analytics without exposing private user data,
 * secrets, or sensitive payload content.
 */

export type MetricType = "event" | "error" | "performance" | "usage";

export type SafeDimension =
  | "event_type"
  | "feature"
  | "platform"
  | "network"
  | "timestamp"
  | "duration"
  | "error_type";

export interface AggregateMetric {
  id: string;
  type: MetricType;
  name: string;
  timestamp: number;
  dimensions: Record<SafeDimension, string | number>;
  value: number;
  count?: number;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsConfig {
  enabled: boolean;
  retentionDays: number;
  samplingRate: number;
  /** Laplace mechanism epsilon allocated to each batch release. */
  epsilon: number;
  /** Maximum composed epsilon released by this browser per UTC day. */
  dailyPrivacyBudget: number;
  allowedDimensions: SafeDimension[];
  sensitivePatterns: RegExp[];
}

const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: true,
  retentionDays: 90,
  samplingRate: 1.0,
  epsilon: DEFAULT_EPSILON,
  dailyPrivacyBudget: DEFAULT_DAILY_PRIVACY_BUDGET,
  allowedDimensions: [
    "event_type",
    "feature",
    "platform",
    "network",
    "timestamp",
    "duration",
    "error_type",
  ],
  sensitivePatterns: [
    /(?:password|secret|token|api_key|private_key|seed)/i,
    /(?:email|phone|ssn|credit_card)/i,
    /(?:wallet|address|xrp|xlm)/i,
  ],
};

/**
 * Checks if a value matches sensitive patterns
 */
function containsSensitiveData(value: unknown): boolean {
  const str = String(value).toLowerCase();
  return DEFAULT_CONFIG.sensitivePatterns.some((pattern) => pattern.test(str));
}

/**
 * Sanitizes an object by removing sensitive fields
 */
function sanitizeObject(obj: unknown): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip obviously sensitive fields
    if (
      /(?:password|secret|token|key|seed|private|wallet|address)/i.test(key)
    ) {
      continue;
    }

    // Skip values that contain sensitive data
    if (typeof value === "string" && containsSensitiveData(value)) {
      continue;
    }

    // Include safe values
    if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else if (typeof value === "string" && value.length < 100) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Analytics Manager
 */
class AnalyticsManager {
  private config: AnalyticsConfig = { ...DEFAULT_CONFIG };
  private queue: AggregateMetric[] = [];

  initialize(overrides?: Partial<AnalyticsConfig>): void {
    if (overrides) {
      this.config = {
        ...this.config,
        ...overrides,
        epsilon: overrides.epsilon === undefined
          ? this.config.epsilon
          : validateEpsilon(overrides.epsilon),
        dailyPrivacyBudget: overrides.dailyPrivacyBudget === undefined
          ? this.config.dailyPrivacyBudget
          : validatePrivacyBudget(overrides.dailyPrivacyBudget),
      };
    }
  }

  /** Change the client-side privacy level used for subsequent reports. */
  setPrivacyEpsilon(epsilon: number): void {
    this.config.epsilon = validateEpsilon(epsilon);
  }

  /** Settings and recent releases shown in the privacy audit panel. */
  getPrivacyAuditLog(): PrivacyAuditSnapshot {
    return createPrivacyAuditSnapshot(
      this.config.epsilon,
      this.config.dailyPrivacyBudget,
      this.config.enabled,
    );
  }

  /**
   * Record an event with automatic privacy filtering
   */
  recordEvent(
    name: string,
    dimensions: Record<string, string | number>,
    value: number = 1,
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Apply sampling
    if (Math.random() > this.config.samplingRate) {
      return;
    }

    // Filter dimensions to safe ones only
    const safeDimensions: Record<SafeDimension, string | number> = {} as Record<
      SafeDimension,
      string | number
    >;
    for (const dim of this.config.allowedDimensions) {
      if (dim in dimensions) {
        safeDimensions[dim] = dimensions[dim];
      }
    }

    const metric: AggregateMetric = {
      id: this.generateId(),
      type: "event",
      name,
      timestamp: Date.now(),
      dimensions: safeDimensions,
      value,
      count: 1,
    };

    this.queue.push(metric);

    // Auto-flush if queue is large
    if (this.queue.length >= 100) {
      this.flush();
    }
  }

  /**
   * Record an error with sanitized context
   */
  recordError(
    errorType: string,
    context: Record<string, unknown>,
  ): void {
    if (!this.config.enabled) {
      return;
    }

    const sanitizedContext = sanitizeObject(context);

    const metric: AggregateMetric = {
      id: this.generateId(),
      type: "error",
      name: isMetricSafe(`error.${errorType}`) ? `error.${errorType}` : "error.client_error",
      timestamp: Date.now(),
      dimensions: {
        error_type: errorType,
      } as Record<SafeDimension, string | number>,
      value: 1,
      metadata: sanitizedContext,
    };

    this.queue.push(metric);
  }

  /**
   * Record performance metrics
   */
  recordPerformance(_name: string, duration: number): void {
    if (!this.config.enabled) {
      return;
    }

    const metric: AggregateMetric = {
      id: this.generateId(),
      type: "performance",
      // Keep arbitrary operation labels local; the release uses a fixed safe category.
      name: "system.performance",
      timestamp: Date.now(),
      dimensions: {
        duration: duration,
      } as Record<SafeDimension, string | number>,
      value: duration,
    };

    this.queue.push(metric);
  }

  /**
   * Validate metric fields for sensitive data
   */
  validateMetric(metric: AggregateMetric): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check all dimension values
    for (const [key, value] of Object.entries(metric.dimensions)) {
      if (containsSensitiveData(value)) {
        issues.push(`Dimension "${key}" contains sensitive data`);
      }
    }

    // Check metadata
    if (metric.metadata) {
      for (const [key, value] of Object.entries(metric.metadata)) {
        if (typeof value === "string" && containsSensitiveData(value)) {
          issues.push(`Metadata "${key}" contains sensitive data`);
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Get queued metrics without flushing
   */
  getQueuedMetrics(): AggregateMetric[] {
    return [...this.queue];
  }

  /**
   * Flush metrics to storage/backend
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    const metrics = [...this.queue];
    this.queue = [];

    // Validate all metrics before sending
    const validMetrics = metrics.filter(
      (metric) => isMetricSafe(metric.name) && this.validateMetric(metric).valid,
    );

    if (validMetrics.length === 0) {
      console.warn("No valid metrics to flush");
      return;
    }

    const groupedCounts = new Map<string, { type: MetricType; name: string; count: number }>();
    for (const metric of validMetrics) {
      // Only aggregate by allowlisted metric names; event IDs, exact timestamps,
      // raw values, and dimension values never cross the reporting boundary.
      const key = `${metric.type}:${metric.name}`;
      const group = groupedCounts.get(key);
      if (group) {
        group.count = Math.min(MAX_RELEASED_COUNT, group.count + 1);
      } else {
        groupedCounts.set(key, { type: metric.type, name: metric.name, count: 1 });
      }
    }

    const now = Date.now();
    const audit = readPrivacyAuditState(now);
    const remaining = Math.max(0, this.config.dailyPrivacyBudget - audit.spent);
    if (remaining < MIN_EPSILON) {
      audit.entries.push(makeAuditEntry("budget_exhausted", 0, groupedCounts.size, now));
      writePrivacyAuditState(audit);
      return;
    }

    const epsilon = Math.min(this.config.epsilon, remaining);
    const reportTimestamp = Math.floor(now / 86_400_000) * 86_400_000;
    const releasedMetrics: AggregateMetric[] = Array.from(groupedCounts.values(), (group) => {
      const noisyCount = privatizeCount(group.count, epsilon);
      return {
        id: this.generateAggregateId(),
        type: group.type,
        name: group.name,
        timestamp: reportTimestamp,
        dimensions: {} as Record<SafeDimension, string | number>,
        value: noisyCount,
        count: noisyCount,
      };
    });

    // Spend before the request: a timeout can happen after the collector received
    // the payload, so refunding would permit repeated releases beyond the budget.
    audit.spent = Math.min(this.config.dailyPrivacyBudget, audit.spent + epsilon);
    audit.entries.push(makeAuditEntry("released", epsilon, releasedMetrics.length, now));
    audit.entries = audit.entries.slice(-30);
    writePrivacyAuditState(audit);

    try {
      await this.sendMetrics(releasedMetrics, epsilon, Math.max(0, this.config.dailyPrivacyBudget - audit.spent));
    } catch (error) {
      console.error("Failed to flush metrics:", error);
      // Do not re-queue raw events; a failed request may still have reached the collector.
    }
  }

  private async sendMetrics(
    metrics: AggregateMetric[],
    epsilon: number,
    privacyBudgetRemaining: number,
  ): Promise<void> {
    const response = await fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metrics,
        privacy: {
          mechanism: "Laplace",
          epsilon,
          privacyBudgetRemaining,
        },
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to send metrics");
    }
  }

  private generateId(): string {
    return `metric_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateAggregateId(): string {
    try {
      if (globalThis.crypto?.randomUUID) return `aggregate_${globalThis.crypto.randomUUID()}`;
    } catch {
      // Fall back to a non-time-based opaque identifier below.
    }
    return `aggregate_${Math.random().toString(36).slice(2, 14)}`;
  }

  reset(): void {
    this.queue = [];
    this.config = { ...DEFAULT_CONFIG };
    try {
      if (typeof window !== "undefined") window.localStorage.removeItem(PRIVACY_AUDIT_STORAGE_KEY);
    } catch {
      // Storage may be disabled; reset the in-memory queue/config regardless.
    }
  }
}

export const analyticsManager = new AnalyticsManager();