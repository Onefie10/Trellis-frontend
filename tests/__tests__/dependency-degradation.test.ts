import {
  buildDependencyFallbacks,
  DEPENDENCY_DEGRADATION_MATRIX,
  getDependencyFallbackGuidance,
} from "@/lib/dependency-degradation";
import { DEFAULT_SYNTHETIC_PROBE_TARGETS } from "@/lib/operational-health";

describe("external dependency degradation matrix", () => {
  it("covers every configured critical external dependency", () => {
    const configured = DEFAULT_SYNTHETIC_PROBE_TARGETS.map((target) => target.service).sort();
    expect(Object.keys(DEPENDENCY_DEGRADATION_MATRIX).sort()).toEqual(configured);
  });

  it("does not publish details from probe endpoints or errors", () => {
    const serviceWithPrivateDetails = {
      service: "ipfs",
      status: "down",
      endpoint: "https://private.example/token?secret=abc",
      lastError: "secret=abc",
    } as const;
    const healthyService = { service: "horizon", status: "healthy" } as const;
    const guidance = buildDependencyFallbacks([serviceWithPrivateDetails, healthyService]);

    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatchObject({ service: "ipfs", status: "down" });
    expect(JSON.stringify(guidance)).not.toContain("private.example");
    expect(JSON.stringify(guidance)).not.toContain("secret=abc");
  });

  it("gives users an actionable message without treating an outage as empty data", () => {
    const search = getDependencyFallbackGuidance("algolia", "degraded");
    expect(search?.userMessage).toContain("temporarily limited");
    expect(search?.fallback).toContain("zero matches");
    expect(search?.recovery).toContain("Retry");
    expect(getDependencyFallbackGuidance("unregistered", "down")).toBeNull();
    expect(getDependencyFallbackGuidance("algolia", "healthy")).toBeNull();
  });
});
