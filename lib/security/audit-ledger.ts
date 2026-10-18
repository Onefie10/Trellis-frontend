import { createHash } from "node:crypto";
import { jcsCanonicalize } from "@/lib/canonicalization";

/** Event classes recorded by the server-side security and payout routes. */
export type AuditLedgerCategory = "privileged" | "financial";

export interface AuditLedgerInput<T = unknown> {
  /** Independent ordered chain, usually a contract or wallet identifier. */
  streamId: string;
  category: AuditLedgerCategory;
  eventType: string;
  /** Authenticated principal or the server-side producer name. */
  actorId: string;
  payload: T;
}

export interface AuditLedgerEntry<T = unknown> extends AuditLedgerInput<T> {
  schemaVersion: 1;
  sequence: number;
  /** Server timestamp. Strictly increases within a stream, even if the clock moves back. */
  occurredAt: string;
  previousHash: string;
  hash: string;
}

export interface AuditLedgerVerification {
  valid: boolean;
  entryCount: number;
  headHash: string;
  errorIndex?: number;
}

export interface AuditLedgerExport<T = unknown> {
  schemaVersion: 1;
  streamId: string;
  entries: AuditLedgerEntry<T>[];
  headHash: string;
  verification: AuditLedgerVerification;
}

export const AUDIT_LEDGER_GENESIS_HASH = "0".repeat(64);
const HASH_DOMAIN = "trellis.audit-ledger.v1\0";

type UnsignedEntry<T> = Omit<AuditLedgerEntry<T>, "hash">;

function cloneJson<T>(value: T): T {
  // Canonicalization rejects undefined, functions, cycles and other values that
  // cannot be represented in an exportable JSON ledger.
  return JSON.parse(jcsCanonicalize(value)) as T;
}

function hashEntry<T>(entry: UnsignedEntry<T>): string {
  return createHash("sha256")
    .update(HASH_DOMAIN)
    .update(jcsCanonicalize(entry))
    .digest("hex");
}

function validIdentifier(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

/** Verify an exported stream without trusting its stored hashes or ordering. */
export function verifyAuditLedger<T = unknown>(
  entries: readonly AuditLedgerEntry<T>[],
  streamId = entries[0]?.streamId ?? "",
): AuditLedgerVerification {
  let previousHash = AUDIT_LEDGER_GENESIS_HASH;
  let previousTimestamp = -1;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const timestamp = Date.parse(entry.occurredAt);
    if (
      entry.schemaVersion !== 1 ||
      entry.streamId !== streamId ||
      entry.sequence !== index + 1 ||
      !validIdentifier(entry.eventType) ||
      !validIdentifier(entry.actorId) ||
      (entry.category !== "privileged" && entry.category !== "financial") ||
      !Number.isFinite(timestamp) ||
      timestamp <= previousTimestamp ||
      entry.previousHash !== previousHash
    ) {
      return { valid: false, entryCount: entries.length, headHash: previousHash, errorIndex: index };
    }

    let expectedHash: string;
    try {
      const { hash: _hash, ...unsigned } = entry;
      expectedHash = hashEntry(unsigned);
    } catch {
      return { valid: false, entryCount: entries.length, headHash: previousHash, errorIndex: index };
    }
    if (entry.hash !== expectedHash) {
      return { valid: false, entryCount: entries.length, headHash: previousHash, errorIndex: index };
    }

    previousHash = entry.hash;
    previousTimestamp = timestamp;
  }

  return { valid: true, entryCount: entries.length, headHash: previousHash };
}

/**
 * Process-local hash-chained ledger. Production persistence and an externally
 * stored head checkpoint are deployment responsibilities; see the runbook.
 */
export class InMemoryAuditLedger<T = unknown> {
  private readonly streams = new Map<string, AuditLedgerEntry<T>[]>();

  append(input: AuditLedgerInput<T>, now = Date.now()): AuditLedgerEntry<T> {
    if (!validIdentifier(input.streamId) || !validIdentifier(input.eventType) || !validIdentifier(input.actorId)) {
      throw new TypeError("Audit ledger stream, event type and actor must be non-empty identifiers");
    }
    if (input.category !== "privileged" && input.category !== "financial") {
      throw new TypeError("Unsupported audit ledger category");
    }
    if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) {
      throw new TypeError("Audit ledger timestamp must be a valid date");
    }

    const entries = this.streams.get(input.streamId) ?? [];
    const previous = entries.at(-1);
    const previousTimestamp = previous ? Date.parse(previous.occurredAt) : -1;
    const timestamp = Math.max(Math.trunc(now), previousTimestamp + 1);
    const unsigned: UnsignedEntry<T> = {
      schemaVersion: 1,
      streamId: input.streamId,
      sequence: entries.length + 1,
      occurredAt: new Date(timestamp).toISOString(),
      category: input.category,
      eventType: input.eventType,
      actorId: input.actorId,
      payload: cloneJson(input.payload),
      previousHash: previous?.hash ?? AUDIT_LEDGER_GENESIS_HASH,
    };
    const entry: AuditLedgerEntry<T> = { ...unsigned, hash: hashEntry(unsigned) };
    entries.push(entry);
    this.streams.set(input.streamId, entries);
    return cloneJson(entry);
  }

  getEntries(streamId: string): AuditLedgerEntry<T>[] {
    return cloneJson(this.streams.get(streamId) ?? []);
  }

  export(streamId: string): AuditLedgerExport<T> {
    const entries = this.getEntries(streamId);
    const verification = verifyAuditLedger(entries, streamId);
    return {
      schemaVersion: 1,
      streamId,
      entries,
      headHash: verification.headHash,
      verification,
    };
  }

  exportJson(streamId: string): string {
    return JSON.stringify(this.export(streamId), null, 2);
  }
}

/** Shared server-side writer used by privileged audit and payout routes. */
export const securityAuditLedger = new InMemoryAuditLedger();

export function contractAuditStreamId(contractId: string): string {
  return `contract:${contractId}`;
}

export function walletAuditStreamId(walletAddress: string): string {
  return `wallet:${walletAddress}`;
}
