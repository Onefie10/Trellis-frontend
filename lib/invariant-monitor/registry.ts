/**
 * The invariant registry.
 *
 * Order is stable and report-facing, so a diff between two reports lines up.
 * IDs are permanent: once published, an ID must not be reused for a different
 * rule, because downstream dashboards and runbooks reference them.
 */

import { AUTHORIZATION_INVARIANTS } from './invariants/authorization';
import { FUNDS_INVARIANTS } from './invariants/funds';
import { LIFECYCLE_INVARIANTS } from './invariants/lifecycle';
import { OWNERSHIP_INVARIANTS } from './invariants/ownership';
import type { InvariantDefinition, InvariantDomain } from './types';

export const ALL_INVARIANTS: readonly InvariantDefinition[] = Object.freeze([
  ...FUNDS_INVARIANTS,
  ...OWNERSHIP_INVARIANTS,
  ...LIFECYCLE_INVARIANTS,
  ...AUTHORIZATION_INVARIANTS,
]);

/**
 * Explicit ID prefix per domain.
 *
 * Derived rather than computed, because `ownership` would slice to `owne` and
 * `funds` to `fund` — neither matches the published IDs. The registry check
 * below catches that class of mistake at import time.
 */
export const DOMAIN_ID_PREFIX: Readonly<Record<InvariantDomain, string>> = Object.freeze({
  funds: 'FUNDS',
  ownership: 'OWN',
  lifecycle: 'LIFE',
  authorization: 'AUTH',
});

/**
 * Fails fast on a duplicated ID or a domain/ID mismatch.
 *
 * Called once at module load so a copy-paste mistake surfaces in tests and in
 * the CLI rather than producing a report with two entries claiming the same ID.
 */
function assertRegistryIntegrity(invariants: readonly InvariantDefinition[]): void {
  const seen = new Set<string>();
  const idPattern = /^[A-Z]+-\d{3}$/;

  for (const invariant of invariants) {
    if (seen.has(invariant.id)) {
      throw new Error(`Duplicate invariant id in registry: ${invariant.id}`);
    }
    seen.add(invariant.id);

    const expectedPrefix = DOMAIN_ID_PREFIX[invariant.domain];
    if (!invariant.id.startsWith(`${expectedPrefix}-`)) {
      throw new Error(
        `Invariant ${invariant.id} does not match its domain '${invariant.domain}' (expected prefix '${expectedPrefix}-')`
      );
    }
    if (!idPattern.test(invariant.id)) {
      throw new Error(`Invariant id '${invariant.id}' must match ${idPattern}`);
    }
    if (invariant.title.trim() === '' || invariant.description.trim() === '') {
      throw new Error(`Invariant ${invariant.id} must declare a title and a description`);
    }
    if (invariant.remediation.trim() === '') {
      throw new Error(`Invariant ${invariant.id} must declare remediation guidance`);
    }
  }
}

assertRegistryIntegrity(ALL_INVARIANTS);

export function invariantsByDomain(domain: InvariantDomain): readonly InvariantDefinition[] {
  return ALL_INVARIANTS.filter((invariant) => invariant.domain === domain);
}

export function findInvariant(id: string): InvariantDefinition | undefined {
  return ALL_INVARIANTS.find((invariant) => invariant.id === id);
}
