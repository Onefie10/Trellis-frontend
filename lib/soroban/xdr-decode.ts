import * as StellarSdk from "@stellar/stellar-sdk";
import { SorobanEvent } from "../types";

/**
 * Typed decoding of Soroban `ScVal` payloads.
 *
 * `scValToNative` (from the Stellar SDK) collapses every Soroban value into a
 * plain JS value, which loses the distinction between a `symbol` contract event
 * name and a `string`, turns `bytes` into an opaque buffer, and throws for a
 * handful of arms (`scvError`, `scvContractInstance`, ...). Contract events need
 * those distinctions to be rendered and routed in the UI, so this module decodes
 * the `ScVal` union arm-by-arm into a small discriminated union and only falls
 * back to the SDK converter for the numeric / 256-bit arms it does not model.
 */

export type ScValKind =
  | "bool"
  | "void"
  | "error"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "u256"
  | "i256"
  | "timepoint"
  | "duration"
  | "bytes"
  | "string"
  | "symbol"
  | "vec"
  | "map"
  | "address"
  | "contract_instance"
  | "ledger_key_contract_instance"
  | "ledger_key_nonce"
  | "unknown";

export interface DecodedScVal {
  kind: ScValKind;
  value: unknown;
}

export interface DecodedMapEntry {
  key: DecodedScVal;
  value: DecodedScVal;
}

/** Arm name (`scvSymbol`, `scvAddress`, ...) -> kind shipped to callers. */
const KIND_BY_ARM: Record<string, ScValKind> = {
  scvBool: "bool",
  scvVoid: "void",
  scvError: "error",
  scvU32: "u32",
  scvI32: "i32",
  scvU64: "u64",
  scvI64: "i64",
  scvU128: "u128",
  scvI128: "i128",
  scvU256: "u256",
  scvI256: "i256",
  scvTimepoint: "timepoint",
  scvDuration: "duration",
  scvBytes: "bytes",
  scvString: "string",
  scvSymbol: "symbol",
  scvVec: "vec",
  scvMap: "map",
  scvAddress: "address",
  scvContractInstance: "contract_instance",
  scvLedgerKeyContractInstance: "ledger_key_contract_instance",
  scvLedgerKeyNonce: "ledger_key_nonce",
};

/** Lowercase hex for a byte-ish value without depending on a global `Buffer`. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** `scValToNative` throws on several arms; a failed decode must not kill a stream. */
function toNativeSafe(scVal: StellarSdk.xdr.ScVal): unknown {
  try {
    return StellarSdk.scValToNative(scVal);
  } catch {
    return null;
  }
}

/**
 * Decode a single `ScVal` into `{ kind, value }`.
 *
 * Recurses through `vec` and `map` so nested structures are decoded too. Values
 * are plain JS: symbol/string -> string, address -> StrKey string, bool -> boolean,
 * bytes -> lowercase hex string, vec -> DecodedScVal[], map -> DecodedMapEntry[],
 * numbers/128+ bit ints -> the SDK's native representation (number or bigint).
 */
export function decodeScVal(scVal: StellarSdk.xdr.ScVal): DecodedScVal {
  const arm = scVal.switch().name;
  const kind = KIND_BY_ARM[arm] ?? "unknown";

  switch (arm) {
    case "scvSymbol":
      return { kind, value: scVal.sym().toString() };
    case "scvString":
      return { kind, value: scVal.str().toString() };
    case "scvAddress":
      try {
        return { kind, value: StellarSdk.Address.fromScVal(scVal).toString() };
      } catch {
        return { kind, value: toNativeSafe(scVal) };
      }
    case "scvBool":
      return { kind, value: scVal.b() };
    case "scvVoid":
      return { kind, value: null };
    case "scvBytes":
      return { kind, value: toHex(scVal.bytes()) };
    case "scvVec":
      return { kind, value: (scVal.vec() ?? []).map((entry) => decodeScVal(entry)) };
    case "scvMap":
      return {
        kind,
        value: (scVal.map() ?? []).map(
          (entry): DecodedMapEntry => ({
            key: decodeScVal(entry.key()),
            value: decodeScVal(entry.val()),
          }),
        ),
      };
    case "scvU32":
      return { kind, value: scVal.u32() };
    case "scvI32":
      return { kind, value: scVal.i32() };
    default:
      // u64/i64/u128/i128/u256/i256/timepoint/duration/error/contract-instance
      // and any future arm: the SDK converter is the source of truth.
      return { kind, value: toNativeSafe(scVal) };
  }
}

/** Decode a base64 `ScVal` string, returning `null` for a malformed value. */
export function decodeScValBase64(xdrBase64: string): DecodedScVal | null {
  try {
    return decodeScVal(StellarSdk.xdr.ScVal.fromXDR(xdrBase64, "base64"));
  } catch {
    return null;
  }
}

/**
 * A contract event decoded into typed JS values.
 *
 * Extends the existing `SorobanEvent` shape (`topics`/`value` stay plain JS so
 * existing renderers keep working) and adds the transport metadata needed for
 * de-duplication and catch-up: `id` (RPC paging token), `ledger`, `txHash`.
 */
export interface DecodedSorobanEvent extends SorobanEvent {
  type: string;
  contractId: string;
  topics: unknown[];
  value: unknown;
  /** First topic when it is a symbol — the conventional event name. */
  name: string | null;
  /** Same values as `topics`, with their `ScVal` kind preserved. */
  decodedTopics: DecodedScVal[];
  /** `value` with its `ScVal` kind preserved. */
  decodedValue: DecodedScVal;
  id: string | null;
  ledger: number | null;
  ledgerClosedAt: string | null;
  txHash: string | null;
  inSuccessfulContractCall: boolean | null;
}

export interface ContractEventInput {
  contractId: string;
  topics: StellarSdk.xdr.ScVal[];
  data: StellarSdk.xdr.ScVal;
  id?: string | null;
  ledger?: number | null;
  ledgerClosedAt?: string | null;
  txHash?: string | null;
  inSuccessfulContractCall?: boolean | null;
  type?: string;
}

/**
 * Decode contract event topics + data into a typed JS object.
 *
 * The first topic of a Soroban contract event is by convention the event name
 * (a `symbol`); it is surfaced both as `name` and as `decodedTopics[0]`.
 */
export function decodeContractEvent(input: ContractEventInput): DecodedSorobanEvent {
  const decodedTopics = input.topics.map((topic) => decodeScVal(topic));
  const decodedValue = decodeScVal(input.data);
  const first = decodedTopics[0];

  return {
    type: input.type ?? "contract_event",
    contractId: input.contractId,
    topics: decodedTopics.map((topic) => topic.value),
    value: decodedValue.value,
    name: first && first.kind === "symbol" ? String(first.value) : null,
    decodedTopics,
    decodedValue,
    id: input.id ?? null,
    ledger: input.ledger ?? null,
    ledgerClosedAt: input.ledgerClosedAt ?? null,
    txHash: input.txHash ?? null,
    inSuccessfulContractCall: input.inSuccessfulContractCall ?? null,
  };
}

/** Decode a raw RPC event whose `topic`/`value` fields are base64 XDR strings. */
export function decodeRawRpcEvent(raw: {
  id?: string;
  ledger?: number | string;
  ledgerClosedAt?: string;
  contractId?: string;
  type?: string;
  topic?: string[];
  value?: string;
  txHash?: string;
  inSuccessfulContractCall?: boolean;
}): DecodedSorobanEvent | null {
  const topics = (raw.topic ?? []).map((entry) => {
    try {
      return StellarSdk.xdr.ScVal.fromXDR(entry, "base64");
    } catch {
      return null;
    }
  });

  if (topics.some((topic) => topic === null)) {
    return null;
  }

  let data: StellarSdk.xdr.ScVal;
  try {
    data = StellarSdk.xdr.ScVal.fromXDR(raw.value ?? "", "base64");
  } catch {
    return null;
  }

  return decodeContractEvent({
    contractId: raw.contractId ?? "",
    topics: topics as StellarSdk.xdr.ScVal[],
    data,
    id: raw.id ?? null,
    ledger: raw.ledger === undefined ? null : Number(raw.ledger),
    ledgerClosedAt: raw.ledgerClosedAt ?? null,
    txHash: raw.txHash ?? null,
    inSuccessfulContractCall: raw.inSuccessfulContractCall ?? null,
    type: raw.type,
  });
}
