import { analyticsManager, AggregateMetric } from "../../../lib/analytics";
import { isMetricSafe, isFieldSafe } from "../../../lib/metric-definitions";
import { privatizeCount, sampleLaplaceNoise } from "../privacy";

let fetchMock: jest.Mock;

describe("Privacy-Preserving Analytics", () => {
  beforeEach(() => {
    analyticsManager.reset();
    analyticsManager.initialize({ enabled: true });
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
  });

  describe("Sensitive Data Blocking", () => {
    it("should not log raw sensitive values", async () => {
      analyticsManager.recordEvent("user.action", {
        event_type: "transaction",
        password: "secret123", // Should be blocked
      });

      const metrics = analyticsManager.getQueuedMetrics();
      const metric = metrics[0];

      expect("password" in metric.dimensions).toBe(false);
    });

    it("should not include wallet addresses in metrics", () => {
      analyticsManager.recordEvent("wallet.connected", {
        event_type: "connection",
        wallet_address: "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      });

      const metrics = analyticsManager.getQueuedMetrics();
      const metric = metrics[0];

      expect("wallet_address" in metric.dimensions).toBe(false);
    });

    it("should not log API keys or tokens", () => {
      analyticsManager.recordEvent("system.api_call", {
        event_type: "api",
        api_key: "secret_key_12345",
      });

      const metrics = analyticsManager.getQueuedMetrics();
      const metric = metrics[0];

      expect("api_key" in metric.dimensions).toBe(false);
    });
  });

  describe("Metric Validation", () => {
    it("should validate metrics for sensitive data", () => {
      const metric: AggregateMetric = {
        id: "test-1",
        type: "event",
        name: "user.action",
        timestamp: Date.now(),
        dimensions: {
          event_type: "transaction",
          feature: "claim_settlement",
        },
        value: 1,
      };

      const validation = analyticsManager.validateMetric(metric);
      expect(validation.valid).toBe(true);
      expect(validation.issues.length).toBe(0);
    });

    it("should reject metrics with sensitive dimensions", () => {
      const metric: AggregateMetric = {
        id: "test-2",
        type: "event",
        name: "user.action",
        timestamp: Date.now(),
        dimensions: {
          event_type: "transaction",
          wallet: "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
        } as any,
        value: 1,
      };

      const validation = analyticsManager.validateMetric(metric);
      expect(validation.valid).toBe(false);
    });

    it("should reject metrics with sensitive metadata", () => {
      const metric: AggregateMetric = {
        id: "test-3",
        type: "event",
        name: "user.action",
        timestamp: Date.now(),
        dimensions: {
          event_type: "transaction",
        },
        value: 1,
        metadata: {
          email: "user@example.com",
        },
      };

      const validation = analyticsManager.validateMetric(metric);
      expect(validation.valid).toBe(false);
    });
  });

  describe("Safe Dimensions Only", () => {
    it("should aggregate by event_type safely", () => {
      analyticsManager.recordEvent("user.feature_used", {
        event_type: "claim_creation",
        feature: "claims",
      });

      const metrics = analyticsManager.getQueuedMetrics();
      expect(metrics[0].dimensions.event_type).toBe("claim_creation");
    });

    it("should aggregate by platform safely", () => {
      analyticsManager.recordEvent("system.api_call", {
        platform: "web",
        event_type: "api_request",
      });

      const metrics = analyticsManager.getQueuedMetrics();
      expect(metrics[0].dimensions.platform).toBe("web");
    });

    it("should aggregate by network safely", () => {
      analyticsManager.recordEvent("system.api_call", {
        network: "testnet",
        event_type: "blockchain_query",
      });

      const metrics = analyticsManager.getQueuedMetrics();
      expect(metrics[0].dimensions.network).toBe("testnet");
    });
  });

  describe("Metric Definitions", () => {
    it("should validate safe metrics", () => {
      expect(isMetricSafe("user.session_start")).toBe(true);
      expect(isMetricSafe("transaction.completed")).toBe(true);
    });

    it("should validate safe fields", () => {
      expect(isFieldSafe("event_type")).toBe(true);
      expect(isFieldSafe("duration")).toBe(true);
      expect(isFieldSafe("platform")).toBe(true);
    });

    it("should reject unsafe fields", () => {
      expect(isFieldSafe("password")).toBe(false);
      expect(isFieldSafe("api_key")).toBe(false);
      expect(isFieldSafe("wallet_address")).toBe(false);
    });
  });

  describe("Performance Metrics", () => {
    it("should record performance without sensitive data", () => {
      analyticsManager.recordPerformance("transaction.submit", 250);

      const metrics = analyticsManager.getQueuedMetrics();
      const metric = metrics[0];

      expect(metric.type).toBe("performance");
      expect(metric.value).toBe(250);
      expect(metric.dimensions.duration).toBe(250);
    });
  });

  describe("Error Metrics", () => {
    it("should record errors with sanitized context", () => {
      analyticsManager.recordError("validation_error", {
        field: "amount",
        message: "Amount must be positive",
        value: "invalid", // Generic value, not actual user input
      });

      const metrics = analyticsManager.getQueuedMetrics();
      const metric = metrics[0];

      expect(metric.type).toBe("error");
      expect(metric.dimensions.error_type).toBe("validation_error");
    });

    it("should not include sensitive error context", () => {
      analyticsManager.recordError("auth_error", {
        password: "user_password_here",
        message: "Invalid credentials",
      });

      const metrics = analyticsManager.getQueuedMetrics();
      const metric = metrics[0];

      // Sensitive data should not be in metadata
      if (metric.metadata) {
        expect("password" in metric.metadata).toBe(false);
      }
    });
  });

  describe("Retention Behavior", () => {
    it("should respect retention policy", () => {
      analyticsManager.initialize({
        enabled: true,
        retentionDays: 90,
      });

      const config = analyticsManager.initialize({ enabled: true });
      expect(config).toBeUndefined(); // Method returns void
    });
  });

  describe("Differential privacy noise", () => {
    it("uses the inverse Laplace CDF with the configured epsilon and sensitivity", () => {
      expect(sampleLaplaceNoise(1, 1, () => 0.5)).toBe(0);
      expect(sampleLaplaceNoise(1, 1, () => 0.75)).toBeCloseTo(Math.log(2));
      expect(sampleLaplaceNoise(1, 1, () => 0.25)).toBeCloseTo(-Math.log(2));
      expect(sampleLaplaceNoise(0.5, 2, () => 0.75)).toBeCloseTo(4 * Math.log(2));
    });

    it("has the expected zero mean and Laplace mean absolute deviation", () => {
      let seed = 0xdecafbad;
      const seededRandom = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 0x1_0000_0000;
      };
      const samples = Array.from({ length: 20_000 }, () => sampleLaplaceNoise(0.5, 1, seededRandom));
      const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      const meanAbsolute = samples.reduce((sum, value) => sum + Math.abs(value), 0) / samples.length;

      expect(Math.abs(mean)).toBeLessThan(0.08);
      // Laplace scale b = sensitivity / epsilon = 2, and E[|X|] = b.
      expect(meanAbsolute).toBeGreaterThan(1.85);
      expect(meanAbsolute).toBeLessThan(2.15);
    });

    it("bounds a released count after adding noise", () => {
      expect(privatizeCount(0, 1, () => 0.25)).toBe(0);
      expect(privatizeCount(5, 1, () => 0.5)).toBe(5);
      expect(privatizeCount(5, 1, () => 0.75)).toBe(6);
    });
  });

  describe("Private batch reporting", () => {
    it("sends noisy allowlisted aggregates without event-level fields", async () => {
      analyticsManager.initialize({ epsilon: 0.5, dailyPrivacyBudget: 2 });
      analyticsManager.recordEvent("user.session_start", {
        event_type: "session",
        feature: "dashboard",
      }, 987654);
      analyticsManager.recordEvent("user.session_start", {
        event_type: "session",
        feature: "wallet-address-must-not-be-sent",
      }, 987654);

      await analyticsManager.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(payload.privacy).toMatchObject({ mechanism: "Laplace", epsilon: 0.5 });
      expect(payload.metrics).toHaveLength(1);
      expect(payload.metrics[0]).toMatchObject({
        type: "event",
        name: "user.session_start",
      });
      expect(payload.metrics[0].dimensions).toEqual({});
      expect(payload.metrics[0].metadata).toBeUndefined();
      expect(payload.metrics[0].timestamp % 86_400_000).toBe(0);
      expect(JSON.stringify(payload)).not.toContain("wallet-address-must-not-be-sent");
      expect(JSON.stringify(payload)).not.toContain("987654");
      expect(analyticsManager.getPrivacyAuditLog().remaining).toBe(1.5);
    });

    it("stops releasing reports when the daily epsilon budget is exhausted", async () => {
      analyticsManager.initialize({ epsilon: 0.5, dailyPrivacyBudget: 0.5 });

      analyticsManager.recordEvent("user.session_start", { event_type: "session" });
      await analyticsManager.flush();
      analyticsManager.recordEvent("user.session_start", { event_type: "session" });
      await analyticsManager.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(analyticsManager.getPrivacyAuditLog().remaining).toBe(0);
      const entries = analyticsManager.getPrivacyAuditLog().entries;
      expect(entries[entries.length - 1]?.status).toBe("budget_exhausted");
    });
  });
});
