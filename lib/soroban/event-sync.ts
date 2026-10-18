import { StellarNetwork } from "../types";
import { STELLAR_NETWORKS } from "../stellar-constants";
import {
  DecodedSorobanEvent,
  decodeRawRpcEvent,
} from "./xdr-decode";

/**
 * Missed-event catch-up for Soroban contract event streams.
 *
 * A websocket stream (`lib/soroban/events.ts`) only delivers events from the
 * moment it connects: anything emitted while the tab was backgrounded, or while
 * the stream was reconnecting, is lost and the UI silently drifts out of sync.
 * This module queries the Soroban RPC `getEvents` endpoint for the window the
 * client missed and de-duplicates events against a cursor persisted in local
 * storage, so the same event is never processed twice.
 */

/** The subset of the Web Storage API this module needs (mockable in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EventCursorState {
  /** RPC paging token to resume from; `null` means "resume from lastLedger". */
  cursor: string | null;
  /** Highest ledger whose events have been processed. */
  lastLedger: number;
  /** Recent event ids, newest last, bounded by MAX_PROCESSED_IDS. */
  processedIds: string[];
}

/** Bounded so the cursor payload cannot grow without limit. */
export const MAX_PROCESSED_IDS = 500;

export function eventCursorKey(network: StellarNetwork, contractId: string): string {
  return `soroban:event-cursor:${network}:${contractId}`;
}

/**
 * De-duplication key shared by the streaming and catch-up paths.
 *
 * The RPC and the streaming paths identify an event differently (paging token
 * vs. transaction hash), but both know the ledger and transaction hash, so a
 * transaction already delivered by the stream is skipped by catch-up instead of
 * being emitted twice.
 */
export function liveEventKey(ledger: number | string | null, txHash: string | null): string | null {
  if (ledger === null || ledger === undefined || !txHash) {
    return null;
  }

  return `live:${ledger}:${txHash}`;
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) {
    return storage;
  }

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Access can throw in private/embedded contexts; degrade to memory-only.
  }

  return null;
}

/**
 * Persisted read/write cursor for one (network, contract) pair.
 *
 * Every mutation writes through to storage, so a page reload or a reconnect
 * resumes exactly where the previous session stopped.
 */
export class SorobanEventCursor {
  private state: EventCursorState;

  constructor(
    private readonly network: StellarNetwork,
    private readonly contractId: string,
    private readonly storage: StorageLike | null = resolveStorage(),
  ) {
    this.state = this.read();
  }

  private get storageKey(): string {
    return eventCursorKey(this.network, this.contractId);
  }

  private read(): EventCursorState {
    const raw = this.storage?.getItem(this.storageKey);

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<EventCursorState>;
        return {
          cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
          lastLedger: Number.isFinite(parsed.lastLedger) ? Number(parsed.lastLedger) : 0,
          processedIds: Array.isArray(parsed.processedIds)
            ? parsed.processedIds.filter((id): id is string => typeof id === "string")
            : [],
        };
      } catch {
        // Corrupt payload: start over rather than block the stream forever.
      }
    }

    return { cursor: null, lastLedger: 0, processedIds: [] };
  }

  snapshot(): EventCursorState {
    return { ...this.state, processedIds: [...this.state.processedIds] };
  }

  hasProcessed(id: string): boolean {
    return this.state.processedIds.includes(id);
  }

  /** Record ids that were processed (and optionally seen) without touching the cursor. */
  markProcessed(ids: readonly string[], ledger?: number | null): void {
    for (const id of ids) {
      if (id && !this.state.processedIds.includes(id)) {
        this.state.processedIds.push(id);
      }
    }

    if (this.state.processedIds.length > MAX_PROCESSED_IDS) {
      this.state.processedIds = this.state.processedIds.slice(-MAX_PROCESSED_IDS);
    }

    this.advanceLedger(ledger);
    this.persist();
  }

  /** Move the resume point forward. Never moves it backwards. */
  advance(cursor: string | null, ledger?: number | null): void {
    if (cursor) {
      this.state.cursor = cursor;
    }

    this.advanceLedger(ledger);
    this.persist();
  }

  reset(): void {
    this.state = { cursor: null, lastLedger: 0, processedIds: [] };
    this.storage?.removeItem(this.storageKey);
  }

  private advanceLedger(ledger?: number | null): void {
    if (typeof ledger === "number" && Number.isFinite(ledger) && ledger > this.state.lastLedger) {
      this.state.lastLedger = ledger;
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // Quota/denied: keep the in-memory state and carry on.
    }
  }
}

/** Raw event shape returned by the Soroban RPC `getEvents` method. */
export interface SorobanRpcEvent {
  id?: string;
  ledger?: number | string;
  ledgerClosedAt?: string;
  contractId?: string;
  type?: string;
  topic?: string[];
  value?: string;
  txHash?: string;
  inSuccessfulContractCall?: boolean;
}

export interface GetEventsPage {
  events: SorobanRpcEvent[];
  latestLedger: number | null;
  cursor: string | null;
}

export interface SorobanEventSyncOptions {
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  /** `pagination.limit` per request. */
  pageSize?: number;
  /** Hard cap on pages fetched in one catch-up pass. */
  maxPages?: number;
  storage?: StorageLike | null;
  /**
   * Ledger to start from when there is no persisted resume point. Defaults to
   * the RPC's current ledger, so a first-ever subscribe does not try to replay
   * the contract's whole history.
   */
  startLedger?: number;
}

export interface CatchUpHandlers {
  onEvent?: (event: DecodedSorobanEvent) => void;
  /** Called for events dropped because they could not be decoded. */
  onDecodeError?: (raw: SorobanRpcEvent) => void;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;

/**
 * Queries `getEvents` from the persisted cursor until the RPC has no more
 * events, decoding each page into typed JS objects and skipping anything the
 * cursor already saw.
 */
export class SorobanEventSyncWorker {
  readonly cursor: SorobanEventCursor;
  private readonly fetchImpl: typeof fetch | undefined;
  private resolvedStartLedger: number | null = null;

  constructor(
    private readonly network: StellarNetwork,
    private readonly contractId: string,
    private readonly options: SorobanEventSyncOptions = {},
  ) {
    this.cursor = new SorobanEventCursor(network, contractId, options.storage);
    this.fetchImpl = options.fetchImpl;
  }

  get rpcUrl(): string {
    if (this.options.rpcUrl) {
      return this.options.rpcUrl;
    }

    const config = STELLAR_NETWORKS[this.network];
    return config.rpcUrl || config.horizonUrl.replace("horizon", "soroban-rpc");
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const fetcher = this.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);

    if (!fetcher) {
      throw new Error("No fetch implementation available for Soroban event catch-up");
    }

    const response = await fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    if (!response.ok) {
      throw new Error(`Soroban ${method} failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { result?: T; error?: { message?: string } };

    if (payload.error) {
      throw new Error(`Soroban ${method} error: ${payload.error.message ?? "unknown"}`);
    }

    return payload.result as T;
  }

  /** Current chain tip, used when the client has no resume point yet. */
  async getLatestLedger(): Promise<number> {
    const result = await this.rpc<{ sequence?: number }>("getLatestLedger", {});
    return Number(result?.sequence ?? 0);
  }

  /** One `getEvents` request. Exposed for tests and for callers polling manually. */
  async fetchPage(): Promise<GetEventsPage> {
    const snapshot = this.cursor.snapshot();
    const pagination: Record<string, unknown> = {
      limit: this.options.pageSize ?? DEFAULT_PAGE_SIZE,
    };

    if (snapshot.cursor) {
      // The RPC rejects startLedger when a cursor is supplied: the paging token
      // already encodes the resume position.
      pagination.cursor = snapshot.cursor;
    }

    const params: Record<string, unknown> = {
      filters: [{ type: "contract", contractIds: [this.contractId] }],
      pagination,
    };

    if (!snapshot.cursor) {
      params.startLedger = await this.resolveStartLedger(snapshot.lastLedger);
    }

    const result = await this.rpc<{
      events?: SorobanRpcEvent[];
      latestLedger?: number;
      cursor?: string;
    }>("getEvents", params);

    const events = result?.events ?? [];
    const lastEventId = events.length > 0 ? events[events.length - 1]?.id ?? null : null;

    return {
      events,
      latestLedger: result?.latestLedger ?? null,
      cursor: result?.cursor ?? lastEventId,
    };
  }

  private async resolveStartLedger(lastLedger: number): Promise<number> {
    if (this.options.startLedger !== undefined) {
      return this.options.startLedger;
    }

    if (lastLedger > 0) {
      return lastLedger + 1;
    }

    if (this.resolvedStartLedger === null) {
      this.resolvedStartLedger = await this.getLatestLedger();
    }

    return this.resolvedStartLedger;
  }

  /**
   * Fetch and decode every event since the cursor.
   *
   * Returns the newly decoded events (the ones the caller has not seen before);
   * `handlers.onEvent` is invoked per event as it is decoded. The cursor is
   * advanced after each page so an interruption mid-catch-up does not re-emit
   * the pages already processed.
   */
  async catchUp(handlers: CatchUpHandlers = {}): Promise<DecodedSorobanEvent[]> {
    const decoded: DecodedSorobanEvent[] = [];
    const maxPages = this.options.maxPages ?? DEFAULT_MAX_PAGES;

    for (let page = 0; page < maxPages; page += 1) {
      const { events, cursor, latestLedger } = await this.fetchPage();

      if (events.length === 0) {
        this.cursor.advance(cursor, latestLedger ?? undefined);
        break;
      }

      const fresh: DecodedSorobanEvent[] = [];

      for (const raw of events) {
        const id = raw.id ?? null;
        const seenKey = liveEventKey(raw.ledger ?? null, raw.txHash ?? null);

        if ((id && this.cursor.hasProcessed(id)) || (seenKey && this.cursor.hasProcessed(seenKey))) {
          continue;
        }

        const event = decodeRawRpcEvent(raw);

        if (!event) {
          handlers.onDecodeError?.(raw);
          if (id) {
            // Remember the id so a malformed event is not retried forever.
            this.cursor.markProcessed([id], undefined);
          }
          continue;
        }

        fresh.push(event);
      }

      this.cursor.markProcessed(
        events.map((event) => event.id).filter((id): id is string => Boolean(id)),
        latestLedger ?? undefined,
      );
      this.cursor.advance(cursor, latestLedger ?? undefined);

      for (const event of fresh) {
        decoded.push(event);
        handlers.onEvent?.(event);
      }

      if (!cursor || events.length < (this.options.pageSize ?? DEFAULT_PAGE_SIZE)) {
        break;
      }
    }

    return decoded;
  }
}
