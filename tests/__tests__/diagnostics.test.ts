import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  checkTooling,
  checkConfiguration,
  checkDependencies,
  checkConnectivity,
  checkDatabaseAndFixtures,
  checkSystemRequirements,
  checkLocalPorts,
  validateEnvRules,
  parseEnvFileContent,
  getCommonFailureFixes,
  applyAutoFixes,
  runDiagnostics,
} from "../../scripts/diagnostics.mjs";

describe("Contributor Diagnostics", () => {
  describe("checkTooling", () => {
    it("reports Node.js runtime and git repository status", () => {
      const results = checkTooling();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);

      const nodeCheck = results.find((r: { name: string }) => r.name === "Node.js Runtime");
      expect(nodeCheck).toBeDefined();
      expect(["pass", "fail"]).toContain(nodeCheck?.status);
    });

    it("flags unsupported Node.js versions (< 20)", () => {
      const results = checkTooling({ nodeVersion: "v18.19.0" });
      const nodeCheck = results.find((r: { name: string }) => r.name === "Node.js Runtime");
      expect(nodeCheck?.status).toBe("fail");
      expect(nodeCheck?.remediation).toContain("Upgrade Node.js");
    });
  });

  describe("checkConfiguration & validateEnvRules", () => {
    it("validates repository environment template and local config", () => {
      const results = checkConfiguration();
      expect(Array.isArray(results)).toBe(true);

      const envExampleCheck = results.find((r: { name: string }) => r.name === ".env.example Template");
      expect(envExampleCheck).toBeDefined();
      expect(["pass", "fail"]).toContain(envExampleCheck?.status);
    });

    it("enforces strict AppConfig security rules without leaking secret values", () => {
      const invalidProdConfig = validateEnvRules({
        NEXT_PUBLIC_ENVIRONMENT: "production",
        NEXT_PUBLIC_API_URL: "http://localhost:3001",
        NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
        WEBHOOK_SECRET: "placeholder-secret",
      });

      expect(invalidProdConfig.isValid).toBe(false);
      expect(invalidProdConfig.problems).toContain("NEXT_PUBLIC_API_URL must use HTTPS in production.");
      expect(invalidProdConfig.problems).toContain("NEXT_PUBLIC_API_URL cannot point to localhost outside development.");
      expect(invalidProdConfig.problems).toContain("NEXT_PUBLIC_STELLAR_NETWORK must be mainnet outside development.");
      expect(invalidProdConfig.problems).toContain(
        "WEBHOOK_SECRET must be a non-placeholder secret of at least 32 characters."
      );
      expect(JSON.stringify(invalidProdConfig)).not.toContain("placeholder-secret");
    });

    it("passes valid development configuration", () => {
      const validDev = validateEnvRules({
        NEXT_PUBLIC_ENVIRONMENT: "development",
        NEXT_PUBLIC_API_URL: "http://localhost:3001",
        NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
        NEXT_PUBLIC_ENABLE_BETA_FEATURES: "false",
      });
      expect(validDev.isValid).toBe(true);
      expect(validDev.problems).toHaveLength(0);
    });

    it("parses .env content accurately", () => {
      const parsed = parseEnvFileContent(`
        # Comment line
        NEXT_PUBLIC_API_URL="http://localhost:3001"
        NEXT_PUBLIC_ENVIRONMENT=development
      `);
      expect(parsed.NEXT_PUBLIC_API_URL).toBe("http://localhost:3001");
      expect(parsed.NEXT_PUBLIC_ENVIRONMENT).toBe("development");
    });
  });

  describe("checkDependencies", () => {
    it("verifies package.json and project setup", () => {
      const results = checkDependencies();
      expect(Array.isArray(results)).toBe(true);

      const pkgCheck = results.find((r: { name: string }) => r.name === "package.json Configuration");
      expect(pkgCheck).toBeDefined();
      expect(pkgCheck?.status).toBe("pass");
    });
  });

  describe("checkConnectivity", () => {
    it("respects skipNetwork parameter", async () => {
      const results = await checkConnectivity(true);
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Network Services");
      expect(results[0].status).toBe("pass");
      expect(results[0].message).toContain("Skipped");
    });

    it("validates Horizon, Soroban RPC, and IPFS endpoints with custom probe", async () => {
      const results = await checkConnectivity(false, {
        probeFn: async () => ({ ok: true, status: 200 }),
      });
      expect(results.length).toBe(3);
      expect(results.every((r: { status: string }) => r.status === "pass")).toBe(true);
    });

    it("reports actionable warnings when external RPC services are unreachable", async () => {
      const results = await checkConnectivity(false, {
        probeFn: async () => ({ ok: false, error: "Connection timed out" }),
      });
      expect(results.length).toBe(3);
      expect(results.every((r: { status: string }) => r.status === "warn")).toBe(true);
      expect(results[0].remediation).toBeDefined();
    });
  });

  describe("checkDatabaseAndFixtures", () => {
    it("performs non-mutating checks on seed data invariants, mock database, and test files", async () => {
      const results = await checkDatabaseAndFixtures();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(3);

      const seedCheck = results.find(
        (r: { name: string }) => r.name === "Seed Data & Baseline Invariants"
      );
      expect(seedCheck).toBeDefined();
      expect(seedCheck?.status).toBe("pass");

      const invariantFixturesCheck = results.find(
        (r: { name: string }) => r.name === "Domain Invariant Test Fixtures"
      );
      expect(invariantFixturesCheck).toBeDefined();
      expect(invariantFixturesCheck?.status).toBe("pass");

      const testsCheck = results.find((r: { name: string }) => r.name === "Test Suites Directory");
      expect(testsCheck).toBeDefined();
      expect(testsCheck?.status).toBe("pass");
    });
  });

  describe("checkSystemRequirements", () => {
    it("reports system memory and disk space", () => {
      const results = checkSystemRequirements();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(2);

      const memCheck = results.find((r: { name: string }) => r.name === "System Memory");
      expect(memCheck).toBeDefined();
      expect(["pass", "warn"]).toContain(memCheck?.status);
    });
  });

  describe("checkLocalPorts", () => {
    it("checks availability of local dev ports", async () => {
      const results = await checkLocalPorts();
      expect(Array.isArray(results)).toBe(true);

      const port3000 = results.find((r: { name: string }) => r.name === "Local Port 3000");
      expect(port3000).toBeDefined();
      expect(["pass", "fail"]).toContain(port3000?.status);
    });
  });

  describe("Common Failure Fixes & Auto-Remediation", () => {
    it("returns a catalog of common failure fixes with rollback commands", () => {
      const fixes = getCommonFailureFixes();
      expect(fixes.length).toBeGreaterThanOrEqual(5);
      for (const fix of fixes) {
        expect(fix.code).toBeTruthy();
        expect(fix.symptom).toBeTruthy();
        expect(fix.fixCommand).toBeTruthy();
        expect(fix.rollbackCommand).toBeTruthy();
      }
    });

    it("automatically initializes .env.local from .env.example when --fix is enabled", () => {
      const tmpDir = mkdtempSync(join(os.tmpdir(), "trellis-diag-test-"));
      try {
        writeFileSync(
          join(tmpDir, ".env.example"),
          "NEXT_PUBLIC_API_URL=http://localhost:3001\nNEXT_PUBLIC_ENVIRONMENT=development\nNEXT_PUBLIC_STELLAR_NETWORK=testnet\n"
        );
        const applied = applyAutoFixes({ rootDir: tmpDir });
        expect(applied.length).toBe(1);
        expect(applied[0].code).toBe("ENV_MISSING_LOCAL");
        expect(existsSync(join(tmpDir, ".env.local"))).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("runDiagnostics", () => {
    it("aggregates all diagnostics categories and produces a comprehensive report", async () => {
      const report = await runDiagnostics({ skipNetwork: true });

      expect(report).toHaveProperty("timestamp");
      expect(report).toHaveProperty("isSuccess");
      expect(report).toHaveProperty("summary");
      expect(report).toHaveProperty("groups");
      expect(report).toHaveProperty("commonFailureFixes");
      expect(report).toHaveProperty("appliedFixes");

      expect(typeof report.summary.total).toBe("number");
      expect(typeof report.summary.passed).toBe("number");
      expect(typeof report.summary.warnings).toBe("number");
      expect(typeof report.summary.failures).toBe("number");

      expect(report.groups.length).toBe(7);
      const groupNames = report.groups.map((g: { name: string }) => g.name);
      expect(groupNames).toContain("Developer Tooling & Runtime");
      expect(groupNames).toContain("Configuration & Environment");
      expect(groupNames).toContain("Project Dependencies & Setup");
      expect(groupNames).toContain("Service Connectivity & Network");
      expect(groupNames).toContain("Database & Fixture Integrity");
      expect(groupNames).toContain("System Requirements");
      expect(groupNames).toContain("Local Ports");
    });
  });
});
