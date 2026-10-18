import { sandboxManager } from "../../../lib/sandbox";
import { MockStellarAdapter } from "../../../lib/sandbox-adapters";
import { buildMockWallet } from "../../../lib/sandbox-wallet";
import {
  DEFAULT_REPLAY_POLICY,
  ReplayExhaustedError,
  SandboxReplayError,
  ScenarioRecorder,
  TransactionReplayAdapter,
  assertTape,
  buildTapeFromScenarios,
  canonicalize,
  hashRequest,
  parseTape,
  scenarioRequest,
  summariseTape,
} from "../../../lib/sandbox-replay";

function edgeTape() {
  return buildTapeFromScenarios(["out_of_energy", "invalid_sequence", "tx_expired"], {
    name: "Edge case suite",
    now: 0,
  });
}

describe("Request canonicalisation", () => {
  it("sorts object keys so equivalent requests hash alike", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(hashRequest("submitTransaction", { a: 1, b: 2 })).toBe(
      hashRequest("submitTransaction", { b: 2, a: 1 }),
    );
  });

  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("handles values JSON alone cannot", () => {
    expect(canonicalize({ n: 10n })).toBe('{"n":"10n"}');
    expect(canonicalize({ f: undefined })).toBe('{"f":"[undefined]"}');
    expect(canonicalize({ f: () => 1 })).toBe('{"f":"[function]"}');
    expect(canonicalize({ m: Number.NaN })).toBe('{"m":"[NaN]"}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(canonicalize(circular)).toBe('{"self":"[circular]"}');
  });

  it("produces an 8-character hex hash that varies by method", () => {
    const key = hashRequest("submitTransaction", { a: 1 });
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(key).not.toBe(hashRequest("getTransactionStatus", { a: 1 }));
    expect(key).toBe(hashRequest("submitTransaction", { a: 1 }));
  });
});

describe("ScenarioRecorder", () => {
  it("does not record while stopped", () => {
    const recorder = new ScenarioRecorder({ name: "stopped", now: () => 5 });
    expect(recorder.isRecording).toBe(false);
    expect(recorder.record("getBalance", {}, { success: true, timestamp: 0 })).toBeUndefined();
    expect(recorder.size).toBe(0);
  });

  it("records interactions in order with sequential ids", () => {
    const recorder = new ScenarioRecorder({ name: "unit tape", now: () => 1000 }).start();
    expect(recorder.isRecording).toBe(true);

    const first = recorder.record("getBalance", { a: 1 }, { success: true, timestamp: 0 });
    const second = recorder.record("getBalance", { a: 2 }, { success: true, timestamp: 0 });

    expect(recorder.size).toBe(2);
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(first?.durationMs).toBe(0);
    expect(first?.requestKey).toBe(hashRequest("getBalance", { a: 1 }));
    expect(first?.recordedAt).toBe(1000);
    expect(first?.id.endsWith("-i1")).toBe(true);
  });

  it("records with force while stopped", () => {
    const recorder = new ScenarioRecorder({ name: "forced" });
    const interaction = recorder.record(
      "submitTransaction",
      {},
      { success: false, error: "nope", timestamp: 0 },
      { force: true, label: "forced" },
    );
    expect(interaction?.label).toBe("forced");
    expect(recorder.size).toBe(1);
  });

  it("times capture() and returns the executor result", async () => {
    let clock = 1000;
    const recorder = new ScenarioRecorder({ name: "capture", now: () => (clock += 5) }).start();

    const response = await recorder.capture("getBalance", { a: 1 }, async () => ({
      success: true,
      data: { balance: "1" },
      timestamp: 0,
    }));

    expect(response.success).toBe(true);
    expect(recorder.size).toBe(1);
    expect(recorder.getInteractions()[0].durationMs).toBe(5);
  });

  it("records a thrown error as a transport failure and rethrows", async () => {
    const recorder = new ScenarioRecorder({ name: "capture" }).start();
    let caught: Error | null = null;

    try {
      await recorder.capture("submitTransaction", {}, async () => {
        throw new Error("socket hang up");
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe("socket hang up");
    expect(recorder.size).toBe(1);
    const recorded = recorder.getInteractions()[0];
    expect(recorded.response.success).toBe(false);
    expect(recorded.response.code).toBe("TRANSPORT_ERROR");
    expect(recorded.response.error).toBe("socket hang up");
  });

  it("skips error recording when disabled", async () => {
    const recorder = new ScenarioRecorder({ name: "quiet", recordErrors: false }).start();
    try {
      await recorder.capture("submitTransaction", {}, async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(recorder.size).toBe(0);
  });

  it("filters by method and returns copies", () => {
    const recorder = ScenarioRecorder.fromTape(edgeTape());
    expect(recorder.size).toBe(6);
    expect(recorder.filter("submitTransaction").length).toBe(3);
    expect(recorder.filter("getTransactionStatus").length).toBe(3);

    const interactions = recorder.getInteractions();
    interactions[0].method = "getBalance";
    expect(recorder.getInteractions()[0].method).toBe("submitTransaction");
  });

  it("round-trips through toTape / load / toJSON", () => {
    const recorder = ScenarioRecorder.fromTape(edgeTape());
    const json = recorder.toJSON();
    const reloaded = new ScenarioRecorder({ name: "reloaded" }).load(json);
    expect(reloaded.size).toBe(6);
    expect(reloaded.getInteractions().map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    const fromObject = new ScenarioRecorder({ name: "object" }).load(edgeTape());
    expect(fromObject.size).toBe(6);
  });

  it("clears the tape", () => {
    const recorder = ScenarioRecorder.fromTape(edgeTape());
    recorder.clear();
    expect(recorder.size).toBe(0);
    expect(recorder.toTape().interactions.length).toBe(0);
  });
});

describe("Tape parsing", () => {
  it("parses a serialised tape", () => {
    const tape = edgeTape();
    const parsed = parseTape(JSON.stringify(tape));
    expect(parsed.interactions.length).toBe(6);
    expect(parsed.name).toBe("Edge case suite");
    expect(parsed.id).toBe(tape.id);
  });

  it("rejects malformed JSON and shapes", () => {
    try {
      parseTape("{not json");
      throw new Error("expected INVALID_TAPE_JSON");
    } catch (error) {
      expect(error instanceof SandboxReplayError).toBe(true);
      expect((error as SandboxReplayError).code).toBe("INVALID_TAPE_JSON");
    }

    try {
      assertTape({ name: "no interactions" });
      throw new Error("expected INVALID_TAPE");
    } catch (error) {
      expect((error as SandboxReplayError).code).toBe("INVALID_TAPE");
    }

    try {
      assertTape({
        name: "bad method",
        interactions: [{ method: "teleport", response: { success: true, timestamp: 0 } }],
      });
      throw new Error("expected INVALID_TAPE_METHOD");
    } catch (error) {
      expect((error as SandboxReplayError).code).toBe("INVALID_TAPE_METHOD");
    }

    try {
      assertTape({ name: "no response", interactions: [{ method: "getBalance" }] });
      throw new Error("expected INVALID_TAPE");
    } catch (error) {
      expect((error as SandboxReplayError).code).toBe("INVALID_TAPE");
    }
  });

  it("summarises a tape", () => {
    const summary = summariseTape(edgeTape());
    expect(summary).toContain("Edge case suite");
    expect(summary).toContain("6 interaction(s)");
    expect(summary).toContain("3× submitTransaction");
    expect(summary).toContain("3× getTransactionStatus");
  });

  it("exposes a default policy", () => {
    expect(DEFAULT_REPLAY_POLICY.strategy).toBe("first-match");
    expect(DEFAULT_REPLAY_POLICY.matchRequest).toBe(true);
    expect(DEFAULT_REPLAY_POLICY.onExhausted).toBe("error");
  });
});

describe("TransactionReplayAdapter", () => {
  it("replays a recorded response for a matching request", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    const request = scenarioRequest("out_of_energy", 0);
    const response = await adapter.replay<{ status: string }>("submitTransaction", request);

    expect(response.success).toBe(false);
    expect(response.code).toBe("txFAILED");
    expect(response.httpStatus).toBe(200);
    expect(response.retriable).toBe(false);
    expect(response.resultXdr).toBeDefined();
    expect(response.diagnosticEvents?.length).toBe(4);
    expect(response.data?.status).toBe("FAILED");
    expect(adapter.position).toBe(1);
    expect(adapter.history().length).toBe(1);
  });

  it("walks both the submission and the confirmation", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    const submit = await adapter.replay<{ hash: string; status: string }>(
      "submitTransaction",
      scenarioRequest("out_of_energy", 0),
    );
    const confirmation = await adapter.replay<{ status: string }>("getTransactionStatus", {
      hash: submit.data?.hash,
    });

    expect(confirmation.success).toBe(false);
    expect(confirmation.data?.status).toBe("failed");
    expect(adapter.position).toBe(2);
  });

  it("throws ReplayExhaustedError once every candidate is consumed", async () => {
    const tape = edgeTape();
    const adapter = new TransactionReplayAdapter(tape);
    const request = scenarioRequest("out_of_energy", 0);

    await adapter.replay("submitTransaction", request);

    let caught: unknown = null;
    try {
      await adapter.replay("submitTransaction", request);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof ReplayExhaustedError).toBe(true);
    const exhausted = caught as ReplayExhaustedError;
    expect(exhausted.code).toBe("REPLAY_EXHAUSTED");
    expect(exhausted.method).toBe("submitTransaction");
    expect(exhausted.tapeId).toBe(tape.id);
    expect(exhausted.tapeSize).toBe(6);
    expect(exhausted.requestKey).toBe(hashRequest("submitTransaction", request));
  });

  it("throws when nothing matches the method at all", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    let caught: unknown = null;
    try {
      await adapter.replay("getBalance", {});
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ReplayExhaustedError).toBe(true);
  });

  it("reuses the last match when onExhausted is 'last'", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape(), { onExhausted: "last" });
    await adapter.replay("submitTransaction", scenarioRequest("out_of_energy", 0));
    await adapter.replay("submitTransaction", scenarioRequest("invalid_sequence", 1));
    await adapter.replay("submitTransaction", scenarioRequest("tx_expired", 2));

    const reused = await adapter.replay("submitTransaction", scenarioRequest("tx_expired", 2));
    expect(reused.code).toBe("txTOO_LATE");
    expect(adapter.position).toBe(3);
  });

  it("follows recorded order under the 'sequence' strategy", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape(), { strategy: "sequence", matchRequest: false });
    const submit = await adapter.replay("submitTransaction", {});
    expect(submit.code).toBe("txFAILED");

    const confirmation = await adapter.replay("getTransactionStatus", {});
    expect(confirmation.code).toBe("txFAILED");
    expect(adapter.position).toBe(2);
  });

  it("cycles matches under 'round-robin'", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape(), {
      strategy: "round-robin",
      matchRequest: false,
    });
    const codes: Array<string | undefined> = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await adapter.replay("submitTransaction", {});
      codes.push(response.code);
    }
    expect(codes).toEqual(["txFAILED", "txBAD_SEQ", "txTOO_LATE", "txFAILED"]);
  });

  it("always returns the last match under 'last-match'", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape(), {
      strategy: "last-match",
      matchRequest: false,
    });
    expect((await adapter.replay("submitTransaction", {})).code).toBe("txTOO_LATE");
    expect((await adapter.replay("submitTransaction", {})).code).toBe("txTOO_LATE");
    expect(adapter.position).toBe(0);
  });

  it("matches on method alone when request matching is off", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape(), { matchRequest: false });
    const response = await adapter.replay("submitTransaction", { completely: "different" });
    expect(response.code).toBe("txFAILED");
    expect(adapter.candidates("submitTransaction", {}).length).toBe(3);
  });

  it("counts remaining candidates", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    expect(adapter.remaining("submitTransaction")).toBe(3);
    await adapter.replay("submitTransaction", scenarioRequest("out_of_energy", 0));
    expect(adapter.remaining("submitTransaction")).toBe(2);
    expect(adapter.remaining("getBalance")).toBe(0);
  });

  it("replays synchronously without latency", () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    const response = adapter.replaySync<{ status: string }>(
      "submitTransaction",
      scenarioRequest("out_of_energy", 0),
    );
    expect(response.code).toBe("txFAILED");
    expect(adapter.position).toBe(1);
  });

  it("resets position, history and consumption", async () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    const request = scenarioRequest("out_of_energy", 0);
    await adapter.replay("submitTransaction", request);

    adapter.reset();
    expect(adapter.position).toBe(0);
    expect(adapter.history().length).toBe(0);
    expect(adapter.remaining("submitTransaction")).toBe(3);
    expect((await adapter.replay("submitTransaction", request)).code).toBe("txFAILED");
  });

  it("honours simulated latency and skips it when zero", async () => {
    const slow = new TransactionReplayAdapter(edgeTape(), {
      strategy: "last-match",
      matchRequest: false,
      latencyMs: 20,
      jitterMs: 0,
    });
    const slowStart = Date.now();
    await slow.replay("submitTransaction", {});
    expect(Date.now() - slowStart).toBeGreaterThanOrEqual(15);

    const fast = new TransactionReplayAdapter(edgeTape(), {
      strategy: "last-match",
      matchRequest: false,
      latencyMs: 0,
      jitterMs: 0,
    });
    const fastStart = Date.now();
    await fast.replay("submitTransaction", {});
    expect(Date.now() - fastStart).toBeLessThan(15);
  });

  it("applies deterministic jitter from the seed", async () => {
    const build = () =>
      new TransactionReplayAdapter(edgeTape(), {
        strategy: "last-match",
        matchRequest: false,
        latencyMs: 0,
        jitterMs: 3,
        seed: 42,
      });
    const first = build();
    const second = build();
    expect(first.getPolicy().jitterMs).toBe(3);
    await first.replay("submitTransaction", {});
    await second.replay("submitTransaction", {});
    expect(first.replayCount).toBe(second.replayCount);
  });

  it("clones responses so callers cannot poison the tape", async () => {
    const tape = buildTapeFromScenarios(["success"], { now: 0 });
    const adapter = new TransactionReplayAdapter(tape, {
      strategy: "last-match",
      matchRequest: false,
    });

    const first = await adapter.replay<{ status: string }>("submitTransaction", {});
    first.data!.status = "MUTATED";

    const second = await adapter.replay<{ status: string }>("submitTransaction", {});
    expect(second.data?.status).toBe("SUCCESS");
    expect((tape.interactions[0].response.data as { status: string }).status).toBe("SUCCESS");
  });

  it("exposes and updates the policy", () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    expect(adapter.getPolicy().strategy).toBe("first-match");
    adapter.setPolicy({ strategy: "round-robin", latencyMs: 4 });
    expect(adapter.getPolicy().strategy).toBe("round-robin");
    expect(adapter.getPolicy().latencyMs).toBe(4);
    expect(adapter.getPolicy().matchRequest).toBe(true);
    expect(adapter.getTape().interactions.length).toBe(6);
  });

  it("accepts a plain tape object and re-validates it", () => {
    const adapter = new TransactionReplayAdapter(edgeTape());
    expect(adapter.tapeSize).toBe(6);
    expect(adapter.getTape().name).toBe("Edge case suite");
  });
});

describe("Tape verification", () => {
  it("flags an empty tape as broken", () => {
    const tape = buildTapeFromScenarios(["success"], { now: 0 });
    tape.interactions = [];
    const result = new TransactionReplayAdapter(tape).verify();
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]).toContain("Tape is empty");
  });

  it("flags a success response that claims a failing scenario", () => {
    const tape = buildTapeFromScenarios(["success"], { now: 0 });
    tape.interactions[0].response.scenarioId = "tx_expired";
    const result = new TransactionReplayAdapter(tape).verify();
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("tx_expired");
    expect(result.issues[0]).toContain("success");
  });

  it("warns about failures without a message", () => {
    const tape = buildTapeFromScenarios(["success"], { hashLookup: false, now: 0 });
    tape.interactions.push({
      id: "manual",
      seq: 2,
      method: "submitTransaction",
      request: { a: 1 },
      requestKey: hashRequest("submitTransaction", { a: 1 }),
      response: { success: false, timestamp: 0 },
      recordedAt: 0,
      durationMs: 0,
    });
    const result = new TransactionReplayAdapter(tape).verify();
    expect(result.warnings.some((w) => w.includes("no error message"))).toBe(true);
  });

  it("warns when several interactions share a request key", () => {
    const tape = buildTapeFromScenarios(["success"], { hashLookup: false, now: 0 });
    const duplicate = { ...tape.interactions[0], id: "duplicate", seq: 2 };
    tape.interactions.push(duplicate);
    const result = new TransactionReplayAdapter(tape).verify();
    expect(result.warnings.some((w) => w.includes("share method+request"))).toBe(true);
  });

  it("passes for a well-formed preset tape", () => {
    const result = new TransactionReplayAdapter(edgeTape()).verify();
    expect(result.ok).toBe(true);
    expect(result.issues.length).toBe(0);
    expect(result.warnings.length).toBe(0);
  });
});

describe("Replay adapter integration with the mock adapters", () => {
  beforeEach(() => {
    sandboxManager.reset();
  });

  it("drives MockStellarAdapter from a loaded tape", async () => {
    const tape = buildTapeFromScenarios(["out_of_energy"], { hashLookup: false, now: 0 });
    sandboxManager.setReplayAdapter(new TransactionReplayAdapter(tape));

    const request = scenarioRequest("out_of_energy", 0);
    const response = await MockStellarAdapter.submitTransaction(request);

    expect(response.success).toBe(false);
    expect(response.code).toBe("txFAILED");
    expect(response.diagnosticEvents?.length).toBe(4);
    expect(sandboxManager.getSnapshot().replay?.size).toBe(1);
    expect(sandboxManager.getSnapshot().replay?.position).toBe(1);
  });

  it("returns the default success response once the tape is removed", async () => {
    const tape = buildTapeFromScenarios(["out_of_energy"], { hashLookup: false, now: 0 });
    sandboxManager.setReplayAdapter(new TransactionReplayAdapter(tape));
    sandboxManager.setReplayAdapter(null);

    const response = await MockStellarAdapter.submitTransaction({ envelope: {} });
    expect(response.success).toBe(true);
    expect(response.data?.hash).toBeDefined();
  });

  it("prefers an active preset over a loaded tape", async () => {
    const tape = buildTapeFromScenarios(["success"], { hashLookup: false, now: 0 });
    sandboxManager.setReplayAdapter(new TransactionReplayAdapter(tape));
    sandboxManager.setActiveScenario("invalid_sequence");

    const response = await MockStellarAdapter.submitTransaction({ envelope: {} });
    expect(response.success).toBe(false);
    expect(response.code).toBe("txBAD_SEQ");
  });

  it("keeps the tape adapter independent of the injected wallet", async () => {
    sandboxManager.setReplayAdapter(new TransactionReplayAdapter(edgeTape()));
    sandboxManager.setWalletState(
      buildMockWallet({ balances: [{ asset: "native", balance: "1" }], now: 0 }),
    );

    const balance = await MockStellarAdapter.getBalance(
      "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
    );
    expect(balance.data?.balance).toBe("1.0000000");

    const submitted = await MockStellarAdapter.submitTransaction(
      scenarioRequest("out_of_energy", 0),
    );
    expect(submitted.success).toBe(false);
    expect(submitted.code).toBe("txFAILED");
  });
});
