/**
 * Replay-safe operation receipts with canonical request fingerprints (#176).
 *
 * A receipt proves three things about one high-risk operation: what was
 * requested (the canonical fingerprint), what was submitted (the external
 * reference, e.g. a Stellar transaction hash), and how the system resolved it
 * (status + timestamps + actor).
 *
 * Replay safety:
 *
 *   - The fingerprint is taken over the **canonical** form of the request
 *     (RFC 8785-style: sorted keys, stable encoding), so two submissions that
 *     are logically identical — even if their object key order differed — map
 *     to the same fingerprint.
 *
 *   - `createOrGet` is the only way to mint a receipt: the first submission
 *     creates it, any duplicate submission resolves to the *existing* receipt
 *     instead of creating a second one. That is what makes a double-click, a
 *     retried fetch, or two tabs submitting the same intent safe.
 *
 *   - Lookup is permission-checked: a user sees their own receipts; maintainers
 *     and admins (support) may look up any receipt; everyone else is refused.
 *
 * The module is pure and injectable (clock, id source, store), mirroring the
 * conventions of `lib/idempotency.ts` and `lib/protocol/emergency-pause.ts`.
 */

import { jcsCanonicalize } from '@/lib/canonicalization';
import type { ProtocolActor, ProtocolEnvironment, ProtocolOperation } from './operations';

/** Stable encoding + SHA-256 (WebCrypto) with a deterministic FNV fallback. */
export function canonicalRequestFingerprint(material: unknown): string {
  const canonical = jcsCanonicalize(stripUndefined(material));
  return fnv1a64(canonical);
}

/**
 * Drop `undefined`-valued keys recursively so optional fields cannot change a
 * fingerprint — same convention as `lib/idempotency.ts`. JCS itself would
 * refuse to serialize `undefined`, so this runs before canonicalization.
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)]),
    );
  }
  return value;
}

/** Deterministic 64-bit FNV-1a (two 32-bit lanes), hex-encoded. */
function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Lifecycle of a receipt. */
export type ReceiptStatus = 'received' | 'submitted' | 'confirmed' | 'failed';

export interface OperationReceipt {
  readonly receiptId: string;
  /** Canonical fingerprint of the request this receipt was created for. */
  readonly fingerprint: string;
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  readonly actorId: string;
  /** The canonical request material; kept for support reproduction. */
  readonly request: unknown;
  readonly status: ReceiptStatus;
  /** External reference once submitted — a Stellar transaction hash, for example. */
  readonly externalRef?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt?: number;
  /** Failure reason, only for `failed`. User-safe. */
  readonly error?: string;
}

/** Pluggable persistence, same pattern as `PauseStore`. */
export interface ReceiptStore {
  getByFingerprint(fingerprint: string): OperationReceipt | null;
  get(receiptId: string): OperationReceipt | null;
  add(receipt: OperationReceipt): void;
  update(receipt: OperationReceipt): void;
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly byId = new Map<string, OperationReceipt>();
  private readonly byFingerprint = new Map<string, OperationReceipt>();

  getByFingerprint(fingerprint: string): OperationReceipt | null {
    const receipt = this.byFingerprint.get(fingerprint);
    return receipt ? { ...receipt } : null;
  }

  get(receiptId: string): OperationReceipt | null {
    const receipt = this.byId.get(receiptId);
    return receipt ? { ...receipt } : null;
  }

  add(receipt: OperationReceipt): void {
    this.byId.set(receipt.receiptId, { ...receipt });
    this.byFingerprint.set(receipt.fingerprint, { ...receipt });
  }

  update(receipt: OperationReceipt): void {
    this.byId.set(receipt.receiptId, { ...receipt });
    this.byFingerprint.set(receipt.fingerprint, { ...receipt });
  }

  /** Test/support helper: number of receipts remembered. */
  get size(): number {
    return this.byId.size;
  }
}

/** Thrown when a lookup is not permitted for the requesting actor. */
export class ReceiptLookupDeniedError extends Error {
  readonly code = 'RECEIPT_LOOKUP_DENIED' as const;

  constructor(message = 'You do not have permission to view this receipt') {
    super(message);
    this.name = 'ReceiptLookupDeniedError';
  }
}

export interface CreateOrGetResult {
  readonly receipt: OperationReceipt;
  /** False when a duplicate submission resolved to the existing receipt. */
  readonly created: boolean;
}

export interface CreateOrGetParams {
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  readonly actorId: string;
  readonly payload: unknown;
}

export interface ReceiptServiceOptions {
  store?: ReceiptStore;
  now?: () => number;
  generateId?: () => string;
}

/**
 * Receipt service: one receipt per canonical operation, permission-checked
 * lookup, and explicit status transitions.
 */
export class ReceiptService {
  private readonly store: ReceiptStore;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: ReceiptServiceOptions = {}) {
    this.store = options.store ?? new MemoryReceiptStore();
    this.now = options.now ?? (() => Date.now());
    this.generateId =
      options.generateId ??
      (() => `rcpt-${canonicalRequestFingerprint({ at: this.now(), n: Math.random() }).slice(0, 12)}`);
  }

  /**
   * Create the receipt for this canonical request, or return the existing one.
   * This is the replay-safety boundary: the operation executor calls this
   * *before* submitting anything, and identical requests are guaranteed to
   * share one receipt.
   */
  createOrGet(params: CreateOrGetParams): CreateOrGetResult {
    const fingerprint = this.fingerprintFor(params);
    const existing = this.store.getByFingerprint(fingerprint);
    if (existing) return { receipt: existing, created: false };

    const at = this.now();
    const receipt: OperationReceipt = {
      receiptId: this.generateId(),
      fingerprint,
      operation: params.operation,
      environment: params.environment,
      actorId: params.actorId,
      request: jcsCanonicalize(fingerprintMaterial(params)),
      status: 'received',
      createdAt: at,
      updatedAt: at,
    };
    this.store.add(receipt);
    return { receipt, created: true };
  }

  /** Canonical fingerprint for a request, exposed for tests and support tooling. */
  fingerprintFor(params: CreateOrGetParams): string {
    return canonicalRequestFingerprint(fingerprintMaterial(params));
  }

  /** Mark the operation as submitted, recording the external reference. */
  markSubmitted(receiptId: string, externalRef: string): OperationReceipt {
    return this.transition(receiptId, 'submitted', { externalRef });
  }

  /** Mark the operation as confirmed on-chain. */
  markConfirmed(receiptId: string): OperationReceipt {
    return this.transition(receiptId, 'confirmed', { resolvedAt: this.now() });
  }

  /** Mark the operation as failed with a user-safe reason. */
  markFailed(receiptId: string, error: string): OperationReceipt {
    return this.transition(receiptId, 'failed', { error, resolvedAt: this.now() });
  }

  /**
   * Permission-checked receipt lookup for support and user confirmation.
   * Users may read their own receipts; maintainers and admins may read any.
   */
  lookup(query: { receiptId?: string; fingerprint?: string }, actor: ProtocolActor): OperationReceipt | null {
    const receipt = query.receiptId
      ? this.store.get(query.receiptId)
      : query.fingerprint
        ? this.store.getByFingerprint(query.fingerprint)
        : null;
    if (!receipt) return null;
    const isOwner = receipt.actorId === actor.id;
    const isSupport = actor.role === 'maintainer' || actor.role === 'admin';
    if (!isOwner && !isSupport) {
      throw new ReceiptLookupDeniedError();
    }
    return receipt;
  }

  private transition(
    receiptId: string,
    status: ReceiptStatus,
    patch: Partial<Pick<OperationReceipt, 'externalRef' | 'error' | 'resolvedAt'>>,
  ): OperationReceipt {
    const current = this.store.get(receiptId);
    if (!current) throw new Error(`Unknown receipt: ${receiptId}`);
    const updated: OperationReceipt = {
      ...current,
      ...patch,
      status,
      updatedAt: this.now(),
    };
    this.store.update(updated);
    return updated;
  }
}

function fingerprintMaterial(params: CreateOrGetParams): unknown {
  // The fingerprint covers everything that makes the request what it is:
  // who, what, where and the payload itself. Key order in `payload` does not
  // matter — JCS canonicalizes it.
  return {
    actorId: params.actorId,
    environment: params.environment,
    operation: params.operation,
    payload: params.payload,
  };
}
