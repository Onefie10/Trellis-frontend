/**
 * Sandbox Transaction Scenario Recorder + Replay Adapter
 *
 * Lets a developer record the mock adapter's responses once (or load a preset
 * tape built from the scenario library) and then replay them deterministically —
 * so a UI flow can be exercised against "Out of Energy", "Invalid Sequence" and
 * "Tx Expired" without touching testnet, and without the ordering of a live RPC
 * leaking into a test.
 *
 * The module is dependency-free and pure apart from the optional latency
 * simulation, which is driven by a seeded PRNG rather than `Math.random()`.
 */

import { fnv1a32 } from "./sandbox-wallet";
import {
  findScenario,
  scenarioDiagnostics,
  scenarioResultXdr,
  type SandboxScenarioId,
} from "./sandbox-scenarios";

export type ReplayableMethod =
  | "getBalance"
  | "getBalances"
  | "simulateTransaction"
  | "submitTransaction"
  | "getTransactionStatus";

export const REPLAYABLE_METHODS: ReplayableMethod[] = [
  "getBalance",
  "getBalances",
  "simulateTransaction",
  "submitTransaction",
  "getTransactionStatus",
];

/**
 * Response envelope shared by every mock adapter.
 *
 * Structurally a superset of the `ServiceResponse` that `lib/sandbox-adapters`
 * has always returned, so existing callers keep type-checking unchanged.
 */
export interface SandboxResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
  /** Stellar / Soroban result code when this response represents a rejection. */
  code?: string;
  /** HTTP status the mock RPC reported. */
  httpStatus?: number;
  /** Whether a well-behaved client may retry the same request unchanged. */
  retriable?: boolean;
  /** Soroban diagnostic events captured while executing. */
  diagnosticEvents?: string[];
  /** Mock result envelope — see `scenarioResultXdr`. */
  resultXdr?: string;
  /** Scenario this response was generated from, when applicable. */
  scenarioId?: string;
}

export interface RecordedInteraction<TRequest = unknown, TData = unknown> {
  id: string;
  /** Position within the tape, assigned at record time. */
  seq: number;
  method: ReplayableMethod;
  request: TRequest;
  /** Stable hash of `method + canonical(request)` used for request matching. */
  requestKey: string;
  response: SandboxResponse<TData>;
  recordedAt: number;
  durationMs: number;
  label?: string;
  scenarioId?: string;
}

export interface ReplayTape {
  id: string;
  name: string;
  createdAt: number;
  interactions: RecordedInteraction[];
  metadata: Record<string, unknown>;
}

export class SandboxReplayError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SandboxReplayError";
    this.code = code;
  }
}

export class ReplayExhaustedError extends SandboxReplayError {
  readonly method: ReplayableMethod;
  readonly requestKey: string;
  readonly tapeId: string;
  readonly tapeSize: number;

  constructor(method: ReplayableMethod, requestKey: string, tape: ReplayTape) {
    super(
      `Replay tape "${tape.name}" (${tape.interactions.length} interaction(s)) has no unconsumed response for ${method} [${requestKey}]`,
      "REPLAY_EXHAUSTED",
    );
    this.name = "ReplayExhaustedError";
    this.method = method;
    this.requestKey = requestKey;
    this.tapeId = tape.id;
    this.tapeSize = tape.interactions.length;
  }
}

/* ------------------------------------------------------------------ *
 * Request canonicalisation
 * ------------------------------------------------------------------ */

/**
 * Stable JSON serialisation with sorted object keys.
 *
 * Without this, `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` would hash differently and
 * a recorded response would never match on replay.
 */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (input === null) return null;
    if (typeof input !== "object") {
      if (typeof input === "undefined") return "[undefined]";
      if (typeof input === "bigint") return `${input.toString()}n`;
      if (typeof input === "function") return "[function]";
      if (typeof input === "number" && !Number.isFinite(input)) return `[${String(input)}]`;
      return input;
    }
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(walk);

    const source = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) output[key] = walk(source[key]);
    return output;
  };

  try {
    return JSON.stringify(walk(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

export function hashRequest(method: ReplayableMethod, request: unknown): string {
  return fnv1a32(`${method}:${canonicalize(request)}`).toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ *
 * Recorder
 * ------------------------------------------------------------------ */

export interface ScenarioRecorderOptions {
  name?: string;
  /** Record thrown errors as failure responses instead of skipping them. */
  recordErrors?: boolean;
  /** Injectable clock — keeps tests deterministic. */
  now?: () => number;
}

export class ScenarioRecorder {
  readonly id: string;
  name: string;

  private interactions: RecordedInteraction[] = [];
  private recording = false;
  private sequence = 0;
  private recordErrors: boolean;
  private now: () => number;

  constructor(options: ScenarioRecorderOptions = {}) {
    this.name = options.name ?? "sandbox tape";
    this.id = `tape-${fnv1a32(this.name).toString(16)}`;
    this.recordErrors = options.recordErrors !== false;
    this.now = options.now ?? (() => Date.now());
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get size(): number {
    return this.interactions.length;
  }

  start(): this {
    this.recording = true;
    return this;
  }

  stop(): this {
    this.recording = false;
    return this;
  }

  clear(): this {
    this.interactions = [];
    this.sequence = 0;
    return this;
  }

  /** Records an already-known response. No-op unless recording (or `force`). */
  record<TData>(
    method: ReplayableMethod,
    request: unknown,
    response: SandboxResponse<TData>,
    options: { durationMs?: number; label?: string; scenarioId?: string; force?: boolean } = {},
  ): RecordedInteraction<unknown, TData> | undefined {
    if (!this.recording && options.force !== true) return undefined;

    this.sequence += 1;
    const interaction: RecordedInteraction<unknown, TData> = {
      id: `${this.id}-i${this.sequence}`,
      seq: this.sequence,
      method,
      request,
      requestKey: hashRequest(method, request),
      response,
      recordedAt: this.now(),
      durationMs: options.durationMs ?? 0,
      label: options.label,
      scenarioId: options.scenarioId,
    };

    this.interactions.push(interaction as RecordedInteraction);
    return interaction;
  }

  /**
   * Runs `executor`, times it, and records whatever came back.
   *
   * A rejected executor is recorded as a failure response and then re-thrown, so
   * callers see the real error while the tape still captures the outage.
   */
  async capture<TData>(
    method: ReplayableMethod,
    request: unknown,
    executor: () => Promise<SandboxResponse<TData>>,
    options: { label?: string; scenarioId?: string } = {},
  ): Promise<SandboxResponse<TData>> {
    const startedAt = this.now();
    try {
      const response = await executor();
      this.record(method, request, response, {
        durationMs: this.now() - startedAt,
        label: options.label,
        scenarioId: options.scenarioId,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.recordErrors) {
        this.record<TData>(
          method,
          request,
          { success: false, error: message, timestamp: this.now(), code: "TRANSPORT_ERROR" },
          {
            durationMs: this.now() - startedAt,
            label: options.label ?? "recorded failure",
            scenarioId: options.scenarioId,
          },
        );
      }
      throw error;
    }
  }

  getInteractions(): RecordedInteraction[] {
    return this.interactions.map((i) => ({ ...i }));
  }

  filter(method: ReplayableMethod): RecordedInteraction[] {
    return this.getInteractions().filter((i) => i.method === method);
  }

  toTape(metadata: Record<string, unknown> = {}): ReplayTape {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.now(),
      interactions: this.getInteractions(),
      metadata,
    };
  }

  toJSON(): string {
    return JSON.stringify(this.toTape(), null, 2);
  }

  /** Appends interactions from a tape or tape JSON. */
  load(input: string | ReplayTape): this {
    const tape = typeof input === "string" ? parseTape(input) : input;
    for (const interaction of tape.interactions) {
      this.sequence += 1;
      this.interactions.push({ ...interaction, seq: this.sequence } as RecordedInteraction);
    }
    return this;
  }

  static fromTape(tape: ReplayTape): ScenarioRecorder {
    const recorder = new ScenarioRecorder({ name: tape.name });
    recorder.load(tape);
    return recorder;
  }
}

export function parseTape(json: string): ReplayTape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SandboxReplayError(
      `Tape is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_TAPE_JSON",
    );
  }
  return assertTape(parsed);
}

export function assertTape(candidate: unknown): ReplayTape {
  if (!candidate || typeof candidate !== "object") {
    throw new SandboxReplayError("Tape must be an object", "INVALID_TAPE");
  }
  const tape = candidate as Partial<ReplayTape>;
  if (!Array.isArray(tape.interactions)) {
    throw new SandboxReplayError("Tape is missing an `interactions` array", "INVALID_TAPE");
  }
  for (const interaction of tape.interactions) {
    if (!interaction || typeof interaction !== "object") {
      throw new SandboxReplayError("Tape contains a non-object interaction", "INVALID_TAPE");
    }
    const record = interaction as Partial<RecordedInteraction>;
    if (!record.method || !REPLAYABLE_METHODS.includes(record.method as ReplayableMethod)) {
      throw new SandboxReplayError(
        `Tape contains an unsupported method "${String(record.method)}"`,
        "INVALID_TAPE_METHOD",
      );
    }
    if (!record.response || typeof record.response !== "object") {
      throw new SandboxReplayError("Tape interaction is missing a response", "INVALID_TAPE");
    }
  }

  return {
    id: tape.id ?? `tape-${fnv1a32(tape.name ?? "imported").toString(16)}`,
    name: tape.name ?? "imported tape",
    createdAt: tape.createdAt ?? Date.now(),
    interactions: (tape.interactions as RecordedInteraction[]).map((i) => ({ ...i })),
    metadata: tape.metadata ?? {},
  };
}

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

export type ReplayStrategy = "sequence" | "first-match" | "last-match" | "round-robin";

export interface ReplayPolicy {
  strategy: ReplayStrategy;
  /** Require the request (not just the method) to match a recorded interaction. */
  matchRequest: boolean;
  latencyMs: number;
  jitterMs: number;
  /** Behavior once every candidate has been consumed. */
  onExhausted: "error" | "last";
  seed: number;
}

export const DEFAULT_REPLAY_POLICY: ReplayPolicy = {
  strategy: "first-match",
  matchRequest: true,
  latencyMs: 0,
  jitterMs: 0,
  onExhausted: "error",
  seed: 1,
};

export interface TapeVerification {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

export class TransactionReplayAdapter {
  private tape: ReplayTape;
  private policy: ReplayPolicy;
  private consumed = new Set<string>();
  private cursor = 0;
  private replayedIds: string[] = [];
  private random: () => number;

  constructor(tape: ReplayTape, policy: Partial<ReplayPolicy> = {}) {
    this.tape = assertTape(tape);
    this.policy = { ...DEFAULT_REPLAY_POLICY, ...policy };
    this.random = seededJitter(this.policy.seed);
  }

  getTape(): ReplayTape {
    return this.tape;
  }

  getPolicy(): ReplayPolicy {
    return { ...this.policy };
  }

  setPolicy(patch: Partial<ReplayPolicy>): this {
    this.policy = { ...this.policy, ...patch };
    if (patch.seed !== undefined) this.random = seededJitter(this.policy.seed);
    return this;
  }

  /** Number of interactions consumed so far. */
  get position(): number {
    return this.consumed.size;
  }

  get tapeSize(): number {
    return this.tape.interactions.length;
  }

  get replayCount(): number {
    return this.replayedIds.length;
  }

  /** Ids in the order they were replayed — useful for asserting a UI sequence. */
  history(): string[] {
    return [...this.replayedIds];
  }

  candidates(method: ReplayableMethod, request?: unknown): RecordedInteraction[] {
    const requestKey = request === undefined ? null : hashRequest(method, request);
    return this.tape.interactions.filter((interaction) => {
      if (interaction.method !== method) return false;
      if (!this.policy.matchRequest || requestKey === null) return true;
      return interaction.requestKey === requestKey;
    });
  }

  /** Resets consumption, cursor and history — the tape itself is untouched. */
  reset(): this {
    this.consumed = new Set();
    this.cursor = 0;
    this.replayedIds = [];
    return this;
  }

  remaining(method: ReplayableMethod, request?: unknown): number {
    return this.candidates(method, request).filter((i) => !this.consumed.has(i.id)).length;
  }

  async replay<T = unknown>(
    method: ReplayableMethod,
    request: unknown,
  ): Promise<SandboxResponse<T>> {
    const interaction = this.pick(method, request);
    const delayMs = this.nextDelay();
    if (delayMs > 0) await sleep(delayMs);
    this.replayedIds.push(interaction.id);
    return cloneResponse<T>(interaction.response as SandboxResponse<T>);
  }

  /**
   * Synchronous variant.
   *
   * Latency simulation is intentionally skipped — a synchronous call cannot
   * wait, so `latencyMs` is ignored rather than silently truncating the replay.
   */
  replaySync<T = unknown>(method: ReplayableMethod, request: unknown): SandboxResponse<T> {
    const interaction = this.pick(method, request);
    this.replayedIds.push(interaction.id);
    return cloneResponse<T>(interaction.response as SandboxResponse<T>);
  }

  private pick(method: ReplayableMethod, request: unknown): RecordedInteraction {
    const matching = this.candidates(method, request);
    if (matching.length === 0) {
      throw new ReplayExhaustedError(method, hashRequest(method, request), this.tape);
    }

    switch (this.policy.strategy) {
      case "sequence": {
        // Strict recorded order: the next unconsumed entry must be a match.
        const next = this.tape.interactions.find((i) => !this.consumed.has(i.id));
        if (!next || !matching.some((m) => m.id === next.id)) {
          return this.onExhausted(method, request, matching);
        }
        this.consumed.add(next.id);
        return next;
      }

      case "round-robin": {
        const index = this.cursor % matching.length;
        this.cursor += 1;
        return matching[index];
      }

      case "last-match": {
        return matching[matching.length - 1];
      }

      case "first-match":
      default: {
        const next = matching.find((i) => !this.consumed.has(i.id));
        if (!next) return this.onExhausted(method, request, matching);
        this.consumed.add(next.id);
        return next;
      }
    }
  }

  private onExhausted(
    method: ReplayableMethod,
    request: unknown,
    matching: RecordedInteraction[],
  ): RecordedInteraction {
    if (this.policy.onExhausted === "last" && matching.length > 0) {
      return matching[matching.length - 1];
    }
    throw new ReplayExhaustedError(method, hashRequest(method, request), this.tape);
  }

  private nextDelay(): number {
    const base = Math.max(0, Math.floor(this.policy.latencyMs));
    const jitter = Math.max(0, Math.floor(this.policy.jitterMs));
    if (jitter === 0) return base;
    return base + Math.floor(this.random() * jitter);
  }

  /**
   * Static lint for a tape: catches the mistakes that make a replay silently
   * ambiguous rather than failing loudly.
   */
  verify(): TapeVerification {
    const issues: string[] = [];
    const warnings: string[] = [];

    if (this.tape.interactions.length === 0) {
      issues.push("Tape is empty — every replay will throw ReplayExhaustedError.");
    }

    const keys = new Map<string, number>();
    for (const interaction of this.tape.interactions) {
      const key = `${interaction.method}:${interaction.requestKey}`;
      keys.set(key, (keys.get(key) ?? 0) + 1);

      if (!interaction.response.success && !interaction.response.error) {
        warnings.push(
          `Interaction #${interaction.seq} (${interaction.method}) is a failure with no error message.`,
        );
      }
      if (interaction.response.success && interaction.response.scenarioId) {
        const scenarioId = interaction.response.scenarioId;
        const scenario = findScenario(scenarioId);
        if (scenario && scenario.status === "FAILED") {
          issues.push(
            `Interaction #${interaction.seq} replays scenario "${scenario.id}" but reports success.`,
          );
        }
      }
    }

    if (this.policy.matchRequest) {
      for (const [key, count] of keys) {
        if (count > 1) {
          warnings.push(
            `${count} interactions share method+request "${key}" — \`first-match\` will need them consumed in order.`,
          );
        }
      }
    }

    return { ok: issues.length === 0, issues, warnings };
  }
}

function seededJitter(seed: number): () => number {
  let state = (seed || 1) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deep-ish clone so a caller mutating a replayed response cannot poison the tape. */
function cloneResponse<T>(response: SandboxResponse<T>): SandboxResponse<T> {
  const clone: SandboxResponse<T> = { ...response };
  if (response.diagnosticEvents) clone.diagnosticEvents = [...response.diagnosticEvents];
  if (response.data !== undefined && response.data !== null && typeof response.data === "object") {
    clone.data = JSON.parse(JSON.stringify(response.data)) as T;
  }
  return clone;
}

/* ------------------------------------------------------------------ *
 * Tape construction from scenario presets
 * ------------------------------------------------------------------ */

export interface TapePreset {
  id: string;
  name: string;
  description: string;
  scenarioIds: SandboxScenarioId[];
}

export const TAPE_PRESETS: TapePreset[] = [
  {
    id: "edge-cases",
    name: "Edge case suite",
    description:
      "Out of Energy → Invalid Sequence → Tx Expired, in the order a developer usually hits them.",
    scenarioIds: ["out_of_energy", "invalid_sequence", "tx_expired"],
  },
  {
    id: "happy-path",
    name: "Happy path",
    description: "A single successful submission plus its confirmation lookup.",
    scenarioIds: ["success"],
  },
  {
    id: "network-failures",
    name: "Network failures",
    description: "Rate limiting and a submission timeout — the reconcile-before-retry flows.",
    scenarioIds: ["rate_limited", "timeout"],
  },
  {
    id: "balance-failures",
    name: "Balance failures",
    description: "Insufficient balance, missing trustline and an unauthorised asset.",
    scenarioIds: ["insufficient_balance", "missing_trustline", "unauthorised_asset"],
  },
];

export function getTapePreset(id: string): TapePreset | undefined {
  return TAPE_PRESETS.find((p) => p.id === id);
}

/** Builds the deterministic request envelope used for a scenario's submission. */
export function scenarioRequest(scenarioId: string, index = 0): Record<string, unknown> {
  const scenario = findScenario(scenarioId);
  if (!scenario) {
    throw new SandboxReplayError(`Unknown sandbox scenario "${scenarioId}"`, "UNKNOWN_SCENARIO");
  }
  return {
    envelope: {
      sourceAccount: "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      sequenceNumber: String(1000 + index),
      fee: "100",
      networkPassphrase: "Test SDF Network ; September 2015",
      operation: "invokeHostFunction",
    },
    scenarioId: scenario.id,
  };
}

/** Maps a scenario onto the response the mock RPC adapter would return. */
export function scenarioToResponse(scenarioId: string): SandboxResponse<Record<string, unknown>> {
  const scenario = findScenario(scenarioId);
  if (!scenario) {
    throw new SandboxReplayError(`Unknown sandbox scenario "${scenarioId}"`, "UNKNOWN_SCENARIO");
  }

  const succeeded = scenario.status === "SUCCESS";
  const code = scenario.transactionCode ?? (succeeded ? "txSUCCESS" : "txUNKNOWN");

  return {
    success: succeeded,
    data: {
      hash: hashOf(`tx:${scenario.id}`),
      ledger: 4567890,
      status: succeeded ? "SUCCESS" : "FAILED",
      transactionCode: scenario.transactionCode,
      operationCode: scenario.operationCode,
      diagnosticEvents: scenarioDiagnostics(scenario.id),
      soroban: scenario.soroban,
    },
    error:
      succeeded
        ? undefined
        : scenario.soroban?.message ??
          `${scenario.label} (${scenario.transactionCode ?? "txUNKNOWN"}${scenario.operationCode ? ` / ${scenario.operationCode}` : ""})`,
    timestamp: 1_760_000_000_000,
    code,
    httpStatus: scenario.httpStatus,
    retriable: scenario.retriable,
    diagnosticEvents: scenarioDiagnostics(scenario.id),
    resultXdr: scenarioResultXdr(scenario.id),
    scenarioId: scenario.id,
  };
}

/**
 * Builds a replayable tape for one or more scenarios.
 *
 * Each scenario contributes a `submitTransaction` interaction and, when the
 * caller asks for it, a `getTransactionStatus` lookup for the same hash so the
 * "submitted but not yet confirmed" flow is replayable too.
 */
export function buildTapeFromScenarios(
  scenarioIds: string[],
  options: { name?: string; hashLookup?: boolean; now?: number; metadata?: Record<string, unknown> } = {},
): ReplayTape {
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    throw new SandboxReplayError("At least one scenario id is required", "EMPTY_SCENARIO_LIST");
  }

  const name = options.name ?? `Sandbox tape (${scenarioIds.length} scenario${scenarioIds.length === 1 ? "" : "s"})`;
  const includeLookup = options.hashLookup !== false;
  const createdAt = options.now ?? 1_760_000_000_000;
  const tapeId = `tape-${fnv1a32(`${name}:${scenarioIds.join(",")}`).toString(16)}`;
  const interactions: RecordedInteraction[] = [];
  let sequence = 0;

  scenarioIds.forEach((scenarioId, index) => {
    const response = scenarioToResponse(scenarioId);
    const request = scenarioRequest(scenarioId, index);

    sequence += 1;
    interactions.push({
      id: `${tapeId}-i${sequence}`,
      seq: sequence,
      method: "submitTransaction",
      request,
      requestKey: hashRequest("submitTransaction", request),
      response,
      recordedAt: createdAt + index * 1000,
      durationMs: 25 + index,
      label: findScenario(scenarioId)?.label ?? scenarioId,
      scenarioId,
    });

    if (includeLookup) {
      const hash = (response.data as Record<string, unknown>).hash;
      const statusRequest = { hash };
      sequence += 1;
      interactions.push({
        id: `${tapeId}-i${sequence}`,
        seq: sequence,
        method: "getTransactionStatus",
        request: statusRequest,
        requestKey: hashRequest("getTransactionStatus", statusRequest),
        response: {
          ...response,
          data: {
            ...(response.data as object),
            status: response.success ? "confirmed" : "failed",
            hash,
          },
        },
        recordedAt: createdAt + index * 1000 + 500,
        durationMs: 12 + index,
        label: `${findScenario(scenarioId)?.label ?? scenarioId} (confirmation)`,
        scenarioId,
      });
    }
  });

  return {
    id: tapeId,
    name,
    createdAt,
    interactions,
    metadata: { source: "scenario-presets", scenarioIds: [...scenarioIds], ...options.metadata },
  };
}

export function buildTapeFromPreset(presetId: string, now?: number): ReplayTape {
  const preset = getTapePreset(presetId);
  if (!preset) {
    throw new SandboxReplayError(`Unknown tape preset "${presetId}"`, "UNKNOWN_TAPE_PRESET");
  }
  return buildTapeFromScenarios(preset.scenarioIds, {
    name: preset.name,
    now,
    metadata: { presetId: preset.id, description: preset.description },
  });
}

function hashOf(input: string): string {
  // 64 hex chars, matching the shape of a Stellar transaction hash.
  let a = fnv1a32(`${input}:a`).toString(16).padStart(8, "0");
  let b = fnv1a32(`${input}:b`).toString(16).padStart(8, "0");
  let c = fnv1a32(`${input}:c`).toString(16).padStart(8, "0");
  let d = fnv1a32(`${input}:d`).toString(16).padStart(8, "0");
  return `${a}${b}${c}${d}${a.split("").reverse().join("")}${b.split("").reverse().join("")}${c.split("").reverse().join("")}${d.split("").reverse().join("")}`;
}

/** Short human summary for the recorder UI header. */
export function summariseTape(tape: ReplayTape): string {
  const counts = new Map<ReplayableMethod, number>();
  for (const interaction of tape.interactions) {
    counts.set(interaction.method, (counts.get(interaction.method) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].map(([method, count]) => `${count}× ${method}`).join(", ");
  return `${tape.name}: ${tape.interactions.length} interaction(s)${breakdown ? ` — ${breakdown}` : ""}`;
}
