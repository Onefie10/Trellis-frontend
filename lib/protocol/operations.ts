/**
 * Shared vocabulary for the protocol safety subsystems (#175–#178).
 *
 * Every module in `lib/protocol/` speaks the same two small vocabularies:
 *
 *   - which *operations* exist and are considered high-risk, so a pause scope,
 *     a preflight rule set and a receipt all refer to the same thing; and
 *   - which *environment* an operation runs in, because emergency controls and
 *     compatibility policy legitimately differ between development, staging and
 *     production.
 *
 * Keeping the union in one file is what makes "a paused operation, a prefetched
 * preflight rule set and a receipt can never drift apart" true by construction:
 * adding an operation means extending this union and the compiler then walks
 * you through every registry that must learn about it.
 */

/** Deployment environments, mirroring `lib/config/env.ts`. */
export const PROTOCOL_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type ProtocolEnvironment = (typeof PROTOCOL_ENVIRONMENTS)[number];

/**
 * High-risk operations — the ones that move value, create durable objects, or
 * change governance state. These are exactly the operations that require:
 *
 *   - a preflight simulation before the wallet asks the user to sign (#175),
 *   - an operation receipt recording what was requested and what happened (#176),
 *   - an emergency pause scope so they can be halted individually (#177), and
 *   - a protocol config version check before execution (#178).
 *
 * If an operation is not in this list it does not get any of those guarantees,
 * which is the point: the list is the audit surface.
 */
export const PROTOCOL_OPERATIONS = [
  'transfer_funds',
  'claim_payout',
  'mint_agent',
  'update_governance',
  'retry_operation',
] as const;
export type ProtocolOperation = (typeof PROTOCOL_OPERATIONS)[number];

export function isProtocolOperation(value: unknown): value is ProtocolOperation {
  return (
    typeof value === 'string' &&
    (PROTOCOL_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isProtocolEnvironment(value: unknown): value is ProtocolEnvironment {
  return (
    typeof value === 'string' &&
    (PROTOCOL_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/**
 * The actor whose identity is attached to pauses, resumes and receipts.
 * `role` uses the same vocabulary as `lib/permissions.ts`.
 */
export interface ProtocolActor {
  id: string;
  role: 'guest' | 'viewer' | 'contributor' | 'maintainer' | 'admin';
}
