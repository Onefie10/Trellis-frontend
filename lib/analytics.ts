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
  allowedDimensions: SafeDimension[];
  sensitivePatterns: RegExp[];
}

const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: true,
  retentionDays: 90,
  samplingRate: 1.0,
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
      this.config = { ...this.config, ...overrides };
    }
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
      name: errorType,
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
  recordPerformance(name: string, duration: number): void {
    if (!this.config.enabled) {
      return;
    }

    const metric: AggregateMetric = {
      id: this.generateId(),
      type: "performance",
      name,
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
    const validMetrics = metrics.filter((m) => this.validateMetric(m).valid);

    if (validMetrics.length === 0) {
      console.warn("No valid metrics to flush");
      return;
    }

    try {
      await this.sendMetrics(validMetrics);
    } catch (error) {
      console.error("Failed to flush metrics:", error);
      // Re-queue for retry
      this.queue = [...validMetrics, ...this.queue];
    }
  }

  private async sendMetrics(metrics: AggregateMetric[]): Promise<void> {
    const response = await fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metrics }),
    });

    if (!response.ok) {
      throw new Error("Failed to send metrics");
    }
  }

  private generateId(): string {
    return `metric_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  reset(): void {
    this.queue = [];
  }
}

export const analyticsManager = new AnalyticsManager();
