/**
 * Change History Tests — Issue #53
 *
 * Covers:
 *  - Recording mutations creates entries with correct fields
 *  - Hash is computed deterministically from entry content
 *  - Chain linkage: each entry's previousHash equals the prior entry's hash
 *  - First entry uses GENESIS_HASH as previousHash
 *  - Verification passes on an untampered chain
 *  - Verification detects hash_mismatch (entry content altered after write)
 *  - Verification detects chain_break (previous hash field tampered)
 *  - Verification detects out_of_order timestamps
 *  - Actor history retrieval
 *  - Multiple independent chains (different record types) don't interfere
 */

import { MemoryHistoryStore, verifyChain, buildHashMaterial, computeHash } from '@/lib/change-history/history-store';
import { HistoryService } from '@/lib/change-history/history-service';
import { GENESIS_HASH } from '@/lib/change-history/types';
import type { HistoryEntry } from '@/lib/change-history/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildService() {
  const store   = new MemoryHistoryStore();
  const service = new HistoryService({ store });
  return { store, service };
}

const ACTOR  = 'GCZAJM3RJY7Y67HDFN7PIJBTYQC6KMRAXM57SC7Y2H546AAHFHWRH3YY';
const ACTOR2 = 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABVQVDF3YKBE6';

async function recordAgent(service: HistoryService, agentId: string, before: object | null, after: object, actor = ACTOR) {
  return service.record({
    recordType: 'agent',
    recordId:   agentId,
    actor,
    reason:     'Test mutation',
    before:     before as Record<string, unknown> | null,
    after:      after  as Record<string, unknown>,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HistoryService — record()', () => {
  it('creates an entry with correct fields', async () => {
    const { service } = buildService();
    const before = null;
    const after  = { id: 'ag-1', name: 'Agent One', status: 'active' };

    const entry = await recordAgent(service, 'ag-1', before, after);

    expect(entry.recordType).toBe('agent');
    expect(entry.recordId).toBe('ag-1');
    expect(entry.actor).toBe(ACTOR);
    expect(entry.reason).toBe('Test mutation');
    expect(entry.before).toBeNull();
    expect(entry.after).toEqual(after);
    expect(entry.previousHash).toBe(GENESIS_HASH);
    expect(entry.hash).toBeTruthy();
    expect(entry.hash).toHaveLength(64); // SHA-256 = 64 hex chars
    expect(entry.id).toBeTruthy();
    expect(entry.occurredAt).toBeTruthy();
  });

  it('links entries in a chain (previousHash = prior entry hash)', async () => {
    const { service } = buildService();

    const e1 = await recordAgent(service, 'ag-1', null,       { name: 'v1' });
    const e2 = await recordAgent(service, 'ag-1', { name: 'v1' }, { name: 'v2' });
    const e3 = await recordAgent(service, 'ag-1', { name: 'v2' }, { name: 'v3' });

    expect(e1.previousHash).toBe(GENESIS_HASH);
    expect(e2.previousHash).toBe(e1.hash);
    expect(e3.previousHash).toBe(e2.hash);
  });

  it('keeps independent chains per record', async () => {
    const { service } = buildService();

    const a1 = await recordAgent(service, 'ag-1', null, { name: 'A' });
    const a2 = await recordAgent(service, 'ag-2', null, { name: 'B' });

    // Each chain starts at GENESIS_HASH
    expect(a1.previousHash).toBe(GENESIS_HASH);
    expect(a2.previousHash).toBe(GENESIS_HASH);

    // Second entry on ag-1 chain is linked to a1, not a2
    const a1b = await recordAgent(service, 'ag-1', { name: 'A' }, { name: 'A+' });
    expect(a1b.previousHash).toBe(a1.hash);
  });

  it('different record types have independent chains', async () => {
    const { service } = buildService();

    const agentEntry = await service.record({
      recordType: 'agent',      recordId: 'ag-1',
      actor: ACTOR, reason: 'r', before: null, after: { x: 1 },
    });

    const stakeEntry = await service.record({
      recordType: 'stake',      recordId: 'ag-1',
      actor: ACTOR, reason: 'r', before: null, after: { y: 2 },
    });

    // Both chains start at GENESIS_HASH
    expect(agentEntry.previousHash).toBe(GENESIS_HASH);
    expect(stakeEntry.previousHash).toBe(GENESIS_HASH);
  });
});

describe('HistoryService — getHistory()', () => {
  it('returns entries oldest-first', async () => {
    const { service } = buildService();

    await recordAgent(service, 'ag-1', null,       { v: 1 }, ACTOR);
    await recordAgent(service, 'ag-1', { v: 1 },   { v: 2 }, ACTOR);
    await recordAgent(service, 'ag-1', { v: 2 },   { v: 3 }, ACTOR);

    const chain = service.getHistory('agent', 'ag-1');
    expect(chain).toHaveLength(3);
    expect((chain[0].after as any).v).toBe(1);
    expect((chain[2].after as any).v).toBe(3);
  });

  it('returns empty array for a record with no history', () => {
    const { service } = buildService();
    expect(service.getHistory('agent', 'nonexistent')).toEqual([]);
  });
});

describe('HistoryService — getActorHistory()', () => {
  it('returns all entries by a specific actor', async () => {
    const { service } = buildService();

    await recordAgent(service, 'ag-1', null, { x: 1 }, ACTOR);
    await recordAgent(service, 'ag-2', null, { x: 2 }, ACTOR2);
    await recordAgent(service, 'ag-1', { x: 1 }, { x: 3 }, ACTOR);

    const actorEntries = service.getActorHistory(ACTOR);
    expect(actorEntries).toHaveLength(2);
    expect(actorEntries.every(e => e.actor === ACTOR)).toBe(true);
  });
});

describe('verifyChain() — valid chain', () => {
  it('returns valid outcome for an untampered chain', async () => {
    const { service } = buildService();

    await recordAgent(service, 'ag-1', null,       { v: 1 });
    await recordAgent(service, 'ag-1', { v: 1 },   { v: 2 });
    await recordAgent(service, 'ag-1', { v: 2 },   { v: 3 });

    const result = await service.verify('agent', 'ag-1');

    expect(result.outcome).toBe('valid');
    expect(result.checked).toBe(3);
    expect(result.violations).toHaveLength(0);
  });

  it('returns valid for a single-entry chain', async () => {
    const { service } = buildService();
    await recordAgent(service, 'ag-1', null, { v: 1 });

    const result = await service.verify('agent', 'ag-1');
    expect(result.outcome).toBe('valid');
    expect(result.checked).toBe(1);
  });

  it('returns valid for an empty chain', async () => {
    const { service } = buildService();
    const result = await service.verify('agent', 'nonexistent');
    expect(result.outcome).toBe('valid');
    expect(result.checked).toBe(0);
  });
});

describe('verifyChain() — tampered chain', () => {
  it('detects hash_mismatch when entry content is altered', async () => {
    const { service, store } = buildService();

    await recordAgent(service, 'ag-1', null, { v: 1 });
    await recordAgent(service, 'ag-1', { v: 1 }, { v: 2 });

    // Directly mutate the first entry in the store to change its `after` value
    const chain = store.getChain('agent', 'ag-1');
    const tampered: HistoryEntry = { ...chain[0], after: { v: 999 } }; // changed after record write
    store.clear();
    store.append(tampered);
    store.append(chain[1]);

    const result = await verifyChain([tampered, chain[1]]);

    expect(result.outcome).toBe('invalid');
    const hashViolations = result.violations.filter(v => v.kind === 'hash_mismatch');
    expect(hashViolations).toHaveLength(1);
    expect(hashViolations[0].entryId).toBe(tampered.id);
  });

  it('detects chain_break when previousHash is altered', async () => {
    const { service, store } = buildService();

    await recordAgent(service, 'ag-1', null, { v: 1 });
    await recordAgent(service, 'ag-1', { v: 1 }, { v: 2 });

    const chain = store.getChain('agent', 'ag-1');

    // Tamper the second entry's previousHash to break the chain link
    const tampered: HistoryEntry = {
      ...chain[1],
      previousHash: 'deadbeef'.padEnd(64, '0'),
    };

    const result = await verifyChain([chain[0], tampered]);

    expect(result.outcome).toBe('invalid');
    const chainBreaks = result.violations.filter(v => v.kind === 'chain_break');
    expect(chainBreaks).toHaveLength(1);
  });

  it('detects out_of_order timestamps', async () => {
    const { service, store } = buildService();

    await recordAgent(service, 'ag-1', null, { v: 1 }, ACTOR);
    await recordAgent(service, 'ag-1', { v: 1 }, { v: 2 }, ACTOR);

    const chain = store.getChain('agent', 'ag-1');

    // Swap timestamps — second entry appears earlier than first
    const e1: HistoryEntry = { ...chain[0], occurredAt: '2025-01-02T00:00:00.000Z' };
    const e2: HistoryEntry = { ...chain[1], occurredAt: '2025-01-01T00:00:00.000Z' };

    const result = await verifyChain([e1, e2]);

    expect(result.outcome).toBe('invalid');
    const orderViolations = result.violations.filter(v => v.kind === 'out_of_order');
    expect(orderViolations).toHaveLength(1);
  });
});

describe('HistoryService — verifyAll()', () => {
  it('verifies all records of a type', async () => {
    const { service } = buildService();

    await recordAgent(service, 'ag-1', null, { v: 1 });
    await recordAgent(service, 'ag-2', null, { v: 1 });
    await recordAgent(service, 'ag-1', { v: 1 }, { v: 2 });

    const results = await service.verifyAll('agent');

    expect(Object.keys(results)).toHaveLength(2);
    expect(results['ag-1'].outcome).toBe('valid');
    expect(results['ag-2'].outcome).toBe('valid');
  });
});

describe('buildHashMaterial + computeHash determinism', () => {
  it('same entry always produces the same hash', async () => {
    const entry: Omit<HistoryEntry, 'hash'> = {
      id:           'test-id',
      recordType:   'agent',
      recordId:     'ag-1',
      actor:        ACTOR,
      reason:       'Test',
      before:       null,
      after:        { name: 'Test Agent' },
      occurredAt:   '2025-01-01T00:00:00.000Z',
      previousHash: GENESIS_HASH,
    };

    const material = buildHashMaterial(entry);
    const hash1    = await computeHash(material);
    const hash2    = await computeHash(material);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('different content produces different hashes', async () => {
    const base: Omit<HistoryEntry, 'hash'> = {
      id: 'a', recordType: 'agent', recordId: 'ag-1',
      actor: ACTOR, reason: 'r', before: null,
      after: { name: 'v1' }, occurredAt: '2025-01-01T00:00:00.000Z',
      previousHash: GENESIS_HASH,
    };

    const modified = { ...base, after: { name: 'v2' } };

    const h1 = await computeHash(buildHashMaterial(base));
    const h2 = await computeHash(buildHashMaterial(modified));

    expect(h1).not.toBe(h2);
  });

  it('object key order does not affect hash (canonical JSON)', async () => {
    const e1: Omit<HistoryEntry, 'hash'> = {
      id: 'x', recordType: 'agent', recordId: 'r',
      actor: ACTOR, reason: 'r', before: null,
      after: { b: 2, a: 1 },
      occurredAt: '2025-01-01T00:00:00.000Z',
      previousHash: GENESIS_HASH,
    };
    const e2: Omit<HistoryEntry, 'hash'> = { ...e1, after: { a: 1, b: 2 } };

    const h1 = await computeHash(buildHashMaterial(e1));
    const h2 = await computeHash(buildHashMaterial(e2));

    expect(h1).toBe(h2);
  });
});
