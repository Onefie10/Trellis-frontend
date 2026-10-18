import { buildPublicStatus, parsePublicStatusOverride } from "@/lib/public-status";

describe("public service status", () => {
  it("maps probe failures to a safe degraded status", () => {
    const status = buildPublicStatus(
      [
        { status: "healthy" },
        { status: "down" },
      ],
      { now: Date.parse("2026-10-17T10:00:00.000Z") },
    );

    expect(status).toEqual({
      status: "degraded",
      updatedAt: "2026-10-17T10:00:00.000Z",
      affectedServices: 1,
      message: "Some services are experiencing delays or interruptions.",
    });
  });

  it.each(["paused", "maintenance"] as const)("supports the operator override %s", (override) => {
    expect(buildPublicStatus([{ status: "healthy" }], { override }).status).toBe(override);
  });

  it("ignores unsupported override values and exposes no probe details", () => {
    const privateProbe = {
      status: "degraded" as const,
      endpoint: "https://private.example/token",
      lastError: "secret=abc",
    };
    const status = buildPublicStatus(
      [privateProbe],
      { override: "secret=abc" },
    );

    expect(parsePublicStatusOverride("secret=abc")).toBeUndefined();
    expect(status.status).toBe("degraded");
    expect(JSON.stringify(status)).not.toContain("private.example");
    expect(JSON.stringify(status)).not.toContain("secret=abc");
  });
});
