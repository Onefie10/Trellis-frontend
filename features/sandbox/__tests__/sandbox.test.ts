import { sandboxManager } from "../../../lib/sandbox";
import {
  MockStellarAdapter,
  MockVerificationAdapter,
  MockIPFSAdapter,
} from "../../../lib/sandbox-adapters";
import { getFixture, listFixtures } from "../../../lib/sandbox-fixtures";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  BUILT_IN_STORAGE_PRESETS,
  MOCK_LATEST_LEDGER,
  STORAGE_PRESETS_STORAGE_KEY,
  STUB_ADMIN_ADDRESS,
  STUB_CONTRACT_ID,
  StorageStubError,
  deleteStoragePreset,
  exportStorageFixture,
  importStorageFixture,
  instantiatePreset,
  loadSavedStoragePresets,
  readStubbedValue,
  saveStoragePreset,
  serializeStorageStubs,
  storageStubLedgerKey,
  toStubScVal,
  validateStorageStub,
  type StorageStubEntry,
} from "../../../lib/sandbox-storage";

describe("Sandbox Mode", () => {
  beforeEach(() => {
    sandboxManager.reset();
  });

  describe("Configuration", () => {
    it("should initialize sandbox with default settings", () => {
      sandboxManager.initialize();
      expect(sandboxManager.isEnabled()).toBe(false);
    });

    it("should enable sandbox mode", () => {
      sandboxManager.initialize({ enabled: true, mode: "enabled" });
      expect(sandboxManager.isEnabled()).toBe(true);
    });

    it("should support mock-only mode", () => {
      sandboxManager.initialize({ enabled: true, mode: "mock_only" });
      expect(sandboxManager.isMockOnly()).toBe(true);
    });
  });

  describe("Service Adapters", () => {
    beforeEach(() => {
      sandboxManager.initialize({ enabled: true, mockExternalServices: true, logRequests: true });
    });

    it("should mock Stellar adapter calls", async () => {
      const response = await MockStellarAdapter.getBalance(
        "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      );
      expect(response.success).toBe(true);
      expect(response.data?.balance).toBeDefined();
    });

    it("should mock verification adapter calls", async () => {
      const response = await MockVerificationAdapter.verify({});
      expect(response.success).toBe(true);
      expect(response.data?.verified).toBeDefined();
    });

    it("should mock IPFS adapter calls", async () => {
      const response = await MockIPFSAdapter.upload({});
      expect(response.success).toBe(true);
      expect(response.data?.hash).toBeDefined();
    });

    it("should return deterministic responses", async () => {
      const response1 = await MockStellarAdapter.getBalance(
        "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      );
      const response2 = await MockStellarAdapter.getBalance(
        "GBPYXYX5VKRK7KXKHM5CVJWYFQKKMHUXU5VWKJZAWLAQJ6WT3JPSMYD7",
      );
      expect(response1.data?.balance).toBe(response2.data?.balance);
    });
  });

  describe("Fixtures", () => {
    it("should provide wallet success fixture", () => {
      const fixture = getFixture("wallet-success");
      expect(fixture).toBeDefined();
      expect(fixture?.data.publicKey).toBeDefined();
    });

    it("should provide transaction fixtures", () => {
      const fixture = getFixture("txn-success");
      expect(fixture).toBeDefined();
      expect(fixture?.data.hash).toBeDefined();
    });

    it("should provide verification fixtures", () => {
      const fixture = getFixture("verify-success");
      expect(fixture).toBeDefined();
      expect(fixture?.data.verified).toBe(true);
    });

    it("should list all available fixtures", () => {
      const fixtures = listFixtures();
      expect(fixtures.length).toBeGreaterThan(0);
    });
  });

  describe("No Production Credentials Required", () => {
    it("should work without Stellar API key", () => {
      sandboxManager.initialize({ enabled: true, mockExternalServices: true });
      expect(sandboxManager.shouldMockServices()).toBe(true);
    });

    it("should work without verification service credentials", () => {
      sandboxManager.initialize({ enabled: true, mockExternalServices: true });
      expect(sandboxManager.shouldMockServices()).toBe(true);
    });
  });
});

describe("Soroban storage stubbing", () => {
  const entry = (overrides: Partial<StorageStubEntry> = {}): StorageStubEntry => ({
    id: "e1",
    contractId: STUB_CONTRACT_ID,
    storage: "persistent",
    key: "Reserve",
    keyType: "symbol",
    value: "2500000",
    valueType: "i128",
    ...overrides,
  });

  const decodeEntry = (base64: string) => xdr.LedgerEntryData.fromXDR(base64, "base64").contractData();

  beforeEach(() => {
    sandboxManager.reset();
    localStorage.clear();
  });

  describe("value conversion and validation", () => {
    it("converts every supported type to the matching ScVal", () => {
      expect(scValToNative(toStubScVal("true", "bool"))).toBe(true);
      expect(scValToNative(toStubScVal("7", "u32"))).toBe(7);
      expect(scValToNative(toStubScVal("-9", "i64"))).toBe(BigInt(-9));
      expect(scValToNative(toStubScVal("340282366920938463463374607431768211455", "u128"))).toBe(
        BigInt("340282366920938463463374607431768211455"),
      );
      expect(scValToNative(toStubScVal("Admin", "symbol"))).toBe("Admin");
      expect(scValToNative(toStubScVal(STUB_ADMIN_ADDRESS, "address"))).toBe(STUB_ADMIN_ADDRESS);
      expect(Buffer.from(scValToNative(toStubScVal("0xdead", "bytes"))).toString("hex")).toBe("dead");
      expect(Buffer.from(scValToNative(toStubScVal("", "bytes"))).toString("hex")).toBe("");
      expect(scValToNative(toStubScVal('{"limit":5}', "json"))).toEqual({ limit: BigInt(5) });
    });

    it("rejects malformed values with a field-tagged error", () => {
      expect(() => toStubScVal("-1", "u32")).toThrow(StorageStubError);
      expect(() => toStubScVal("4294967296", "u32")).toThrow(/out of range/);
      expect(() => toStubScVal("yes", "bool")).toThrow(/true/);
      expect(() => toStubScVal("has space", "symbol")).toThrow(/Symbols/);
      expect(() => toStubScVal("GBAD", "address")).toThrow(/Addresses/);
      expect(() => toStubScVal("abc", "bytes")).toThrow(/hex/);
      expect(() => toStubScVal("{", "json")).toThrow(/Invalid JSON/);
    });

    it("validates the contract id, key, value and TTL", () => {
      expect(validateStorageStub(entry())).toEqual([]);
      const fields = validateStorageStub(
        entry({ contractId: "nope", key: "bad key", value: "x", liveUntilLedger: 0 }),
      ).map((error) => error.field);
      expect(fields).toEqual(["contractId", "key", "value", "liveUntilLedger"]);
    });
  });

  describe("serialisation into mock RPC contract data", () => {
    it("emits one CONTRACT_DATA entry per persistent/temporary key with durability and TTL", () => {
      const response = serializeStorageStubs([
        entry(),
        entry({ id: "e2", storage: "temporary", key: "Nonce", value: "42", valueType: "u64", liveUntilLedger: 1_000_010 }),
      ]);
      expect(response.latestLedger).toBe(MOCK_LATEST_LEDGER);
      expect(response.entries).toHaveLength(2);

      const persistent = decodeEntry(response.entries[0].xdr);
      expect(persistent.durability().name).toBe("persistent");
      expect(scValToNative(persistent.key())).toBe("Reserve");
      expect(scValToNative(persistent.val())).toBe(BigInt(2500000));
      expect(response.entries[0].liveUntilLedgerSeq).toBeGreaterThan(MOCK_LATEST_LEDGER);

      const temporary = decodeEntry(response.entries[1].xdr);
      expect(temporary.durability().name).toBe("temporary");
      expect(response.entries[1].liveUntilLedgerSeq).toBe(1_000_010);
    });

    it("folds instance keys into a single sorted contract instance entry", () => {
      const response = serializeStorageStubs([
        entry({ id: "a", storage: "instance", key: "Paused", value: "true", valueType: "bool" }),
        entry({ id: "b", storage: "instance", key: "Admin", value: STUB_ADMIN_ADDRESS, valueType: "address" }),
      ]);
      expect(response.entries).toHaveLength(1);
      const data = decodeEntry(response.entries[0].xdr);
      expect(data.key().switch().name).toBe("scvLedgerKeyContractInstance");
      const storage = data.val().instance().storage() ?? [];
      expect(storage.map((item) => scValToNative(item.key()))).toEqual(["Admin", "Paused"]);
      expect(scValToNative(storage[1].val())).toBe(true);
    });

    it("produces ledger keys that match the RPC lookup key", () => {
      const [serialised] = serializeStorageStubs([entry()]).entries;
      expect(serialised.key).toBe(storageStubLedgerKey(entry()));
      const key = xdr.LedgerKey.fromXDR(serialised.key, "base64").contractData();
      expect(scValToNative(key.key())).toBe("Reserve");
    });

    it("throws a descriptive error for invalid stubs", () => {
      expect(() => serializeStorageStubs([entry({ value: "abc" })])).toThrow(/persistent key "Reserve"/);
    });

    it("reads stubbed values back as native values", () => {
      const stubs = [entry()];
      expect(readStubbedValue(stubs, { contractId: STUB_CONTRACT_ID, storage: "persistent", key: "Reserve" })).toBe(
        BigInt(2500000),
      );
      expect(readStubbedValue(stubs, { contractId: STUB_CONTRACT_ID, storage: "temporary", key: "Reserve" })).toBeUndefined();
    });
  });

  describe("sandbox injection", () => {
    it("serves injected stubs from the mock RPC adapter", async () => {
      sandboxManager.setStorageStubs(instantiatePreset(BUILT_IN_STORAGE_PRESETS[0]));
      expect(sandboxManager.getSnapshot().storage).toEqual({
        size: 2,
        byType: { instance: 2, persistent: 0, temporary: 0 },
      });

      const all = await MockStellarAdapter.getLedgerEntries();
      expect(all.success).toBe(true);
      expect(all.data?.entries).toHaveLength(1);

      const paused = await MockStellarAdapter.getContractData(STUB_CONTRACT_ID, "Paused", "instance");
      expect(paused.data).toEqual({ value: true });
      const missing = await MockStellarAdapter.getContractData(STUB_CONTRACT_ID, "Nope", "instance");
      expect(missing.data).toBeNull();
    });

    it("filters getLedgerEntries by requested keys", async () => {
      sandboxManager.setStorageStubs([entry(), entry({ id: "e2", key: "MinReserve" })]);
      const wanted = storageStubLedgerKey(entry({ key: "MinReserve" }));
      const response = await MockStellarAdapter.getLedgerEntries([wanted, "unknown-key"]);
      expect(response.data?.entries.map((e) => e.key)).toEqual([wanted]);
    });

    it("reports invalid injected stubs as an RPC error instead of throwing", async () => {
      sandboxManager.setStorageStubs([entry({ value: "not-a-number" })]);
      const response = await MockStellarAdapter.getLedgerEntries();
      expect(response).toMatchObject({ success: false, code: "INVALID_STORAGE_STUB", httpStatus: 400 });
    });

    it("clears stubs on reset", () => {
      sandboxManager.setStorageStubs([entry()]);
      MockStellarAdapter.reset();
      expect(sandboxManager.hasStorageStubs()).toBe(false);
      sandboxManager.setStorageStubs([entry()]);
      sandboxManager.reset();
      expect(sandboxManager.getSnapshot().storage).toBeNull();
    });
  });

  describe("presets and fixtures", () => {
    it("ships built-in presets that all serialise cleanly", () => {
      expect(BUILT_IN_STORAGE_PRESETS.map((p) => p.id)).toEqual(
        expect.arrayContaining(["paused-contract", "custom-admin", "low-reserve", "expiring-session"]),
      );
      for (const preset of BUILT_IN_STORAGE_PRESETS) {
        expect(() => serializeStorageStubs(preset.entries)).not.toThrow();
      }
    });

    it("instantiates presets with fresh ids", () => {
      const copy = instantiatePreset(BUILT_IN_STORAGE_PRESETS[0]);
      expect(copy[0].id).not.toBe(BUILT_IN_STORAGE_PRESETS[0].entries[0].id);
      expect(copy[0].key).toBe(BUILT_IN_STORAGE_PRESETS[0].entries[0].key);
    });

    it("saves, replaces, loads and deletes custom presets", () => {
      saveStoragePreset("Drained", [entry()]);
      const saved = saveStoragePreset("Drained", [entry({ value: "1" })]);
      expect(saved).toHaveLength(1);
      expect(loadSavedStoragePresets()[0].entries[0].value).toBe("1");
      expect(deleteStoragePreset(saved[0].id)).toEqual([]);
      expect(() => saveStoragePreset("  ", [entry()])).toThrow(/name/);
    });

    it("ignores corrupt saved preset data", () => {
      localStorage.setItem(STORAGE_PRESETS_STORAGE_KEY, "{not json");
      expect(loadSavedStoragePresets()).toEqual([]);
    });

    it("round-trips stubs through a shareable JSON fixture", () => {
      const stubs = [entry(), entry({ id: "t", storage: "temporary", key: "Nonce", value: "1", valueType: "u64", liveUntilLedger: 5 })];
      const json = exportStorageFixture("Low reserve", stubs, "shared");
      const parsed = JSON.parse(json);
      expect(parsed).toMatchObject({ kind: "trellis.soroban-storage-stubs", version: 1, name: "Low reserve" });
      expect(parsed.entries[0].id).toBeUndefined();

      const imported = importStorageFixture(json);
      expect(imported.name).toBe("Low reserve");
      expect(imported.description).toBe("shared");
      expect(imported.entries.map(({ id: _id, ...rest }) => rest)).toEqual(stubs.map(({ id: _id, ...rest }) => rest));
    });

    it("rejects malformed fixtures", () => {
      expect(() => importStorageFixture("nope")).toThrow(/valid JSON/);
      expect(() => importStorageFixture(JSON.stringify({ kind: "other", version: 1, entries: [] }))).toThrow(/kind/);
      expect(() =>
        importStorageFixture(JSON.stringify({ kind: "trellis.soroban-storage-stubs", version: 9, entries: [] })),
      ).toThrow(/version/);
      expect(() =>
        importStorageFixture(
          JSON.stringify({
            kind: "trellis.soroban-storage-stubs",
            version: 1,
            entries: [{ contractId: STUB_CONTRACT_ID, storage: "persistent", key: "K", keyType: "symbol", value: "x", valueType: "u32" }],
          }),
        ),
      ).toThrow(/Entry 1/);
    });
  });
});
