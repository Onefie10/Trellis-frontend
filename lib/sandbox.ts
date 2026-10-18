/**
 * Sandbox Mode Configuration
 *
 * Provides safe integration testing without production dependencies,
 * real wallets, or irreversible records.
 *
 * Beyond the enable/mode flags, the manager owns the injected sandbox state so
 * every mock adapter reads from one place:
 *
 *   - the generated mock wallet (`lib/sandbox-wallet`)
 *   - the active failure preset (`lib/sandbox-scenarios`)
 *   - the recorder + replay adapter (`lib/sandbox-replay`)
 *   - stubbed Soroban contract storage (`lib/sandbox-storage`)
 *
 * Keeping them here means `reset()` genuinely resets the sandbox, which is what
 * test suites and the UI both expect.
 */

import type { MockBalance, MockWalletState } from "./sandbox-wallet";
import type { SandboxScenarioId } from "./sandbox-scenarios";
import type { ScenarioRecorder, TransactionReplayAdapter } from "./sandbox-replay";
import type { SorobanStorageType, StorageStubEntry } from "./sandbox-storage";

export type SandboxMode = "disabled" | "enabled" | "mock_only";

export interface SandboxConfig {
  enabled: boolean;
  mode: SandboxMode;
  mockExternalServices: boolean;
  useFakeData: boolean;
  preventNetworkCalls: boolean;
  logRequests: boolean;
}

/** Flat, render-friendly view of the current sandbox state. */
export interface SandboxStatusSnapshot {
  mode: SandboxMode;
  enabled: boolean;
  activeScenarioId: SandboxScenarioId | null;
  wallet: {
    id: string;
    label: string;
    publicKey: string;
    network: string;
    balanceCount: number;
    belowMinimum: boolean;
  } | null;
  recorder: {
    id: string;
    name: string;
    recording: boolean;
    size: number;
  } | null;
  replay: {
    tapeId: string;
    tapeName: string;
    size: number;
    position: number;
    strategy: string;
  } | null;
  storage: {
    size: number;
    byType: Record<SorobanStorageType, number>;
  } | null;
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: false,
  mode: "disabled",
  mockExternalServices: false,
  useFakeData: false,
  preventNetworkCalls: false,
  logRequests: false,
};

class SandboxManager {
  private config: SandboxConfig = { ...DEFAULT_CONFIG };
  private walletState: MockWalletState | null = null;
  private activeScenarioId: SandboxScenarioId | null = null;
  private replayAdapter: TransactionReplayAdapter | null = null;
  private recorder: ScenarioRecorder | null = null;
  private storageStubs: StorageStubEntry[] = [];
  private listeners = new Set<() => void>();

  initialize(overrides?: Partial<SandboxConfig>): void {
    const envMode = process.env.NEXT_PUBLIC_SANDBOX_MODE as SandboxMode | undefined;
    if (envMode) {
      this.config.mode = envMode;
      this.config.enabled = envMode !== "disabled";
      this.config.mockExternalServices = envMode !== "disabled";
      this.config.useFakeData = envMode !== "disabled";
    }

    if (overrides) {
      const { mode, enabled, ...rest } = overrides;
      this.config = { ...this.config, ...rest };

      // `mode` and `enabled` are two views of the same switch. Previously
      // `initialize({ enabled: true })` left `mode` at "disabled", so
      // `isEnabled()` stayed false and the overrides looked ignored.
      if (mode !== undefined) {
        this.config.mode = mode;
        this.config.enabled = mode !== "disabled";
        if (overrides.mockExternalServices === undefined) {
          this.config.mockExternalServices = mode !== "disabled";
        }
        if (overrides.useFakeData === undefined) {
          this.config.useFakeData = mode !== "disabled";
        }
      } else if (enabled !== undefined) {
        this.config.enabled = enabled;
        if (enabled && this.config.mode === "disabled") {
          this.config.mode = "enabled";
        }
      }
    }

    this.emit();
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  isEnabled(): boolean {
    return this.config.enabled && this.config.mode !== "disabled";
  }

  isMockOnly(): boolean {
    return this.config.mode === "mock_only";
  }

  shouldMockServices(): boolean {
    return this.config.mockExternalServices && this.isEnabled();
  }

  shouldUseFakeData(): boolean {
    return this.config.useFakeData && this.isEnabled();
  }

  shouldPreventNetworkCalls(): boolean {
    return this.config.preventNetworkCalls && this.isEnabled();
  }

  shouldLogRequests(): boolean {
    return this.config.logRequests;
  }

  log(...args: unknown[]): void {
    if (this.shouldLogRequests()) {
      console.log("[SANDBOX]", ...args);
    }
  }

  /* ---------------------------------------------------------------- *
   * Injected mock wallet
   * ---------------------------------------------------------------- */

  setWalletState(state: MockWalletState | null): MockWalletState | null {
    this.walletState = state;
    this.emit();
    return this.walletState;
  }

  getWalletState(): MockWalletState | null {
    return this.walletState;
  }

  hasWalletState(): boolean {
    return this.walletState !== null;
  }

  clearWalletState(): void {
    this.setWalletState(null);
  }

  /** Balances of the injected wallet, or an empty list when none is set. */
  getInjectedBalances(): MockBalance[] {
    return this.walletState ? [...this.walletState.balances] : [];
  }

  /* ---------------------------------------------------------------- *
   * Active failure preset
   * ---------------------------------------------------------------- */

  setActiveScenario(id: SandboxScenarioId | null): SandboxScenarioId | null {
    this.activeScenarioId = id;
    this.emit();
    return this.activeScenarioId;
  }

  getActiveScenarioId(): SandboxScenarioId | null {
    return this.activeScenarioId;
  }

  hasActiveScenario(): boolean {
    return this.activeScenarioId !== null;
  }

  clearActiveScenario(): void {
    this.setActiveScenario(null);
  }

  /* ---------------------------------------------------------------- *
   * Soroban storage stubs
   * ---------------------------------------------------------------- */

  setStorageStubs(entries: readonly StorageStubEntry[]): StorageStubEntry[] {
    this.storageStubs = entries.map((entry) => ({ ...entry }));
    this.emit();
    return this.getStorageStubs();
  }

  getStorageStubs(): StorageStubEntry[] {
    return this.storageStubs.map((entry) => ({ ...entry }));
  }

  hasStorageStubs(): boolean {
    return this.storageStubs.length > 0;
  }

  clearStorageStubs(): void {
    this.setStorageStubs([]);
  }

  /* ---------------------------------------------------------------- *
   * Recorder + replay
   * ---------------------------------------------------------------- */

  setRecorder(recorder: ScenarioRecorder | null): ScenarioRecorder | null {
    this.recorder = recorder;
    this.emit();
    return this.recorder;
  }

  getRecorder(): ScenarioRecorder | null {
    return this.recorder;
  }

  setReplayAdapter(adapter: TransactionReplayAdapter | null): TransactionReplayAdapter | null {
    this.replayAdapter = adapter;
    this.emit();
    return this.replayAdapter;
  }

  getReplayAdapter(): TransactionReplayAdapter | null {
    return this.replayAdapter;
  }

  /* ---------------------------------------------------------------- *
   * Introspection + change notification
   * ---------------------------------------------------------------- */

  /**
   * Subscribes to sandbox state changes.
   *
   * Returns an unsubscribe function. Listeners are notified after every mutation
   * including `reset()`, so React consumers can re-read the injected state.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SandboxStatusSnapshot {
    const wallet = this.walletState;
    const recorder = this.recorder;
    const adapter = this.replayAdapter;

    return {
      mode: this.config.mode,
      enabled: this.isEnabled(),
      activeScenarioId: this.activeScenarioId,
      wallet: wallet
        ? {
            id: wallet.id,
            label: wallet.label,
            publicKey: wallet.publicKey,
            network: wallet.network,
            balanceCount: wallet.balances.length,
            belowMinimum: wallet.reserve.belowMinimum,
          }
        : null,
      recorder: recorder
        ? { id: recorder.id, name: recorder.name, recording: recorder.isRecording, size: recorder.size }
        : null,
      replay: adapter
        ? {
            tapeId: adapter.getTape().id,
            tapeName: adapter.getTape().name,
            size: adapter.tapeSize,
            position: adapter.position,
            strategy: adapter.getPolicy().strategy,
          }
        : null,
      storage: this.storageStubs.length
        ? {
            size: this.storageStubs.length,
            byType: this.storageStubs.reduce<Record<SorobanStorageType, number>>(
              (counts, entry) => {
                counts[entry.storage] += 1;
                return counts;
              },
              { instance: 0, persistent: 0, temporary: 0 },
            ),
          }
        : null,
    };
  }

  /** Clears configuration *and* every piece of injected sandbox state. */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.walletState = null;
    this.activeScenarioId = null;
    this.replayAdapter = null;
    this.recorder = null;
    this.storageStubs = [];
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not break sandbox state management.
      }
    }
  }
}

export const sandboxManager = new SandboxManager();
