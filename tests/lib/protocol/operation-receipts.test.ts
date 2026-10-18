import {
  canonicalRequestFingerprint,
  MemoryReceiptStore,
  ReceiptLookupDeniedError,
  ReceiptService,
  type OperationReceipt,
} from '@/lib/protocol/operation-receipts';
import type { ProtocolActor } from '@/lib/protocol/operations';

const owner: ProtocolActor = { id: 'wallet-1', role: 'contributor' };
const support: ProtocolActor = { id: 'support-1', role: 'maintainer' };
const admin: ProtocolActor = { id: 'admin-1', role: 'admin' };
const stranger: ProtocolActor = { id: 'wallet-2', role: 'viewer' };

function makeService(): { service: ReceiptService; store: MemoryReceiptStore } {
  let n = 0;
  const store = new MemoryReceiptStore();
  const service = new ReceiptService({
    store,
    now: () => 1_000_000 + (n += 1),
    generateId: () => `rcpt-${(n += 1).toString(16).padStart(4, '0')}`,
  });
  return { service, store };
}

const payoutRequest = {
  operation: 'claim_payout' as const,
  environment: 'production' as const,
  actorId: 'wallet-1',
  payload: { rewardId: 'reward-9', amount: '25' },
};

describe('operation receipts (#176)', () => {
  describe('canonical fingerprint stability', () => {
    it('is stable across key order and whitespace-affecting structures', () => {
      const a = canonicalRequestFingerprint({
        amount: '100',
        to: 'GABC',
        memo: { k1: 'v1', k2: 'v2' },
      });
      const b = canonicalRequestFingerprint({
        memo: { k2: 'v2', k1: 'v1' },
        to: 'GABC',
        amount: '100',
      });
      expect(a).toBe(b);
    });

    it('changes when the payload meaningfully changes', () => {
      const a = canonicalRequestFingerprint({ amount: '100' });
      const b = canonicalRequestFingerprint({ amount: '101' });
      expect(a).not.toBe(b);
    });

    it('is deterministic across repeated calls', () => {
      const material = { operation: 'transfer_funds', payload: { n: 42 } };
      expect(canonicalRequestFingerprint(material)).toBe(
        canonicalRequestFingerprint(material),
      );
    });

    it('ignores undefined-valued keys, like idempotency canonicalization', () => {
      const a = canonicalRequestFingerprint({ a: '1', b: undefined });
      const b = canonicalRequestFingerprint({ a: '1' });
      expect(a).toBe(b);
    });

    it('exposes the same fingerprint through the service', () => {
      const { service } = makeService();
      expect(service.fingerprintFor(payoutRequest)).toBe(
        canonicalRequestFingerprint({
          actorId: payoutRequest.actorId,
          environment: payoutRequest.environment,
          operation: payoutRequest.operation,
          payload: payoutRequest.payload,
        }),
      );
    });
  });

  describe('create-or-get replay safety', () => {
    it('creates the receipt once and resolves duplicates to it', () => {
      const { service, store } = makeService();
      const first = service.createOrGet(payoutRequest);
      expect(first.created).toBe(true);
      expect(first.receipt.status).toBe('received');

      const duplicate = service.createOrGet(payoutRequest);
      expect(duplicate.created).toBe(false);
      expect(duplicate.receipt.receiptId).toBe(first.receipt.receiptId);
      expect(store.size).toBe(1);
    });

    it('resolves duplicates even when key order differs', () => {
      const { service } = makeService();
      const a = service.createOrGet({
        ...payoutRequest,
        payload: { rewardId: 'r1', amount: '5' },
      });
      const b = service.createOrGet({
        ...payoutRequest,
        payload: { amount: '5', rewardId: 'r1' },
      });
      expect(b.receipt.receiptId).toBe(a.receipt.receiptId);
      expect(b.created).toBe(false);
    });

    it('mints distinct receipts for genuinely different requests', () => {
      const { service, store } = makeService();
      const a = service.createOrGet(payoutRequest);
      const b = service.createOrGet({ ...payoutRequest, payload: { rewardId: 'other' } });
      expect(a.receipt.receiptId).not.toBe(b.receipt.receiptId);
      expect(store.size).toBe(2);
    });

    it('records actor, timestamps and canonical request material', () => {
      const { service } = makeService();
      const { receipt } = service.createOrGet(payoutRequest);
      expect(receipt.actorId).toBe('wallet-1');
      expect(receipt.operation).toBe('claim_payout');
      expect(receipt.environment).toBe('production');
      expect(receipt.createdAt).toBeGreaterThan(0);
      expect(receipt.updatedAt).toBe(receipt.createdAt);
      expect(receipt.request).toContain('"claim_payout"');
    });
  });

  describe('status transitions and external references', () => {
    it('walks received → submitted → confirmed with the external ref', () => {
      const { service } = makeService();
      const { receipt } = service.createOrGet(payoutRequest);

      const submitted = service.markSubmitted(receipt.receiptId, 'tx-hash-abc');
      expect(submitted.status).toBe('submitted');
      expect(submitted.externalRef).toBe('tx-hash-abc');

      const confirmed = service.markConfirmed(receipt.receiptId);
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.resolvedAt).toBeDefined();
      expect(confirmed.updatedAt).toBeGreaterThanOrEqual(submitted.updatedAt);
    });

    it('records failures with a user-safe reason', () => {
      const { service } = makeService();
      const { receipt } = service.createOrGet(payoutRequest);
      const failed = service.markFailed(receipt.receiptId, 'Network fee spike; please retry');
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/retry/i);
      expect(failed.resolvedAt).toBeDefined();
    });

    it('throws on unknown receipts', () => {
      const { service } = makeService();
      expect(() => service.markSubmitted('rcpt-none', 'tx')).toThrow(/unknown receipt/i);
    });

    it('keeps a duplicate lookup consistent after transitions', () => {
      const { service } = makeService();
      const first = service.createOrGet(payoutRequest);
      service.markSubmitted(first.receipt.receiptId, 'tx-hash-1');
      const replay = service.createOrGet(payoutRequest);
      expect(replay.receipt.status).toBe('submitted');
      expect(replay.receipt.externalRef).toBe('tx-hash-1');
    });
  });

  describe('permission-checked lookup', () => {
    it('lets the owner read their own receipt by id and fingerprint', () => {
      const { service } = makeService();
      const { receipt } = service.createOrGet(payoutRequest);

      expect(service.lookup({ receiptId: receipt.receiptId }, owner)?.receiptId).toBe(
        receipt.receiptId,
      );
      expect(service.lookup({ fingerprint: receipt.fingerprint }, owner)?.receiptId).toBe(
        receipt.receiptId,
      );
    });

    it('lets maintainers and admins read any receipt (support)', () => {
      const { service } = makeService();
      const { receipt } = service.createOrGet(payoutRequest);
      expect(service.lookup({ receiptId: receipt.receiptId }, support)?.receiptId).toBe(
        receipt.receiptId,
      );
      expect(service.lookup({ receiptId: receipt.receiptId }, admin)?.receiptId).toBe(
        receipt.receiptId,
      );
    });

    it('refuses unrelated users with ReceiptLookupDeniedError', () => {
      const { service } = makeService();
      const { receipt } = service.createOrGet(payoutRequest);
      expect(() => service.lookup({ receiptId: receipt.receiptId }, stranger)).toThrow(
        ReceiptLookupDeniedError,
      );
      try {
        service.lookup({ receiptId: receipt.receiptId }, stranger);
      } catch (error) {
        expect((error as ReceiptLookupDeniedError).code).toBe('RECEIPT_LOOKUP_DENIED');
      }
    });

    it('returns null (not an error) for receipts that do not exist', () => {
      const { service } = makeService();
      expect(service.lookup({ receiptId: 'rcpt-missing' }, owner)).toBeNull();
      expect(service.lookup({}, owner)).toBeNull();
    });
  });
});
