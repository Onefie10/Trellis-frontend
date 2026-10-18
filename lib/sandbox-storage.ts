/**
 * Soroban storage state stubs
 *
 * Lets a developer describe contract storage — Instance, Persistent and
 * Temporary entries — and inject it into the sandbox, so agent UI can be
 * exercised against states that are awkward to reach on testnet: a paused
 * contract, a custom admin, a near-empty reserve, an entry about to expire.
 *
 * Stubs are plain JSON (so they can be saved as presets and shared as
 * fixtures) and serialise into the exact XDR shapes Soroban RPC returns from
 * `getLedgerEntries`:
 *
 *   persistent / temporary  → one CONTRACT_DATA entry per key
 *   instance                → one CONTRACT_DATA entry per contract, keyed by
 *                             LedgerKeyContractInstance, whose value is an
 *                             ScContractInstance holding every instance key
 */

import { Address, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export type SorobanStorageType = "instance" | "persistent" | "temporary";

export const SOROBAN_STORAGE_TYPES: readonly SorobanStorageType[] = [
  "instance",
  "persistent",
  "temporary",
];

/** ScVal types a stub key or value can be written as. */
export type StorageScValType =
  | "symbol"
  | "string"
  | "bool"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "address"
  | "bytes"
  | "json";

export const STORAGE_SCVAL_TYPES: readonly StorageScValType[] = [
  "symbol",
  "string",
  "bool",
  "u32",
  "i32",
  "u64",
  "i64",
  "u128",
  "i128",
  "address",
  "bytes",
  "json",
];

export interface StorageStubEntry {
  id: string;
  contractId: string;
  storage: SorobanStorageType;
  key: string;
  keyType: StorageScValType;
  value: string;
  valueType: StorageScValType;
  /** Ledger the entry lives until. Ignored for instance keys (they share the instance TTL). */
  liveUntilLedger?: number;
}

export interface StorageStubPreset {
  id: string;
  name: string;
  description: string;
  entries: StorageStubEntry[];
  builtIn?: boolean;
}

export const STORAGE_FIXTURE_KIND = "trellis.soroban-storage-stubs";
export const STORAGE_FIXTURE_VERSION = 1;

/** Shareable JSON fixture wrapping a set of stubs. */
export interface StorageStubFixture {
  kind: typeof STORAGE_FIXTURE_KIND;
  version: typeof STORAGE_FIXTURE_VERSION;
  name: string;
  description?: string;
  entries: Array<Omit<StorageStubEntry, "id">>;
}

/** One entry in a mock `getLedgerEntries` response, matching Soroban RPC. */
export interface MockLedgerEntryResult {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq?: number;
}

export interface MockGetLedgerEntriesResponse {
  entries: MockLedgerEntryResult[];
  latestLedger: number;
}

export class StorageStubError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "StorageStubError";
    this.field = field;
  }
}

/** Ledger the mock RPC reports as latest; TTLs are relative to it. */
export const MOCK_LATEST_LEDGER = 1_000_000;
const DEFAULT_TTL_LEDGERS = 120_960; // ~7 days at 5s ledgers

const INTEGER_RANGES: Partial<Record<StorageScValType, [bigint, bigint]>> = {
  u32: [BigInt(0), BigInt(2) ** BigInt(32) - BigInt(1)],
  i32: [-(BigInt(2) ** BigInt(31)), BigInt(2) ** BigInt(31) - BigInt(1)],
  u64: [BigInt(0), BigInt(2) ** BigInt(64) - BigInt(1)],
  i64: [-(BigInt(2) ** BigInt(63)), BigInt(2) ** BigInt(63) - BigInt(1)],
  u128: [BigInt(0), BigInt(2) ** BigInt(128) - BigInt(1)],
  i128: [-(BigInt(2) ** BigInt(127)), BigInt(2) ** BigInt(127) - BigInt(1)],
};

let idCounter = 0;
export function createStubId(): string {
  idCounter += 1;
  return `stub-${Date.now().toString(36)}-${idCounter}`;
}

function parseInteger(raw: string, type: StorageScValType, field: string): bigint {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new StorageStubError(`Expected an integer for ${type}, got "${raw}"`, field);
  }
  const value = BigInt(trimmed);
  const [min, max] = INTEGER_RANGES[type] as [bigint, bigint];
  if (value < min || value > max) {
    throw new StorageStubError(`${value} is out of range for ${type}`, field);
  }
  return value;
}

/**
 * Builds an SCV_BYTES value from hex via its XDR encoding. Going through
 * `fromXDR` keeps the buffer inside the SDK's own Buffer implementation, which
 * its browser bundle requires (a host `Buffer` is rejected there).
 */
function scvBytesFromHex(hex: string): xdr.ScVal {
  const length = hex.length / 2;
  const padding = (4 - (length % 4)) % 4;
  const header = [xdr.ScValType.scvBytes().value, length]
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
  const encoded = `${header}${hex}${"00".repeat(padding)}`;
  const bytes = encoded.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? [];
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return xdr.ScVal.fromXDR(btoa(binary), "base64");
}

/** Converts a typed text value into an ScVal. Throws `StorageStubError` on bad input. */
export function toStubScVal(raw: string, type: StorageScValType, field = "value"): xdr.ScVal {
  switch (type) {
    case "symbol":
      if (!/^[A-Za-z0-9_]{1,32}$/.test(raw)) {
        throw new StorageStubError("Symbols are 1-32 characters of [A-Za-z0-9_]", field);
      }
      return nativeToScVal(raw, { type: "symbol" });
    case "string":
      return nativeToScVal(raw, { type: "string" });
    case "bool": {
      const normalised = raw.trim().toLowerCase();
      if (normalised !== "true" && normalised !== "false") {
        throw new StorageStubError('Booleans must be "true" or "false"', field);
      }
      return nativeToScVal(normalised === "true", { type: "bool" });
    }
    case "u32":
    case "i32":
      return nativeToScVal(Number(parseInteger(raw, type, field)), { type });
    case "u64":
    case "i64":
    case "u128":
    case "i128":
      return nativeToScVal(parseInteger(raw, type, field), { type });
    case "address":
      if (!StrKey.isValidEd25519PublicKey(raw.trim()) && !StrKey.isValidContract(raw.trim())) {
        throw new StorageStubError("Addresses must be a valid G… account or C… contract", field);
      }
      return new Address(raw.trim()).toScVal();
    case "bytes": {
      const hex = raw.trim().replace(/^0x/i, "");
      if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
        throw new StorageStubError("Bytes must be an even-length hex string", field);
      }
      return scvBytesFromHex(hex);
    }
    case "json":
      try {
        return nativeToScVal(JSON.parse(raw));
      } catch (error) {
        throw new StorageStubError(
          `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          field,
        );
      }
    default:
      throw new StorageStubError(`Unsupported type ${String(type)}`, field);
  }
}

/** Returns every validation problem with `entry`; empty when it is usable. */
export function validateStorageStub(entry: StorageStubEntry): StorageStubError[] {
  const errors: StorageStubError[] = [];
  if (!StrKey.isValidContract(entry.contractId.trim())) {
    errors.push(new StorageStubError("Contract id must be a valid C… contract address", "contractId"));
  }
  if (!SOROBAN_STORAGE_TYPES.includes(entry.storage)) {
    errors.push(new StorageStubError(`Unknown storage type "${entry.storage}"`, "storage"));
  }
  for (const [field, raw, type] of [
    ["key", entry.key, entry.keyType],
    ["value", entry.value, entry.valueType],
  ] as const) {
    try {
      toStubScVal(raw, type, field);
    } catch (error) {
      errors.push(error instanceof StorageStubError ? error : new StorageStubError(String(error), field));
    }
  }
  if (
    entry.liveUntilLedger !== undefined &&
    (!Number.isInteger(entry.liveUntilLedger) || entry.liveUntilLedger <= 0)
  ) {
    errors.push(new StorageStubError("liveUntilLedger must be a positive integer", "liveUntilLedger"));
  }
  return errors;
}

function durabilityFor(storage: SorobanStorageType): xdr.ContractDataDurability {
  return storage === "temporary"
    ? xdr.ContractDataDurability.temporary()
    : xdr.ContractDataDurability.persistent();
}

/** The LedgerKey Soroban RPC uses to look up `entry` (base64 XDR). */
export function storageStubLedgerKey(entry: Pick<StorageStubEntry, "contractId" | "storage" | "key" | "keyType">): string {
  const key =
    entry.storage === "instance"
      ? xdr.ScVal.scvLedgerKeyContractInstance()
      : toStubScVal(entry.key, entry.keyType, "key");
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(entry.contractId.trim()).toScAddress(),
      key,
      durability: durabilityFor(entry.storage),
    }),
  ).toXDR("base64");
}

function contractDataEntry(
  contractId: string,
  storage: SorobanStorageType,
  key: xdr.ScVal,
  val: xdr.ScVal,
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contractId).toScAddress(),
      key,
      durability: durabilityFor(storage),
      val,
    }),
  );
}

/**
 * Serialises stubs into a mock Soroban RPC `getLedgerEntries` response.
 * Throws `StorageStubError` for the first invalid entry.
 */
export function serializeStorageStubs(
  entries: readonly StorageStubEntry[],
  latestLedger = MOCK_LATEST_LEDGER,
): MockGetLedgerEntriesResponse {
  const results: MockLedgerEntryResult[] = [];
  const instances = new Map<string, { storage: xdr.ScMapEntry[]; liveUntil?: number }>();

  for (const entry of entries) {
    const [firstError] = validateStorageStub(entry);
    if (firstError) {
      throw new StorageStubError(`${entry.storage} key "${entry.key}": ${firstError.message}`, firstError.field);
    }
    const contractId = entry.contractId.trim();
    const key = toStubScVal(entry.key, entry.keyType, "key");
    const val = toStubScVal(entry.value, entry.valueType, "value");

    if (entry.storage === "instance") {
      const instance = instances.get(contractId) ?? { storage: [] };
      instance.storage.push(new xdr.ScMapEntry({ key, val }));
      if (entry.liveUntilLedger !== undefined) {
        instance.liveUntil = Math.max(instance.liveUntil ?? 0, entry.liveUntilLedger);
      }
      instances.set(contractId, instance);
      continue;
    }

    results.push({
      key: storageStubLedgerKey(entry),
      xdr: contractDataEntry(contractId, entry.storage, key, val).toXDR("base64"),
      lastModifiedLedgerSeq: latestLedger,
      liveUntilLedgerSeq: entry.liveUntilLedger ?? latestLedger + DEFAULT_TTL_LEDGERS,
    });
  }

  for (const [contractId, instance] of instances) {
    // Soroban requires ScMap keys in ascending order.
    const storage = [...instance.storage].sort((a, b) =>
      Buffer.compare(a.key().toXDR(), b.key().toXDR()),
    );
    const val = xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
        storage,
      }),
    );
    results.push({
      key: storageStubLedgerKey({ contractId, storage: "instance", key: "", keyType: "symbol" }),
      xdr: contractDataEntry(contractId, "instance", xdr.ScVal.scvLedgerKeyContractInstance(), val).toXDR(
        "base64",
      ),
      lastModifiedLedgerSeq: latestLedger,
      liveUntilLedgerSeq: instance.liveUntil ?? latestLedger + DEFAULT_TTL_LEDGERS,
    });
  }

  return { entries: results, latestLedger };
}

/**
 * Reads one stubbed value back as a native JS value — what a contract client
 * would see after decoding. Returns `undefined` when no stub matches.
 */
export function readStubbedValue(
  entries: readonly StorageStubEntry[],
  query: { contractId: string; storage: SorobanStorageType; key: string; keyType?: StorageScValType },
): unknown {
  const match = entries.find(
    (entry) =>
      entry.contractId.trim() === query.contractId.trim() &&
      entry.storage === query.storage &&
      entry.key === query.key &&
      (query.keyType === undefined || entry.keyType === query.keyType),
  );
  if (!match) return undefined;
  return scValToNative(toStubScVal(match.value, match.valueType));
}

/* -------------------------------------------------------------------------- */
/* Fixtures (export / import)                                                 */
/* -------------------------------------------------------------------------- */

export function exportStorageFixture(
  name: string,
  entries: readonly StorageStubEntry[],
  description?: string,
): string {
  const fixture: StorageStubFixture = {
    kind: STORAGE_FIXTURE_KIND,
    version: STORAGE_FIXTURE_VERSION,
    name,
    ...(description ? { description } : {}),
    entries: entries.map(({ id: _id, ...rest }) => rest),
  };
  return JSON.stringify(fixture, null, 2);
}

/** Parses and validates a fixture. Entries get fresh ids. */
export function importStorageFixture(json: string): {
  name: string;
  description?: string;
  entries: StorageStubEntry[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new StorageStubError(`Fixture is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new StorageStubError("Fixture must be a JSON object");
  const fixture = parsed as Partial<StorageStubFixture>;
  if (fixture.kind !== STORAGE_FIXTURE_KIND) {
    throw new StorageStubError(`Fixture kind must be "${STORAGE_FIXTURE_KIND}"`);
  }
  if (fixture.version !== STORAGE_FIXTURE_VERSION) {
    throw new StorageStubError(`Unsupported fixture version ${String(fixture.version)}`);
  }
  if (!Array.isArray(fixture.entries)) throw new StorageStubError("Fixture entries must be an array");

  const entries = fixture.entries.map((raw, index): StorageStubEntry => {
    const candidate = raw as Partial<StorageStubEntry>;
    const entry: StorageStubEntry = {
      id: createStubId(),
      contractId: String(candidate.contractId ?? ""),
      storage: candidate.storage as SorobanStorageType,
      key: String(candidate.key ?? ""),
      keyType: (candidate.keyType ?? "symbol") as StorageScValType,
      value: String(candidate.value ?? ""),
      valueType: (candidate.valueType ?? "string") as StorageScValType,
      ...(candidate.liveUntilLedger !== undefined ? { liveUntilLedger: Number(candidate.liveUntilLedger) } : {}),
    };
    if (!STORAGE_SCVAL_TYPES.includes(entry.keyType) || !STORAGE_SCVAL_TYPES.includes(entry.valueType)) {
      throw new StorageStubError(`Entry ${index + 1}: unknown key or value type`);
    }
    const [error] = validateStorageStub(entry);
    if (error) throw new StorageStubError(`Entry ${index + 1}: ${error.message}`, error.field);
    return entry;
  });

  return {
    name: typeof fixture.name === "string" && fixture.name ? fixture.name : "Imported stubs",
    description: typeof fixture.description === "string" ? fixture.description : undefined,
    entries,
  };
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic placeholder contract/admin addresses (not real accounts). */
export const STUB_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
export const STUB_ADMIN_ADDRESS = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));

const stub = (entry: Omit<StorageStubEntry, "id" | "contractId"> & { contractId?: string }, id: string): StorageStubEntry => ({
  id,
  contractId: STUB_CONTRACT_ID,
  ...entry,
});

export const BUILT_IN_STORAGE_PRESETS: readonly StorageStubPreset[] = [
  {
    id: "paused-contract",
    name: "Paused contract",
    description: "Instance flag Paused=true — every state-changing call should be refused.",
    builtIn: true,
    entries: [
      stub({ storage: "instance", key: "Paused", keyType: "symbol", value: "true", valueType: "bool" }, "paused-1"),
      stub({ storage: "instance", key: "Admin", keyType: "symbol", value: STUB_ADMIN_ADDRESS, valueType: "address" }, "paused-2"),
    ],
  },
  {
    id: "custom-admin",
    name: "Custom admin key",
    description: "Instance Admin set to a sandbox-only account, so admin-gated UI can be exercised.",
    builtIn: true,
    entries: [
      stub({ storage: "instance", key: "Admin", keyType: "symbol", value: STUB_ADMIN_ADDRESS, valueType: "address" }, "admin-1"),
      stub({ storage: "instance", key: "Paused", keyType: "symbol", value: "false", valueType: "bool" }, "admin-2"),
    ],
  },
  {
    id: "low-reserve",
    name: "Low reserve balance",
    description: "Persistent Reserve of 0.25 XLM (in stroops), below a 1 XLM operating minimum.",
    builtIn: true,
    entries: [
      stub({ storage: "persistent", key: "Reserve", keyType: "symbol", value: "2500000", valueType: "i128" }, "reserve-1"),
      stub({ storage: "persistent", key: "MinReserve", keyType: "symbol", value: "10000000", valueType: "i128" }, "reserve-2"),
    ],
  },
  {
    id: "expiring-session",
    name: "Expiring temporary entry",
    description: "Temporary Nonce that expires 10 ledgers after the mock latest ledger.",
    builtIn: true,
    entries: [
      stub(
        {
          storage: "temporary",
          key: "Nonce",
          keyType: "symbol",
          value: "42",
          valueType: "u64",
          liveUntilLedger: MOCK_LATEST_LEDGER + 10,
        },
        "nonce-1",
      ),
    ],
  },
];

export const STORAGE_PRESETS_STORAGE_KEY = "trellis:sandbox:storage-presets";

function presetStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Presets the developer saved in this browser. Corrupt data is ignored. */
export function loadSavedStoragePresets(storage: Storage | null = presetStorage()): StorageStubPreset[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_PRESETS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (preset): preset is StorageStubPreset =>
            preset && typeof preset.id === "string" && typeof preset.name === "string" && Array.isArray(preset.entries),
        )
      : [];
  } catch {
    return [];
  }
}

/** Saves (or replaces by name) a preset and returns the full saved list. */
export function saveStoragePreset(
  name: string,
  entries: readonly StorageStubEntry[],
  description = "",
  storage: Storage | null = presetStorage(),
): StorageStubPreset[] {
  const trimmed = name.trim();
  if (!trimmed) throw new StorageStubError("Preset name is required", "name");
  const existing = loadSavedStoragePresets(storage).filter((preset) => preset.name !== trimmed);
  const preset: StorageStubPreset = {
    id: `saved-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: trimmed,
    description,
    entries: entries.map((entry) => ({ ...entry })),
  };
  const next = [...existing, preset];
  storage?.setItem(STORAGE_PRESETS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function deleteStoragePreset(id: string, storage: Storage | null = presetStorage()): StorageStubPreset[] {
  const next = loadSavedStoragePresets(storage).filter((preset) => preset.id !== id);
  storage?.setItem(STORAGE_PRESETS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Copies a preset's entries with fresh ids so edits never mutate the preset. */
export function instantiatePreset(preset: StorageStubPreset): StorageStubEntry[] {
  return preset.entries.map((entry) => ({ ...entry, id: createStubId() }));
}
