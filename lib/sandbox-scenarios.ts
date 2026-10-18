/**
 * Sandbox Scenario Presets
 *
 * Named, deterministic on-chain failure/success cases so a contributor can pull
 * up "Out of Energy" or "Invalid Sequence" without resorting to a real testnet
 * transaction (and without burning testnet XLM trying to reproduce them).
 *
 * The result codes mirror the Stellar / Soroban naming so the shapes stay
 * recognisable, but every XDR here is a labelled mock — see `scenarioResultXdr`.
 */

export type SandboxScenarioCategory =
  | "success"
  | "resource"
  | "sequence"
  | "ledger"
  | "balance"
  | "validation"
  | "network";

export type SorobanErrorType = "budget" | "vm" | "storage" | "auth" | "value";

export type SandboxScenarioId =
  | "success"
  | "out_of_energy"
  | "invalid_sequence"
  | "tx_expired"
  | "insufficient_balance"
  | "missing_trustline"
  | "unauthorised_asset"
  | "contract_trap"
  | "invalid_argument"
  | "rate_limited"
  | "timeout";

export interface SorobanDiagnostic {
  type: SorobanErrorType;
  code: string;
  message: string;
}

export interface SandboxScenario {
  id: SandboxScenarioId;
  label: string;
  description: string;
  category: SandboxScenarioCategory;
  /** HTTP status the mock RPC adapter reports for this scenario. */
  httpStatus: number;
  status: "SUCCESS" | "FAILED";
  /** `txSUCCESS` / `txFAILED` / `txBAD_SEQ` / `txTOO_LATE` … */
  transactionCode?: string;
  operationCode?: string;
  soroban?: SorobanDiagnostic;
  /** Soroban diagnostic events, as surfaced by `getTransaction` diagnostics. */
  diagnosticEvents: string[];
  /** HTTP `Retry-After`, present for rate limiting. */
  retryAfterSeconds?: number;
  /** Whether a well-behaved client may simply retry the same transaction. */
  retriable: boolean;
  hints: string[];
}

export class SandboxScenarioError extends Error {
  readonly code: string;
  readonly scenarioId?: string;

  constructor(message: string, code: string, scenarioId?: string) {
    super(message);
    this.name = "SandboxScenarioError";
    this.code = code;
    this.scenarioId = scenarioId;
  }
}

export const SCENARIO_PRESETS: SandboxScenario[] = [
  {
    id: "success",
    label: "Successful transaction",
    description: "Transaction included in a ledger, operation succeeded.",
    category: "success",
    httpStatus: 200,
    status: "SUCCESS",
    transactionCode: "txSUCCESS",
    operationCode: "opINNER / invokeHostFunction → SOROBAN_SUCCESS",
    diagnosticEvents: [],
    retriable: false,
    hints: ["Baseline for assertions — nothing should look like an error here."],
  },
  {
    id: "out_of_energy",
    label: "Out of Energy",
    description:
      "Soroban CPU-instruction / memory budget exceeded, so the host halts the invocation after the ledger fee is charged.",
    category: "resource",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txFAILED",
    operationCode: "invokeHostFunction → SOROBAN_FAILED",
    soroban: {
      type: "budget",
      code: "ExceededLimit",
      message: "HostError: Error(Budget, ExceededLimit)",
    },
    diagnosticEvents: [
      "fn_call",
      "HostError: Error(Budget, ExceededLimit)",
      "cpu_insn_limit exceeded: 100000000/100000000",
      "You have exhausted your compute budget. Consider raising the resource fee.",
    ],
    retriable: false,
    hints: [
      "Fees are still charged — the UI must not show a green confirmation.",
      "Suggest raising the resource fee rather than silently retrying.",
    ],
  },
  {
    id: "invalid_sequence",
    label: "Invalid Sequence",
    description:
      "The transaction used a stale sequence number, typically because another transaction from the same account landed first.",
    category: "sequence",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txBAD_SEQ",
    diagnosticEvents: [],
    retriable: true,
    hints: [
      "Recover by re-fetching the account sequence number and rebuilding.",
      "A client that retries the identical envelope will fail again.",
    ],
  },
  {
    id: "tx_expired",
    label: "Tx Expired",
    description: "The transaction's timebounds were already closed when it reached the ledger (txTOO_LATE).",
    category: "ledger",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txTOO_LATE",
    diagnosticEvents: [],
    retriable: true,
    hints: ["Rebuild with a fresh timebound window before retrying."],
  },
  {
    id: "insufficient_balance",
    label: "Insufficient Balance",
    description: "The source account could not cover the payment plus the fee (opUNDERFUNDED).",
    category: "balance",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txFAILED",
    operationCode: "payment → opUNDERFUNDED",
    diagnosticEvents: [],
    retriable: false,
    hints: [
      "The mock wallet generator can produce this state with the 'Low XLM' preset.",
    ],
  },
  {
    id: "missing_trustline",
    label: "Missing Trustline",
    description: "The destination has no trustline for the asset (opNO_TRUST / opSRC_NO_TRUST).",
    category: "balance",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txFAILED",
    operationCode: "payment → opNO_TRUST",
    diagnosticEvents: [],
    retriable: false,
    hints: ["Prompt the user to create the trustline before paying this asset."],
  },
  {
    id: "unauthorised_asset",
    label: "Unauthorised Asset",
    description: "The trustline exists but the issuer has not authorised it (opNOT_AUTHORIZED).",
    category: "validation",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txFAILED",
    operationCode: "payment → opNOT_AUTHORIZED",
    diagnosticEvents: [],
    retriable: true,
    hints: ["Distinct from a missing trustline — surface a different message."],
  },
  {
    id: "contract_trap",
    label: "Contract Trap",
    description: "The contract trapped (WasmVm InvalidAction / Unreachable) and rolled back its state.",
    category: "validation",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txFAILED",
    operationCode: "invokeHostFunction → SOROBAN_FAILED",
    soroban: {
      type: "vm",
      code: "InvalidAction",
      message: "HostError: Error(WasmVm, InvalidAction)",
    },
    diagnosticEvents: [
      "fn_call",
      "HostError: Error(WasmVm, InvalidAction)",
      "VM trapped: Unreachable",
    ],
    retriable: false,
    hints: ["State changes are rolled back, but the fee is not."],
  },
  {
    id: "invalid_argument",
    label: "Invalid Argument",
    description: "The host rejected an argument before executing the contract (SOROBAN_INVALID).",
    category: "validation",
    httpStatus: 200,
    status: "FAILED",
    transactionCode: "txFAILED",
    operationCode: "invokeHostFunction → SOROBAN_INVALID",
    soroban: {
      type: "value",
      code: "InvalidInput",
      message: "HostError: Error(Value, InvalidInput)",
    },
    diagnosticEvents: ["HostError: Error(Value, InvalidInput)"],
    retriable: false,
    hints: ["A client-side bug — the transaction should never have been built."],
  },
  {
    id: "rate_limited",
    label: "Rate Limited",
    description: "The RPC endpoint returned 429 with a Retry-After header.",
    category: "network",
    httpStatus: 429,
    status: "FAILED",
    diagnosticEvents: [],
    retryAfterSeconds: 5,
    retriable: true,
    hints: ["Back off for Retry-After seconds; do not hammer the endpoint."],
  },
  {
    id: "timeout",
    label: "Network Timeout",
    description: "The submission never produced a response — the transaction may or may not have landed.",
    category: "network",
    httpStatus: 504,
    status: "FAILED",
    diagnosticEvents: [],
    retriable: true,
    hints: [
      "Never assume failure: reconcile by looking the hash up before resubmitting.",
    ],
  },
];

export function listScenarios(category?: SandboxScenarioCategory): SandboxScenario[] {
  if (!category) return [...SCENARIO_PRESETS];
  return SCENARIO_PRESETS.filter((s) => s.category === category);
}

export function getScenario(id: string): SandboxScenario {
  const scenario = SCENARIO_PRESETS.find((s) => s.id === id);
  if (!scenario) {
    throw new SandboxScenarioError(`Unknown sandbox scenario "${id}"`, "UNKNOWN_SCENARIO", id);
  }
  return scenario;
}

export function findScenario(id: string): SandboxScenario | undefined {
  return SCENARIO_PRESETS.find((s) => s.id === id);
}

export function scenarioCategories(): SandboxScenarioCategory[] {
  return [...new Set(SCENARIO_PRESETS.map((s) => s.category))];
}

export function isRetriableScenario(id: string): boolean {
  return findScenario(id)?.retriable === true;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Browser-safe base64 encoder for ASCII payloads.
 *
 * `Buffer` is not available in client bundles, so this avoids it entirely.
 */
export function toBase64Ascii(input: string): string {
  if (typeof btoa === "function") return btoa(input);

  let output = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i) & 0xff;
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) & 0xff : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) & 0xff : NaN;

    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 0x03) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    output += Number.isNaN(b) ? "=" : BASE64_ALPHABET[((b & 0x0f) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    output += Number.isNaN(c) ? "=" : BASE64_ALPHABET[c & 0x3f];
  }
  return output;
}

/**
 * A deterministic, clearly-mock result envelope.
 *
 * The value is a base64 blob of the scenario id rather than real XDR — it exists
 * so callers that persist or compare "the XDR" get something stable, and it is
 * prefixed so nobody mistakes it for a decodable envelope.
 */
export function scenarioResultXdr(id: string): string {
  const scenario = getScenario(id);
  const payload = `MOCK-XDR:${scenario.id}:${scenario.transactionCode ?? "txUNKNOWN"}`;
  return toBase64Ascii(payload);
}

/** Human-readable one-liner used in logs and the recorder UI. */
export function describeScenario(scenario: SandboxScenario): string {
  const parts = [scenario.label];
  if (scenario.transactionCode) parts.push(scenario.transactionCode);
  if (scenario.operationCode) parts.push(scenario.operationCode);
  if (scenario.soroban) parts.push(scenario.soroban.message);
  if (scenario.httpStatus !== 200) parts.push(`HTTP ${scenario.httpStatus}`);
  return parts.join(" | ");
}

/**
 * The diagnostic events logged to the console by the host for this scenario.
 * Empty for scenarios that never reach the host.
 */
export function scenarioDiagnostics(id: string): string[] {
  return [...getScenario(id).diagnosticEvents];
}

/** Convenience for the recorder UI: scenarios that must not be retried as-is. */
export function nonRetriableScenarios(): SandboxScenario[] {
  return SCENARIO_PRESETS.filter((s) => !s.retriable);
}
