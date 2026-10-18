/**
 * Fake External Service Adapters
 *
 * Provides deterministic mock responses for external services.
 *
 * Every adapter reads the injected sandbox state from `sandboxManager`, so a
 * generated mock wallet, an active failure preset and a replay tape all take
 * effect here without the caller threading extra arguments through the UI.
 * When nothing is injected the responses are the same fixed values as before.
 */

import { sandboxManager } from "./sandbox";
import { getFixture } from "./sandbox-fixtures";
import { findScenario } from "./sandbox-scenarios";
import {
  readStubbedValue,
  serializeStorageStubs,
  type MockGetLedgerEntriesResponse,
  type SorobanStorageType,
  type StorageScValType,
} from "./sandbox-storage";
import {
  findBalance,
  fromStroops,
  toStroops,
  walletNativeBalance,
  walletToBalances,
  type MockWalletState,
} from "./sandbox-wallet";
import {
  scenarioToResponse,
  type ReplayableMethod,
  type SandboxResponse,
  type TransactionReplayAdapter,
} from "./sandbox-replay";

export interface ServiceResponse<T = unknown> {
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
  /** Mock result envelope (see `scenarioResultXdr`). */
  resultXdr?: string;
  /** Failure preset this response was generated from, when applicable. */
  scenarioId?: string;
}

interface ReplayableAdapter {
  replay<T = unknown>(method: ReplayableMethod, request: unknown): Promise<SandboxResponse<T>>;
}

/** Default native balance, taken from the wallet fixture so both stay in sync. */
function defaultNativeBalance(): string {
  const fixture = getFixture("wallet-success");
  const balances = (fixture?.data?.balances as Array<{ asset: string; balance: string }> | undefined) ?? [];
  const native = balances.find((b) => b.asset === "native");
  return native ? fromStroops(toStroops(native.balance)) : "1000.0000000";
}

/** Default non-native balances for the no-wallet-injected case. */
function defaultBalances() {
  const fixture = getFixture("wallet-success");
  const balances = (fixture?.data?.balances as Array<{ asset: string; balance: string }> | undefined) ?? [];
  return balances.map((b) => ({
    asset: b.asset,
    balance: fromStroops(toStroops(b.balance)),
    assetCode: b.asset === "native" ? undefined : b.asset,
  }));
}

function resolveReplayAdapter(): TransactionReplayAdapter | null {
  return sandboxManager.getReplayAdapter();
}

/**
 * Mock Stellar RPC Adapter
 */
export class MockStellarAdapter {
  /** Wallet injected via the balance generator, if any. */
  static getInjectedWallet(): MockWalletState | null {
    return sandboxManager.getWalletState();
  }

  static async getBalance(
    publicKey: string,
  ): Promise<ServiceResponse<{ balance: string; asset?: string }>> {
    sandboxManager.log("MockStellarAdapter.getBalance", publicKey);

    if (!publicKey.startsWith("G")) {
      return {
        success: false,
        error: "Invalid public key",
        timestamp: Date.now(),
        code: "INVALID_PUBLIC_KEY",
        httpStatus: 400,
      };
    }

    const wallet = sandboxManager.getWalletState();
    if (wallet) {
      const native = walletNativeBalance(wallet);
      return {
        success: true,
        data: { balance: native.balance, asset: "native" },
        timestamp: Date.now(),
      };
    }

    return {
      success: true,
      data: { balance: defaultNativeBalance(), asset: "native" },
      timestamp: Date.now(),
    };
  }

  /** Full balance list — native first, then every injected trustline. */
  static async getBalances(
    publicKey: string,
  ): Promise<ServiceResponse<{ balances: Array<{ asset: string; balance: string; assetCode?: string; assetIssuer?: string }> }>> {
    sandboxManager.log("MockStellarAdapter.getBalances", publicKey);

    if (!publicKey.startsWith("G")) {
      return {
        success: false,
        error: "Invalid public key",
        timestamp: Date.now(),
        code: "INVALID_PUBLIC_KEY",
        httpStatus: 400,
      };
    }

    const wallet = sandboxManager.getWalletState();
    return {
      success: true,
      data: { balances: wallet ? walletToBalances(wallet) : defaultBalances() },
      timestamp: Date.now(),
    };
  }

  /** Balance of one asset from the injected wallet. */
  static async getAssetBalance(
    publicKey: string,
    asset: string,
  ): Promise<ServiceResponse<{ asset: string; balance: string; limit?: string }>> {
    sandboxManager.log("MockStellarAdapter.getAssetBalance", publicKey, asset);

    const wallet = sandboxManager.getWalletState();
    if (!wallet) {
      return {
        success: true,
        data: { asset, balance: defaultNativeBalance() },
        timestamp: Date.now(),
      };
    }

    const entry = findBalance(wallet, asset);
    if (!entry) {
      return {
        success: false,
        error: `Asset ${asset} is not present in the injected sandbox wallet`,
        timestamp: Date.now(),
        code: "MISSING_TRUSTLINE",
        httpStatus: 400,
      };
    }

    return {
      success: true,
      data: { asset: entry.key, balance: entry.balance, limit: entry.limit },
      timestamp: Date.now(),
    };
  }

  static async submitTransaction(txn: unknown): Promise<ServiceResponse<{ hash: string }>> {
    sandboxManager.log("MockStellarAdapter.submitTransaction", txn);

    const preset = MockStellarAdapter.presetResponse("submitTransaction", txn);
    if (preset) return preset as ServiceResponse<{ hash: string }>;

    const adapter = resolveReplayAdapter();
    if (adapter) {
      return (await adapter.replay("submitTransaction", txn)) as ServiceResponse<{ hash: string }>;
    }

    return {
      success: true,
      data: { hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
      timestamp: Date.now(),
    };
  }

  static async getTransactionStatus(
    hash: string,
  ): Promise<ServiceResponse<{ status: string }>> {
    sandboxManager.log("MockStellarAdapter.getTransactionStatus", hash);

    const preset = MockStellarAdapter.presetResponse("getTransactionStatus", hash);
    if (preset) return preset as ServiceResponse<{ status: string }>;

    const adapter = resolveReplayAdapter();
    if (adapter) {
      return (await adapter.replay("getTransactionStatus", hash)) as ServiceResponse<{ status: string }>;
    }

    return {
      success: true,
      data: { status: "confirmed" },
      timestamp: Date.now(),
    };
  }

  /** Mock fee/resource simulation, honouring the active preset and tape. */
  static async simulateTransaction(
    txn: unknown,
  ): Promise<ServiceResponse<{ minResourceFee: string; cpuInstructions: number; readBytes: number }>> {
    sandboxManager.log("MockStellarAdapter.simulateTransaction", txn);

    const preset = MockStellarAdapter.presetResponse("simulateTransaction", txn);
    if (preset) {
      return preset as ServiceResponse<{ minResourceFee: string; cpuInstructions: number; readBytes: number }>;
    }

    const adapter = resolveReplayAdapter();
    if (adapter) {
      return (await adapter.replay("simulateTransaction", txn)) as ServiceResponse<{
        minResourceFee: string;
        cpuInstructions: number;
        readBytes: number;
      }>;
    }

    return {
      success: true,
      data: { minResourceFee: "100", cpuInstructions: 1_200_000, readBytes: 4096 },
      timestamp: Date.now(),
    };
  }

  /**
   * Mock Soroban RPC `getLedgerEntries` backed by the injected storage stubs.
   * Pass no keys to receive every stubbed entry; unknown keys are omitted,
   * exactly as the real RPC does for entries that do not exist.
   */
  static async getLedgerEntries(
    keys?: readonly string[],
  ): Promise<ServiceResponse<MockGetLedgerEntriesResponse>> {
    sandboxManager.log("MockStellarAdapter.getLedgerEntries", keys);

    try {
      const response = serializeStorageStubs(sandboxManager.getStorageStubs());
      const wanted = keys ? new Set(keys) : null;
      return {
        success: true,
        data: {
          ...response,
          entries: wanted ? response.entries.filter((entry) => wanted.has(entry.key)) : response.entries,
        },
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        code: "INVALID_STORAGE_STUB",
        httpStatus: 400,
      };
    }
  }

  /** Decoded value of one stubbed storage key, or `null` data when absent. */
  static async getContractData(
    contractId: string,
    key: string,
    storage: SorobanStorageType = "persistent",
    keyType?: StorageScValType,
  ): Promise<ServiceResponse<{ value: unknown } | null>> {
    sandboxManager.log("MockStellarAdapter.getContractData", contractId, key, storage);

    try {
      const value = readStubbedValue(sandboxManager.getStorageStubs(), { contractId, key, storage, keyType });
      return {
        success: true,
        data: value === undefined ? null : { value },
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        code: "INVALID_STORAGE_STUB",
        httpStatus: 400,
      };
    }
  }

  /** Clears injected wallet + preset + tape + storage stubs in one call. */
  static reset(): void {
    sandboxManager.clearStorageStubs();
    sandboxManager.clearWalletState();
    sandboxManager.clearActiveScenario();
    sandboxManager.setReplayAdapter(null);
  }

  /**
   * Maps the active failure preset onto a response for `method`.
   *
   * Presets are transaction-oriented, so `getBalance`/`getBalances` are
   * deliberately left alone — a stale balance read is not a useful failure case.
   */
  private static presetResponse(
    method: ReplayableMethod,
    request: unknown,
  ): ServiceResponse | null {
    const scenarioId = sandboxManager.getActiveScenarioId();
    if (!scenarioId) return null;

    const scenario = findScenario(scenarioId);
    if (!scenario) return null;

    // Rate limiting and timeouts are transport-level: the request never reaches
    // the chain, so the response carries no result envelope.
    const isTransport = scenario.category === "network";
    const response = scenarioToResponse(scenarioId);

    sandboxManager.log("MockStellarAdapter.preset", method, request, scenarioId);

    return {
      ...response,
      data: isTransport ? undefined : { ...(response.data as object), method },
      resultXdr: isTransport ? undefined : response.resultXdr,
    };
  }
}

/**
 * Builds a replay adapter for a caller-supplied tape.
 *
 * Kept here so UI code never has to import the replay engine directly.
 */
export function createReplayAdapter(
  adapter: TransactionReplayAdapter,
): TransactionReplayAdapter {
  return sandboxManager.setReplayAdapter(adapter) as TransactionReplayAdapter;
}

/** Convenience guard: is a replay tape currently driving the adapters? */
export function hasReplayAdapter(): boolean {
  return resolveReplayAdapter() !== null;
}

/** Exposed for tests and the UI: the adapter currently in effect. */
export function activeReplayAdapter(): ReplayableAdapter | null {
  return resolveReplayAdapter();
}

/**
 * Mock Verification Service Adapter
 */
export class MockVerificationAdapter {
  static async verify(data: unknown): Promise<ServiceResponse<{ verified: boolean }>> {
    sandboxManager.log("MockVerificationAdapter.verify", data);

    return {
      success: true,
      data: { verified: true },
      timestamp: Date.now(),
    };
  }

  static async checkStatus(userId: string): Promise<ServiceResponse<{ level: string }>> {
    sandboxManager.log("MockVerificationAdapter.checkStatus", userId);

    return {
      success: true,
      data: { level: "standard" },
      timestamp: Date.now(),
    };
  }
}

/**
 * Mock IPFS Adapter
 */
export class MockIPFSAdapter {
  static async upload(data: unknown): Promise<ServiceResponse<{ hash: string }>> {
    sandboxManager.log("MockIPFSAdapter.upload", data);

    return {
      success: true,
      data: { hash: "QmX5kkqbvJ5vY5K5v5kK5v5kK5v5kK5v5kK5v5kK5v5kK" },
      timestamp: Date.now(),
    };
  }

  static async retrieve(hash: string): Promise<ServiceResponse<{ content: unknown }>> {
    sandboxManager.log("MockIPFSAdapter.retrieve", hash);

    return {
      success: true,
      data: { content: {} },
      timestamp: Date.now(),
    };
  }
}

/**
 * Get adapter based on sandbox configuration
 */
export function getStellarAdapter() {
  if (sandboxManager.shouldMockServices()) {
    return MockStellarAdapter;
  }
  // Return real adapter
  return MockStellarAdapter; // Fallback for demo
}

export function getVerificationAdapter() {
  if (sandboxManager.shouldMockServices()) {
    return MockVerificationAdapter;
  }
  return MockVerificationAdapter;
}

export function getIPFSAdapter() {
  if (sandboxManager.shouldMockServices()) {
    return MockIPFSAdapter;
  }
  return MockIPFSAdapter;
}
