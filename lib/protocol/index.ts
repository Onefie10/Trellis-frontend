/**
 * Protocol safety subsystems (#175–#178).
 *
 *   operations.ts          shared operation/environment vocabulary
 *   canonical.ts           stable serialization for fingerprints
 *   config-versioning.ts   #178 protocol config versioning + compatibility
 *   emergency-pause.ts     #177 scoped emergency pause + audited resume
 *   preflight.ts           #175 deterministic transaction preflight
 *   operation-receipts.ts  #176 replay-safe operation receipts
 *   guard.ts               the composed execution gate
 */

export * from './operations';
export * from './canonical';
export * from './config-versioning';
export * from './emergency-pause';
export * from './preflight';
export * from './operation-receipts';
export * from './abuse-detection';
export * from './guard';
