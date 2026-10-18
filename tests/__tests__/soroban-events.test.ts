import * as StellarSdk from "@stellar/stellar-sdk";
import {
  decodeContractEvent,
  decodeRawRpcEvent,
  decodeScVal,
} from "../../lib/soroban/xdr-decode";
import {
  MAX_PROCESSED_IDS,
  SorobanEventCursor,
  SorobanEventSyncWorker,
  eventCursorKey,
  liveEventKey,
  type StorageLike,
} from "../../lib/soroban/event-sync";

const { xdr } = StellarSdk;

const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function base64(scVal: xdr.ScVal): string {
  return scVal.toXDR("base64");
}

function symbolXdr(value: string): string {
  return base64(xdr.ScVal.scvSymbol(value));
}

function u32Xdr(value: number): string {
  return base64(xdr.ScVal.scvU32(value));
}

function memoryStorage(): StorageLike & { snapshot(): Record<string, string> } {
  const map = new Map<string, string>();

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

describe("decodeScVal", () => {
  it("decodes symbols, strings and bools with their kind preserved", () => {
    expect(decodeScVal(xdr.ScVal.scvSymbol("transfer"))).toEqual({
      kind: "symbol",
      value: "transfer",
    });
    expect(decodeScVal(xdr.ScVal.scvString("hello"))).toEqual({
      kind: "string",
      value: "hello",
    });
    expect(decodeScVal(xdr.ScVal.scvBool(true))).toEqual({ kind: "bool", value: true });
  });

  it("decodes void and bytes", () => {
    expect(decodeScVal(xdr.ScVal.scvVoid())).toEqual({ kind: "void", value: null });
    expect(decodeScVal(xdr.ScVal.scvBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef])))).toEqual({
      kind: "bytes",
      value: "deadbeef",
    });
  });

  it("decodes integers", () => {
    expect(decodeScVal(xdr.ScVal.scvU32(42))).toEqual({ kind: "u32", value: 42 });
    expect(decodeScVal(xdr.ScVal.scvI32(-7))).toEqual({ kind: "i32", value: -7 });
    expect(decodeScVal(StellarSdk.nativeToScVal(123n, { type: "u64" }))).toEqual({
      kind: "u64",
      value: 123n,
    });
    expect(decodeScVal(StellarSdk.nativeToScVal(-5n, { type: "i128" }))).toEqual({
      kind: "i128",
      value: -5n,
    });
  });

  it("decodes addresses to their StrKey form", () => {
    const scVal = StellarSdk.Address.fromString(ACCOUNT).toScVal();

    expect(decodeScVal(scVal)).toEqual({ kind: "address", value: ACCOUNT });
  });

  it("recurses into vectors", () => {
    const scVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("a"),
      xdr.ScVal.scvU32(1),
    ]);

    expect(decodeScVal(scVal)).toEqual({
      kind: "vec",
      value: [
        { kind: "symbol", value: "a" },
        { kind: "u32", value: 1 },
      ],
    });
  });

  it("recurses into maps, preserving entry keys", () => {
    const scVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("amount"),
        val: xdr.ScVal.scvU32(10),
      }),
    ]);

    expect(decodeScVal(scVal)).toEqual({
      kind: "map",
      value: [
        {
          key: { kind: "symbol", value: "amount" },
          value: { kind: "u32", value: 10 },
        },
      ],
    });
  });
});

describe("decodeContractEvent", () => {
  it("decodes topics and data into typed JS values and surfaces the event name", () => {
    const address = StellarSdk.Address.fromString(ACCOUNT).toScVal();
    const event = decodeContractEvent({
      contractId: CONTRACT,
      topics: [xdr.ScVal.scvSymbol("transfer"), address],
      data: xdr.ScVal.scvU32(1234),
      id: "0000000100-0000",
      ledger: 100,
      txHash: "abc123",
      inSuccessfulContractCall: true,
    });

    expect(event.name).toBe("transfer");
    expect(event.contractId).toBe(CONTRACT);
    expect(event.topics).toEqual(["transfer", ACCOUNT]);
    expect(event.value).toBe(1234);
    expect(event.decodedValue).toEqual({ kind: "u32", value: 1234 });
    expect(event.decodedTopics[1]).toEqual({ kind: "address", value: ACCOUNT });
    expect(event.ledger).toBe(100);
    expect(event.txHash).toBe("abc123");
  });

  it("leaves the name null when the first topic is not a symbol", () => {
    const event = decodeContractEvent({
      contractId: CONTRACT,
      topics: [xdr.ScVal.scvU32(1)],
      data: xdr.ScVal.scvVoid(),
    });

    expect(event.name).toBeNull();
    expect(event.decodedValue).toEqual({ kind: "void", value: null });
  });
});

describe("decodeRawRpcEvent", () => {
  it("decodes a base64 getEvents payload", () => {
    const event = decodeRawRpcEvent({
      id: "0000000100-0001",
      ledger: 100,
      ledgerClosedAt: "2024-01-01T00:00:00Z",
      contractId: CONTRACT,
      type: "contract",
      topic: [symbolXdr("mint")],
      value: u32Xdr(5),
      txHash: "deadbeef",
      inSuccessfulContractCall: true,
    });

    expect(event).not.toBeNull();
    expect(event?.name).toBe("mint");
    expect(event?.value).toBe(5);
    expect(event?.id).toBe("0000000100-0001");
  });

  it("returns null instead of throwing for malformed XDR", () => {
    expect(decodeRawRpcEvent({ id: "1", topic: ["not-xdr"], value: "also-not-xdr" })).toBeNull();
    expect(decodeRawRpcEvent({ id: "1", topic: [symbolXdr("ok")], value: "!!!" })).toBeNull();
  });
});

describe("SorobanEventCursor", () => {
  it("persists the cursor and processed ids for the next session", () => {
    const storage = memoryStorage();
    const cursor = new SorobanEventCursor("testnet", CONTRACT, storage);

    cursor.advance("0000000100-0000", 100);
    cursor.markProcessed(["0000000100-0000"], 100);

    // A fresh instance (e.g. after a page reload) resumes where we stopped.
    const reloaded = new SorobanEventCursor("testnet", CONTRACT, storage);

    expect(reloaded.snapshot()).toEqual({
      cursor: "0000000100-0000",
      lastLedger: 100,
      processedIds: ["0000000100-0000"],
    });
    expect(reloaded.hasProcessed("0000000100-0000")).toBe(true);
    expect(storage.snapshot()[eventCursorKey("testnet", CONTRACT)]).toBeDefined();
  });

  it("keeps the newest ids only and never moves the ledger backwards", () => {
    const cursor = new SorobanEventCursor("testnet", CONTRACT, memoryStorage());

    cursor.markProcessed(["old"], 500);
    cursor.advance(null, 400);

    expect(cursor.snapshot().lastLedger).toBe(500);

    cursor.markProcessed(
      Array.from({ length: MAX_PROCESSED_IDS + 10 }, (_, index) => `id-${index}`),
      600,
    );

    const snapshot = cursor.snapshot();
    expect(snapshot.processedIds).toHaveLength(MAX_PROCESSED_IDS);
    expect(snapshot.processedIds).not.toContain("old");
    expect(snapshot.processedIds[snapshot.processedIds.length - 1]).toBe(
      `id-${MAX_PROCESSED_IDS + 9}`,
    );
  });

  it("recovers from a corrupt stored payload and can be reset", () => {
    const key = eventCursorKey("testnet", CONTRACT);
    const storage = memoryStorage();
    storage.setItem(key, "{not json");

    const cursor = new SorobanEventCursor("testnet", CONTRACT, storage);
    expect(cursor.snapshot()).toEqual({ cursor: null, lastLedger: 0, processedIds: [] });

    cursor.advance("cursor-1", 10);
    cursor.reset();

    expect(cursor.snapshot()).toEqual({ cursor: null, lastLedger: 0, processedIds: [] });
    expect(storage.getItem(key)).toBeNull();
  });

  it("builds a stable de-duplication key for events seen on the live stream", () => {
    expect(liveEventKey(100, "abc")).toBe("live:100:abc");
    expect(liveEventKey(100, null)).toBeNull();
    expect(liveEventKey(null, "abc")).toBeNull();
  });
});

describe("SorobanEventSyncWorker.catchUp", () => {
  function rpcPage(events: unknown[], latestLedger: number, cursor?: string) {
    return { jsonrpc: "2.0", id: 1, result: { events, latestLedger, ...(cursor ? { cursor } : {}) } };
  }

  function rawEvent(id: string, ledger: number, txHash: string, name: string) {
    return {
      id,
      ledger,
      contractId: CONTRACT,
      type: "contract",
      topic: [symbolXdr(name)],
      value: u32Xdr(ledger),
      txHash,
      inSuccessfulContractCall: true,
    };
  }

  function scriptedFetch(pages: unknown[], requests: RecordedRequest[]) {
    let call = 0;

    return (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
      requests.push({ method: body.method, params: body.params });

      if (body.method === "getLatestLedger") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { sequence: 90 } });
      }

      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return jsonResponse(page);
    }) as unknown as typeof fetch;
  }

  it("pages through getEvents, decodes every event and persists the cursor", async () => {
    const storage = memoryStorage();
    const requests: RecordedRequest[] = [];
    const fetchImpl = scriptedFetch(
      [
        rpcPage(
          [rawEvent("0000000100-0000", 100, "tx-a", "transfer"), rawEvent("0000000100-0001", 100, "tx-a", "mint")],
          100,
          "0000000100-0001",
        ),
        rpcPage([rawEvent("0000000101-0000", 101, "tx-b", "burn")], 101),
      ],
      requests,
    );

    const worker = new SorobanEventSyncWorker("testnet", CONTRACT, {
      fetchImpl,
      pageSize: 2,
      storage,
    });

    const events = await worker.catchUp();

    expect(events.map((event) => event.name)).toEqual(["transfer", "mint", "burn"]);
    expect(worker.cursor.snapshot()).toEqual({
      cursor: "0000000101-0000",
      lastLedger: 101,
      processedIds: ["0000000100-0000", "0000000100-0001", "0000000101-0000"],
    });

    // First request had no cursor -> it targeted the tip; the second resumed.
    expect(requests[0].method).toBe("getLatestLedger");
    const firstGetEvents = requests.find((request) => request.method === "getEvents");
    expect(firstGetEvents?.params.startLedger).toBe(90);
    const pagination = firstGetEvents?.params.pagination as Record<string, unknown>;
    expect(pagination).not.toHaveProperty("cursor");
  });

  it("re-queries from the persisted cursor and never re-emits processed events", async () => {
    const storage = memoryStorage();
    const requests: RecordedRequest[] = [];
    const page = rpcPage([rawEvent("0000000100-0000", 100, "tx-a", "transfer")], 100, "0000000100-0000");
    const fetchImpl = scriptedFetch([page], requests);

    await new SorobanEventSyncWorker("testnet", CONTRACT, {
      fetchImpl,
      pageSize: 2,
      storage,
    }).catchUp();

    const secondRequests: RecordedRequest[] = [];
    const secondFetch = scriptedFetch([rpcPage([], 100, "0000000100-0000")], secondRequests);

    const replayed = await new SorobanEventSyncWorker("testnet", CONTRACT, {
      fetchImpl: secondFetch,
      pageSize: 2,
      storage,
    }).catchUp();

    expect(replayed).toEqual([]);
    const resume = secondRequests.find((request) => request.method === "getEvents");
    const pagination = resume?.params.pagination as Record<string, unknown>;
    expect(pagination.cursor).toBe("0000000100-0000");
    // A cursor supersedes startLedger: the RPC rejects both together.
    expect(resume?.params).not.toHaveProperty("startLedger");
  });

  it("skips events already delivered by the live stream", async () => {
    const storage = memoryStorage();
    const requests: RecordedRequest[] = [];
    const fetchImpl = scriptedFetch(
      [rpcPage([rawEvent("0000000100-0000", 100, "tx-a", "transfer")], 100)],
      requests,
    );

    const worker = new SorobanEventSyncWorker("testnet", CONTRACT, {
      fetchImpl,
      pageSize: 2,
      storage,
    });
    worker.cursor.markProcessed([liveEventKey(100, "tx-a") as string], 100);

    expect(await worker.catchUp()).toEqual([]);
  });

  it("reports undecodable events without failing the whole pass", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = scriptedFetch(
      [
        rpcPage(
          [
            { id: "bad-1", ledger: 100, topic: ["not-xdr"], value: "also-bad" },
            rawEvent("0000000100-0001", 100, "tx-a", "transfer"),
          ],
          100,
          "0000000100-0001",
        ),
        rpcPage([], 100),
      ],
      requests,
    );

    const onDecodeError = jest.fn();
    const onEvent = jest.fn();
    const worker = new SorobanEventSyncWorker("testnet", CONTRACT, {
      fetchImpl,
      pageSize: 2,
      storage: memoryStorage(),
    });

    const events = await worker.catchUp({ onDecodeError, onEvent });

    expect(onDecodeError).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.name)).toEqual(["transfer"]);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("surfaces RPC failures", async () => {
    const worker = new SorobanEventSyncWorker("testnet", CONTRACT, {
      fetchImpl: (async () => jsonResponse({ error: { message: "boom" } })) as unknown as typeof fetch,
      storage: memoryStorage(),
      startLedger: 1,
    });

    await expect(worker.catchUp()).rejects.toThrow("boom");
  });
});
