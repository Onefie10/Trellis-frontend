import * as StellarSdk from "@stellar/stellar-sdk";
import { StellarNetwork } from "../types";
import { STELLAR_NETWORKS } from "../stellar-constants";
import {
  DecodedSorobanEvent,
  decodeContractEvent,
} from "./xdr-decode";
import {
  SorobanEventSyncWorker,
  StorageLike,
  liveEventKey,
} from "./event-sync";

/**
 * Utility to subscribe to contract events via Horizon, decoding Soroban events
 * into typed JS objects and back-filling the window missed while disconnected.
 */
export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** 0 means "retry forever". */
  maxAttempts?: number;
}

export interface SorobanEventManagerOptions {
  /** Soroban RPC URL; defaults to the network config. */
  rpcUrl?: string;
  /** Storage for the missed-event cursor; defaults to `window.localStorage`. */
  storage?: StorageLike | null;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
  reconnect?: ReconnectOptions;
}

export interface SubscribeToContractEventsOptions {
  /**
   * Query missed events from Soroban RPC before/after each (re)connect.
   * Defaults to `true`; pass `false` for a purely live subscription.
   */
  catchUp?: boolean;
  /** Called when a catch-up pass fails; the live stream still starts. */
  onCatchUpError?: (error: unknown) => void;
  /** Called when a stream error could not be recovered from. */
  onReconnectExhausted?: (error: unknown) => void;
}

interface SubscriptionState {
  stopped: boolean;
  attempts: number;
  closeStream: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  maxAttempts: 10,
};

export class SorobanEventManager {
  private server: StellarSdk.Horizon.Server;
  private readonly options: SorobanEventManagerOptions;
  private readonly subscriptions = new Map<string, SubscriptionState>();

  constructor(
    private readonly network: StellarNetwork,
    options: SorobanEventManagerOptions = {},
  ) {
    this.server = new StellarSdk.Horizon.Server(STELLAR_NETWORKS[network].horizonUrl);
    this.options = options;
  }

  /**
   * Create the catch-up worker for a contract. Also usable on its own when a
   * caller wants to backfill without opening a stream.
   */
  createSyncWorker(contractId: string): SorobanEventSyncWorker {
    return new SorobanEventSyncWorker(this.network, contractId, {
      rpcUrl: this.options.rpcUrl,
      storage: this.options.storage,
      pageSize: this.options.pageSize,
      maxPages: this.options.maxPages,
      fetchImpl: this.options.fetchImpl,
    });
  }

  /** Fetch + decode every event emitted since the persisted cursor. */
  async catchUpMissedEvents(
    contractId: string,
    onEvent?: (event: DecodedSorobanEvent) => void,
  ): Promise<DecodedSorobanEvent[]> {
    return this.createSyncWorker(contractId).catchUp({ onEvent });
  }

  /**
   * Listen for events on a specific contract.
   *
   * On subscribe (and after every reconnect) the missed-event worker queries
   * `getEvents` from the last persisted cursor, so events emitted while the tab
   * was offline are delivered in order instead of being silently dropped.
   * Returns an unsubscribe function.
   */
  subscribeToContractEvents(
    contractId: string,
    onEvent: (event: DecodedSorobanEvent) => void,
    options: SubscribeToContractEventsOptions = {},
  ): () => void {
    this.closeSubscription(contractId);

    const state: SubscriptionState = {
      stopped: false,
      attempts: 0,
      closeStream: null,
      timer: null,
    };
    this.subscriptions.set(contractId, state);

    const worker = this.createSyncWorker(contractId);
    const reconnect = { ...DEFAULT_RECONNECT, ...(this.options.reconnect ?? {}) };

    const emit = (event: DecodedSorobanEvent) => {
      try {
        onEvent(event);
      } catch (error) {
        // A consumer error must not tear down the stream for everyone else.
        console.error("Soroban event handler threw:", error);
      }
    };

    const scheduleReconnect = (error: unknown) => {
      if (state.stopped) {
        return;
      }

      state.attempts += 1;

      if (reconnect.maxAttempts > 0 && state.attempts > reconnect.maxAttempts) {
        options.onReconnectExhausted?.(error);
        this.closeSubscription(contractId);
        return;
      }

      const delay = Math.min(
        reconnect.initialDelayMs * reconnect.factor ** (state.attempts - 1),
        reconnect.maxDelayMs,
      );

      state.timer = setTimeout(() => {
        state.timer = null;
        void start();
      }, delay);
    };

    const start = async () => {
      if (state.stopped) {
        return;
      }

      if (options.catchUp !== false) {
        try {
          await worker.catchUp({ onEvent: emit });
        } catch (error) {
          // Catch-up is best-effort: a failing RPC must not stop live events.
          options.onCatchUpError?.(error);
          console.error("Soroban missed-event catch-up failed:", error);
        }
      }

      if (state.stopped) {
        return;
      }

      state.closeStream = this.openStream(contractId, emit, worker, (error) => {
        state.closeStream = null;

        if (error) {
          console.error("Event stream error, reconnecting:", error);
        }

        if (!state.stopped) {
          scheduleReconnect(error);
        }
      });
    };

    void start();

    return () => this.closeSubscription(contractId);
  }

  /** Tear down the subscription for a contract (stream + pending reconnect). */
  closeSubscription(contractId: string): void {
    const state = this.subscriptions.get(contractId);

    if (!state) {
      return;
    }

    state.stopped = true;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    state.closeStream?.();
    state.closeStream = null;
    this.subscriptions.delete(contractId);
  }

  /** Tear down every subscription. */
  closeAll(): void {
    for (const contractId of [...this.subscriptions.keys()]) {
      this.closeSubscription(contractId);
    }
  }

  private openStream(
    contractId: string,
    emit: (event: DecodedSorobanEvent) => void,
    worker: SorobanEventSyncWorker,
    onClose: (error?: unknown) => void,
  ): () => void {
    let closeStream: (() => void) | null = null;

    const shutdown = (error?: unknown) => {
      const close = closeStream;
      closeStream = null;

      try {
        close?.();
      } catch {
        // Already closed.
      }

      onClose(error);
    };

    try {
      closeStream = this.server
        .transactions()
        .forAccount(contractId) // Soroban contracts are also accounts
        .cursor("now")
        .stream({
          onmessage: (tx: any) => {
            this.handleTransactionMessage(tx, contractId, emit, worker);
          },
          onerror: (err: any) => {
            // Horizon keeps a broken stream open; close it before rescheduling
            // so a reconnect never leaves two streams on the same contract.
            shutdown(err);
          },
        });

      return () => {
        const close = closeStream;
        closeStream = null;

        try {
          close?.();
        } catch {
          // Already closed.
        }
      };
    } catch (error) {
      // A synchronous stream() failure (bad account, network config) still has
      // to go through the reconnect scheduler.
      onClose(error);
      return () => undefined;
    }
  }

  /** Decode the Soroban events carried by one Horizon transaction message. */
  private handleTransactionMessage(
    tx: any,
    contractId: string,
    emit: (event: DecodedSorobanEvent) => void,
    worker: SorobanEventSyncWorker,
  ): void {
    if (!tx?.result_meta_xdr) {
      return;
    }

    const ledger = Number(tx.ledger_attr ?? tx.ledger ?? 0) || null;
    const txHash: string | null = tx.hash ?? null;

    try {
      const meta = StellarSdk.xdr.TransactionMeta.fromXDR(tx.result_meta_xdr, "base64");
      const v3 = (meta as any).v3?.();

      if (!v3 || !v3.sorobanMeta()) {
        return;
      }

      const events = v3.sorobanMeta().events() || [];

      events.forEach((e: any, index: number) => {
        if (e.type().name !== "CONTRACT") {
          return;
        }

        const contractEvent = e.contractEvent();

        if (!contractEvent) {
          return;
        }

        const decoded = decodeContractEvent({
          contractId,
          topics: contractEvent.topics() ?? [],
          data: contractEvent.data(),
          id: txHash ? `live:${ledger}:${txHash}:${index}` : null,
          ledger,
          txHash,
          inSuccessfulContractCall: true,
        });

        // Remember that this transaction was delivered live so a later catch-up
        // pass does not emit the same events again.
        const key = liveEventKey(ledger, txHash);

        if (key) {
          worker.cursor.markProcessed([key, decoded.id ?? ""], ledger);
        }

        emit(decoded);
      });
    } catch (e) {
      console.error("Error parsing Soroban events from transaction:", e);
    }
  }
}
