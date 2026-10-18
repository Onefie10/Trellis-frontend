import {
  sandboxManager,
} from "../../../lib/sandbox";
import { MockStellarAdapter } from "../../../lib/sandbox-adapters";
import {
  SCENARIO_PRESETS,
  SandboxScenarioError,
  describeScenario,
  findScenario,
  getScenario,
  isRetriableScenario,
  listScenarios,
  nonRetriableScenarios,
  scenarioCategories,
  scenarioDiagnostics,
  scenarioResultXdr,
} from "../../../lib/sandbox-scenarios";
import {
  buildTapeFromPreset,
  buildTapeFromScenarios,
  scenarioRequest,
  scenarioToResponse,
} from "../../../lib/sandbox-replay";
import {
  ALL_FIXTURE_IDS,
  SCENARIO_FIXTURES,
  SCENARIO_FIXTURE_IDS,
  TRANSACTION_FIXTURE_IDS,
  WALLET_FIXTURE_IDS,
  getFixture,
  listFixtures,
  listScenarioFixtures,
  listWalletFixtures,
} from "../../../lib/sandbox-fixtures";

describe("Sandbox scenario presets", () => {
  it("keeps scenario ids unique", () => {
    const ids = SCENARIO_PRESETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the edge cases named in the issue", () => {
    const ids = SCENARIO_PRESETS.map((s) => s.id);
    expect(ids).toContain("out_of_energy");
    expect(ids).toContain("invalid_sequence");
    expect(ids).toContain("tx_expired");
  });

  it("describes Out of Energy with the budget diagnostic", () => {
    const scenario = getScenario("out_of_energy");
    expect(scenario.transactionCode).toBe("txFAILED");
    expect(scenario.operationCode).toContain("SOROBAN_FAILED");
    expect(scenario.soroban?.type).toBe("budget");
    expect(scenario.soroban?.code).toBe("ExceededLimit");
    expect(scenario.soroban?.message).toBe("HostError: Error(Budget, ExceededLimit)");
    expect(scenario.category).toBe("resource");
    expect(scenario.retriable).toBe(false);
    expect(scenario.diagnosticEvents.length).toBeGreaterThan(0);
  });

  it("describes Invalid Sequence and Tx Expired as retriable", () => {
    const sequence = getScenario("invalid_sequence");
    expect(sequence.transactionCode).toBe("txBAD_SEQ");
    expect(sequence.retriable).toBe(true);
    expect(sequence.httpStatus).toBe(200);

    const expired = getScenario("tx_expired");
    expect(expired.transactionCode).toBe("txTOO_LATE");
    expect(expired.retriable).toBe(true);
    expect(expired.category).toBe("ledger");
  });

  it("uses the expected HTTP statuses for transport failures", () => {
    expect(getScenario("rate_limited").httpStatus).toBe(429);
    expect(getScenario("rate_limited").retryAfterSeconds).toBe(5);
    expect(getScenario("timeout").httpStatus).toBe(504);
  });

  it("throws a typed error for an unknown scenario", () => {
    try {
      getScenario("nope");
      throw new Error("expected SandboxScenarioError");
    } catch (error) {
      expect(error instanceof SandboxScenarioError).toBe(true);
      expect((error as SandboxScenarioError).code).toBe("UNKNOWN_SCENARIO");
      expect((error as SandboxScenarioError).scenarioId).toBe("nope");
    }
    expect(findScenario("nope")).toBeUndefined();
  });

  it("filters scenarios by category", () => {
    expect(listScenarios().length).toBe(SCENARIO_PRESETS.length);
    const network = listScenarios("network").map((s) => s.id);
    expect(network).toContain("rate_limited");
    expect(network).toContain("timeout");
    expect(network.length).toBe(2);
    expect(scenarioCategories()).toContain("resource");
    expect(scenarioCategories()).toContain("network");
  });

  it("reports retriability helpers", () => {
    expect(isRetriableScenario("out_of_energy")).toBe(false);
    expect(isRetriableScenario("invalid_sequence")).toBe(true);
    expect(isRetriableScenario("nope")).toBe(false);
    expect(nonRetriableScenarios().length).toBe(
      SCENARIO_PRESETS.filter((s) => !s.retriable).length,
    );
  });

  it("produces a deterministic, clearly-mock result envelope", () => {
    const xdr = scenarioResultXdr("out_of_energy");
    expect(xdr).toBe(scenarioResultXdr("out_of_energy"));
    expect(xdr).not.toBe(scenarioResultXdr("invalid_sequence"));
    const decoded = atob(xdr);
    expect(decoded.startsWith("MOCK-XDR:")).toBe(true);
    expect(decoded).toContain("out_of_energy");
    expect(decoded).toContain("txFAILED");
  });

  it("returns copied diagnostics so callers cannot corrupt the preset", () => {
    const first = scenarioDiagnostics("out_of_energy");
    first.push("injected");
    expect(scenarioDiagnostics("out_of_energy")).not.toContain("injected");
  });

  it("summarises a scenario for logs", () => {
    const summary = describeScenario(getScenario("out_of_energy"));
    expect(summary).toContain("Out of Energy");
    expect(summary).toContain("txFAILED");
    expect(summary).toContain("HostError: Error(Budget, ExceededLimit)");
    expect(describeScenario(getScenario("timeout"))).toContain("HTTP 504");
  });
});

describe("Scenario responses and tapes", () => {
  it("maps a success scenario onto a success response", () => {
    const response = scenarioToResponse("success");
    expect(response.success).toBe(true);
    expect(response.code).toBe("txSUCCESS");
    expect(response.retriable).toBe(false);
    expect(response.error).toBeUndefined();
    expect(response.resultXdr).toBeDefined();
    expect((response.data as { status: string }).status).toBe("SUCCESS");
  });

  it("maps a failure scenario onto a failure response", () => {
    const response = scenarioToResponse("out_of_energy");
    expect(response.success).toBe(false);
    expect(response.code).toBe("txFAILED");
    expect(response.httpStatus).toBe(200);
    expect(response.retriable).toBe(false);
    expect(response.error).toBe("HostError: Error(Budget, ExceededLimit)");
    expect(response.diagnosticEvents?.length).toBe(4);
    expect(response.scenarioId).toBe("out_of_energy");
  });

  it("throws for an unknown scenario id", () => {
    try {
      scenarioToResponse("nope");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      expect((error as { code?: string }).code).toBe("UNKNOWN_SCENARIO");
    }
  });

  it("builds distinct, deterministic request envelopes", () => {
    const first = scenarioRequest("out_of_energy", 0);
    const second = scenarioRequest("out_of_energy", 1);
    expect(first).toEqual(scenarioRequest("out_of_energy", 0));
    expect((first.envelope as { sequenceNumber: string }).sequenceNumber).toBe("1000");
    expect((second.envelope as { sequenceNumber: string }).sequenceNumber).toBe("1001");
    expect((first.envelope as { operation: string }).operation).toBe("invokeHostFunction");
  });

  it("builds a tape with a submission and a confirmation per scenario", () => {
    const tape = buildTapeFromScenarios(["out_of_energy", "invalid_sequence", "tx_expired"], {
      name: "Edge case suite",
      now: 0,
    });
    expect(tape.interactions.length).toBe(6);
    expect(tape.createdAt).toBe(0);
    expect(tape.metadata.scenarioIds).toEqual(["out_of_energy", "invalid_sequence", "tx_expired"]);
    expect(tape.interactions.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tape.interactions[0].method).toBe("submitTransaction");
    expect(tape.interactions[1].method).toBe("getTransactionStatus");
    expect(tape.interactions[0].response.code).toBe("txFAILED");
    expect(tape.interactions[2].response.code).toBe("txBAD_SEQ");
    expect(tape.interactions[4].response.code).toBe("txTOO_LATE");
    expect((tape.interactions[1].response.data as { status: string }).status).toBe("failed");
    expect(tape.interactions.every((i) => i.requestKey.length === 8)).toBe(true);
  });

  it("can skip the confirmation lookup", () => {
    const tape = buildTapeFromScenarios(["success"], { name: "submit only", hashLookup: false, now: 0 });
    expect(tape.interactions.length).toBe(1);
    expect(tape.interactions[0].method).toBe("submitTransaction");
  });

  it("rejects an empty scenario list", () => {
    try {
      buildTapeFromScenarios([], { now: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("EMPTY_SCENARIO_LIST");
    }
  });

  it("builds tapes from the named presets", () => {
    const edge = buildTapeFromPreset("edge-cases", 0);
    expect(edge.interactions.length).toBe(6);
    expect(edge.metadata.presetId).toBe("edge-cases");

    const happy = buildTapeFromPreset("happy-path", 0);
    expect(happy.interactions.length).toBe(2);
    expect(happy.interactions[0].response.success).toBe(true);

    const network = buildTapeFromPreset("network-failures", 0);
    expect(network.interactions[0].response.httpStatus).toBe(429);

    try {
      buildTapeFromPreset("nope");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UNKNOWN_TAPE_PRESET");
    }
  });
});

describe("Sandbox fixtures cover the new failure cases", () => {
  it("registers the new wallet fixtures", () => {
    expect(WALLET_FIXTURE_IDS).toContain("wallet-low-balance");
    expect(WALLET_FIXTURE_IDS).toContain("wallet-no-trustlines");
    expect(WALLET_FIXTURE_IDS).toContain("wallet-unauthorised-asset");
    expect(WALLET_FIXTURE_IDS).toContain("wallet-empty");
    expect(listWalletFixtures().length).toBe(WALLET_FIXTURE_IDS.length);
  });

  it("registers the new transaction fixtures", () => {
    expect(TRANSACTION_FIXTURE_IDS).toContain("txn-out-of-energy");
    expect(TRANSACTION_FIXTURE_IDS).toContain("txn-invalid-sequence");
    expect(TRANSACTION_FIXTURE_IDS).toContain("txn-expired");
    expect(getFixture("txn-out-of-energy")?.data.transactionCode).toBe("txFAILED");
    expect(getFixture("txn-invalid-sequence")?.data.scenarioId).toBe("invalid_sequence");
    expect(getFixture("txn-expired")?.data.scenarioId).toBe("tx_expired");
  });

  it("mirrors every scenario as a fixture", () => {
    expect(listScenarioFixtures().length).toBe(SCENARIO_PRESETS.length);
    expect(Object.keys(SCENARIO_FIXTURES).length).toBe(SCENARIO_PRESETS.length);
    for (const scenario of SCENARIO_PRESETS) {
      expect(SCENARIO_FIXTURES[scenario.id].id).toBe(`scenario-${scenario.id}`);
      expect(SCENARIO_FIXTURES[scenario.id].data.scenarioId).toBe(scenario.id);
    }
    expect(getFixture("scenario-out_of_energy")?.name).toBe("Out of Energy");
  });

  it("keeps the pre-existing fixtures resolvable", () => {
    expect(getFixture("wallet-success")?.data.publicKey).toBeDefined();
    expect(getFixture("wallet-not-found")?.data.code).toBe(404);
    expect(getFixture("txn-success")?.data.hash).toBeDefined();
    expect(getFixture("txn-insufficient")?.data.error).toBeDefined();
    expect(getFixture("txn-timeout")?.data.error).toBeDefined();
    expect(getFixture("verify-success")?.data.verified).toBe(true);
    expect(getFixture("verify-declined")?.data.verified).toBe(false);
    expect(getFixture("nope")).toBeUndefined();
  });

  it("keeps every fixture reachable through the id registry", () => {
    const expected =
      WALLET_FIXTURE_IDS.length +
      TRANSACTION_FIXTURE_IDS.length +
      SCENARIO_FIXTURE_IDS.length +
      2; // verification fixtures
    expect(listFixtures().length).toBe(expected);
    expect(ALL_FIXTURE_IDS.length).toBe(expected);
    for (const id of ALL_FIXTURE_IDS) {
      expect(getFixture(id)?.id).toBe(id);
    }
  });
});

describe("Active preset wiring", () => {
  beforeEach(() => {
    sandboxManager.reset();
  });

  it("fails transactions while a preset is active", async () => {
    sandboxManager.setActiveScenario("out_of_energy");
    expect(sandboxManager.getActiveScenarioId()).toBe("out_of_energy");

    const response = await MockStellarAdapter.submitTransaction({ envelope: {} });
    expect(response.success).toBe(false);
    expect(response.code).toBe("txFAILED");
    expect(response.httpStatus).toBe(200);
    expect(response.retriable).toBe(false);
    expect(response.diagnosticEvents?.length).toBe(4);
  });

  it("returns a retriable failure for Invalid Sequence", async () => {
    sandboxManager.setActiveScenario("invalid_sequence");
    const response = await MockStellarAdapter.submitTransaction({ envelope: {} });
    expect(response.success).toBe(false);
    expect(response.code).toBe("txBAD_SEQ");
    expect(response.retriable).toBe(true);
  });

  it("only affects transaction calls, not balance reads", async () => {
    sandboxManager.setActiveScenario("tx_expired");
    const balance = await MockStellarAdapter.getBalance(
      "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
    );
    expect(balance.success).toBe(true);
    expect(balance.data?.balance).toBe("1000.0000000");
  });

  it("leaves transport scenarios without a result envelope", async () => {
    sandboxManager.setActiveScenario("timeout");
    const response = await MockStellarAdapter.submitTransaction({ envelope: {} });
    expect(response.success).toBe(false);
    expect(response.httpStatus).toBe(504);
    expect(response.resultXdr).toBeUndefined();
    expect(response.data).toBeUndefined();
  });

  it("returns to success once the preset is cleared", async () => {
    sandboxManager.setActiveScenario("out_of_energy");
    sandboxManager.clearActiveScenario();
    const response = await MockStellarAdapter.submitTransaction({ envelope: {} });
    expect(response.success).toBe(true);
    expect(response.data?.hash).toBeDefined();
  });
});
