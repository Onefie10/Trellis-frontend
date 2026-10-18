import {
  AUDIT_LEDGER_GENESIS_HASH,
  InMemoryAuditLedger,
  verifyAuditLedger,
} from "@/lib/security/audit-ledger";

describe("tamper-evident audit ledger", () => {
  it("exports a verifiable, ordered chain for privileged and financial events", () => {
    const ledger = new InMemoryAuditLedger();
    ledger.append({
      streamId: "contract:C123",
      category: "privileged",
      eventType: "security.audit.recorded",
      actorId: "admin-1",
      payload: { contractId: "C123", score: 92 },
    }, 2_000);
    ledger.append({
      streamId: "contract:C123",
      category: "financial",
      eventType: "affiliate.payout.queued",
      actorId: "affiliate-payout-api",
      payload: { payoutId: "payout-1", amount: "12.50" },
    }, 1_000);

    const exported = ledger.export("contract:C123");
    expect(exported.verification.valid).toBe(true);
    expect(exported.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(exported.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(Date.parse(exported.entries[1].occurredAt)).toBeGreaterThan(
      Date.parse(exported.entries[0].occurredAt),
    );
    expect(exported.entries[0].previousHash).toBe(AUDIT_LEDGER_GENESIS_HASH);
    expect(exported.entries[1].previousHash).toBe(exported.entries[0].hash);
    expect(JSON.parse(ledger.exportJson("contract:C123")).verification.valid).toBe(true);
  });

  it("detects payload edits, deletion, and reordering in an export", () => {
    const ledger = new InMemoryAuditLedger();
    for (const sequence of [1, 2, 3]) {
      ledger.append({
        streamId: "wallet:GABC",
        category: "financial",
        eventType: "affiliate.payout.queued",
        actorId: "affiliate-payout-api",
        payload: { sequence },
      }, sequence * 1_000);
    }
    const entries = ledger.getEntries("wallet:GABC");

    const edited = structuredClone(entries);
    edited[1].payload = { sequence: 20 };
    expect(verifyAuditLedger(edited, "wallet:GABC")).toMatchObject({ valid: false, errorIndex: 1 });
    expect(verifyAuditLedger(entries.slice(1), "wallet:GABC")).toMatchObject({ valid: false, errorIndex: 0 });
    expect(verifyAuditLedger([entries[1], entries[0], entries[2]], "wallet:GABC"))
      .toMatchObject({ valid: false, errorIndex: 0 });
  });

  it("isolates streams and does not expose mutable internal entries", () => {
    const ledger = new InMemoryAuditLedger();
    const entry = ledger.append({
      streamId: "contract:C123",
      category: "privileged",
      eventType: "security.audit.recorded",
      actorId: "admin-1",
      payload: { nested: { value: "original" } },
    });
    (entry.payload as { nested: { value: string } }).nested.value = "changed";

    expect(ledger.getEntries("contract:C123")[0].payload).toEqual({ nested: { value: "original" } });
    expect(ledger.export("wallet:GABC")).toMatchObject({
      entries: [],
      headHash: AUDIT_LEDGER_GENESIS_HASH,
      verification: { valid: true },
    });
  });
});
