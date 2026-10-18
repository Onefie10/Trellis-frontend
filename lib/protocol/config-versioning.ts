/**
 * Protocol configuration versioning and compatibility checks (#178).
 *
 * Trellis configuration (commission tiers, claim-link rules, governance
 * thresholds, …) changes over time, and clients, APIs and contracts must be
 * able to detect incompatible assumptions *before* an operation runs against
 * configuration it does not understand.
 *
 * Design:
 *
 *   - A **registry** declares the configuration surfaces the frontend consumes,
 *     each with a semantic version, a minimum supported version, deprecation
 *     metadata, and a per-version compatibility matrix (whether the version is
 *     usable as-is, needs a migration, or must be rejected).
 *
 *   - `validateProtocolCompatibility` is the single gate every dependent
 *     operation calls before executing. Incompatible versions throw
 *     `ProtocolConfigIncompatibleError` (early, with a user-safe message and a
 *     machine-readable code) instead of letting a mismatch surface as a failed
 *     transaction later. Compatible versions return a result with no warnings.
 *
 *   - Everything is **pure and injectable**: the registry is passed in, time is
 *     passed in, so tests are deterministic and no global state is mutated.
 *
 * Version classes:
 *
 *   current             → compatible, no warnings
 *   old but compatible  → compatible, `deprecation` warning when deprecated
 *   old, incompatible   → `ProtocolConfigIncompatibleError` (`VERSION_TOO_OLD`)
 *   future, unknown     → `ProtocolConfigIncompatibleError` (`VERSION_UNKNOWN`)
 */

import type { ProtocolOperation } from './operations';

/** What a consumer must do with a given configuration version. */
export type ConfigCompatibility = 'supported' | 'migration_required' | 'incompatible';

/** A protocol configuration surface the frontend consumes. */
export interface ProtocolConfigDescriptor {
  /** Stable identifier, e.g. `commission_tiers`. */
  readonly id: string;
  /** Human-readable description for error messages and docs. */
  readonly description: string;
  /** The version this build was written against. */
  readonly currentVersion: string;
  /** Last version this build refuses to run against (exclusive floor). */
  readonly minSupportedVersion: string;
  /** Optional deprecation notice attached to older-but-supported versions. */
  readonly deprecation?: ConfigDeprecation;
  /** Per-version compatibility verdicts; defaults are derived for unmapped versions. */
  readonly compatibility?: Readonly<Record<string, ConfigCompatibility>>;
}

export interface ConfigDeprecation {
  /** Version in which the surface was deprecated. */
  readonly deprecatedIn: string;
  /** Version after which it stops working — consumers must migrate before it. */
  readonly removalIn: string;
  /** What to use instead. */
  readonly message: string;
}

/** The version being validated, with the verdict computed for it. */
export interface ProtocolConfigVersion {
  readonly configId: string;
  readonly version: string;
  readonly compatibility: ConfigCompatibility;
}

/** Options accepted by every validation entry point. */
export interface ValidateCompatibilityOptions {
  /** Overrides the descriptor's deprecation check (used by tests and rollout tooling). */
  readonly ignoreDeprecation?: boolean;
}

export interface CompatibilityWarning {
  readonly code: 'CONFIG_DEPRECATED';
  readonly configId: string;
  readonly version: string;
  readonly message: string;
}

export interface CompatibilityValidationResult {
  readonly ok: boolean;
  readonly configs: readonly ProtocolConfigVersion[];
  /** Non-empty exactly when every config is compatible but at least one is deprecated. */
  readonly warnings: readonly CompatibilityWarning[];
}

/** Error codes carried by `ProtocolConfigIncompatibleError`. */
export type ConfigIncompatibilityCode = 'VERSION_TOO_OLD' | 'VERSION_UNKNOWN' | 'MIGRATION_REQUIRED';

/**
 * Thrown before any dependent operation executes when configuration
 * compatibility cannot be established. The message is user-safe: it names the
 * surface and the action to take, never internal details.
 */
export class ProtocolConfigIncompatibleError extends Error {
  readonly code: ConfigIncompatibilityCode;
  readonly configId: string;
  readonly version: string;
  readonly supportedRange: string;

  constructor(params: {
    code: ConfigIncompatibilityCode;
    configId: string;
    version: string;
    currentVersion: string;
    minSupportedVersion: string;
  }) {
    const { code, configId, version, currentVersion, minSupportedVersion } = params;
    let message: string;
    switch (code) {
      case 'VERSION_TOO_OLD':
        message =
          `Your app data for "${configId}" (v${version}) is too old to be used safely. ` +
          `Update to at least v${minSupportedVersion} (current: v${currentVersion}).`;
        break;
      case 'VERSION_UNKNOWN':
        message =
          `Configuration "${configId}" v${version} is newer than this app supports ` +
          `(current: v${currentVersion}). Update the app before continuing.`;
        break;
      case 'MIGRATION_REQUIRED':
        message =
          `Configuration "${configId}" v${version} must be migrated before use ` +
          `(current: v${currentVersion}). Retry the operation to apply the migration.`;
        break;
    }
    super(message);
    this.name = 'ProtocolConfigIncompatibleError';
    this.code = code;
    this.configId = configId;
    this.version = version;
    this.supportedRange = `>=${minSupportedVersion} <=${currentVersion}`;
  }
}

// ---------------------------------------------------------------------------
// Semantic version comparison (subset needed here: numeric x.y[.z] versions)
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+(?:\.\d+)?$/;

/** Validates `x.y` or `x.y.z`; returns false for pre-release tags and garbage. */
export function isValidConfigVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

/** Numeric semver comparison; `-1`, `0` or `1`. Throws on malformed versions. */
export function compareConfigVersions(a: string, b: string): -1 | 0 | 1 {
  if (!isValidConfigVersion(a)) throw new Error(`Invalid protocol config version: "${a}"`);
  if (!isValidConfigVersion(b)) throw new Error(`Invalid protocol config version: "${b}"`);
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Immutable registry of configuration descriptors. Built from a plain array so
 * callers can share one literal between the gate and the docs; lookups are
 * indexed for O(1) validation.
 */
export class ProtocolConfigRegistry {
  private readonly byId: ReadonlyMap<string, ProtocolConfigDescriptor>;

  constructor(descriptors: readonly ProtocolConfigDescriptor[]) {
    const map = new Map<string, ProtocolConfigDescriptor>();
    for (const descriptor of descriptors) {
      if (!isValidConfigVersion(descriptor.currentVersion)) {
        throw new Error(
          `Config "${descriptor.id}" has an invalid currentVersion: "${descriptor.currentVersion}"`,
        );
      }
      if (!isValidConfigVersion(descriptor.minSupportedVersion)) {
        throw new Error(
          `Config "${descriptor.id}" has an invalid minSupportedVersion: "${descriptor.minSupportedVersion}"`,
        );
      }
      if (
        compareConfigVersions(descriptor.minSupportedVersion, descriptor.currentVersion) > 0
      ) {
        throw new Error(
          `Config "${descriptor.id}": minSupportedVersion (${descriptor.minSupportedVersion}) ` +
            `is newer than currentVersion (${descriptor.currentVersion})`,
        );
      }
      map.set(descriptor.id, descriptor);
    }
    this.byId = map;
  }

  get(id: string): ProtocolConfigDescriptor | undefined {
    return this.byId.get(id);
  }

  ids(): readonly string[] {
    return [...this.byId.keys()];
  }
}

/**
 * Resolve the compatibility verdict for `version` against `descriptor`.
 *
 * An explicit per-version entry wins; otherwise:
 *   newer than current        → `incompatible` (unknown future version)
 *   below minSupported        → `incompatible` (too old)
 *   otherwise                 → `supported`
 * (`migration_required` is always an explicit registry decision — guessing a
 * migration by version arithmetic would be a lie.)
 */
export function resolveConfigCompatibility(
  descriptor: ProtocolConfigDescriptor,
  version: string,
): ConfigCompatibility {
  if (!isValidConfigVersion(version)) {
    // Malformed versions are treated as unknown/incompatible, not a crash: the
    // validation gate turns this into a user-safe error.
    return 'incompatible';
  }
  const explicit = descriptor.compatibility?.[version];
  if (explicit) return explicit;

  if (compareConfigVersions(version, descriptor.currentVersion) > 0) {
    return 'incompatible';
  }
  if (compareConfigVersions(version, descriptor.minSupportedVersion) < 0) {
    return 'incompatible';
  }
  return 'supported';
}

/**
 * Validate one configuration version. Throws `ProtocolConfigIncompatibleError`
 * for old-incompatible, future-unknown and migration-required versions; returns
 * the resolved verdict for compatible ones.
 */
export function validateProtocolConfigVersion(
  registry: ProtocolConfigRegistry,
  configId: string,
  version: string,
  options: ValidateCompatibilityOptions = {},
): ProtocolConfigVersion {
  const descriptor = registry.get(configId);
  if (!descriptor) {
    throw new Error(`Unknown protocol configuration: "${configId}"`);
  }
  const compatibility = resolveConfigCompatibility(descriptor, version);
  if (compatibility === 'incompatible') {
    // Distinguish "too old" from "from the future" so the message can tell the
    // user whether to update their data or update the app.
    const isFuture =
      isValidConfigVersion(version) &&
      compareConfigVersions(version, descriptor.currentVersion) > 0;
    throw new ProtocolConfigIncompatibleError({
      code: isFuture ? 'VERSION_UNKNOWN' : 'VERSION_TOO_OLD',
      configId,
      version,
      currentVersion: descriptor.currentVersion,
      minSupportedVersion: descriptor.minSupportedVersion,
    });
  }
  if (compatibility === 'migration_required') {
    throw new ProtocolConfigIncompatibleError({
      code: 'MIGRATION_REQUIRED',
      configId,
      version,
      currentVersion: descriptor.currentVersion,
      minSupportedVersion: descriptor.minSupportedVersion,
    });
  }
  if (!options.ignoreDeprecation && isConfigVersionDeprecated(descriptor, version)) {
    // Compatible-but-deprecated stays compatible; the warning surfaces through
    // the batch API so callers can log it without failing the operation.
    return { configId, version, compatibility };
  }
  return { configId, version, compatibility };
}

/** True when `version` is supported but flagged deprecated in the registry. */
export function isConfigVersionDeprecated(
  descriptor: ProtocolConfigDescriptor,
  version: string,
): boolean {
  if (!descriptor.deprecation) return false;
  const { deprecatedIn } = descriptor.deprecation;
  if (!isValidConfigVersion(version) || !isValidConfigVersion(deprecatedIn)) return false;
  return compareConfigVersions(version, deprecatedIn) >= 0;
}

/**
 * Deprecation warning for a compatible version, or `null` when none applies
 * (current versions, versions below the deprecation point, or undeprecated
 * surfaces). Pure — no console output — so the caller decides how to surface it.
 */
export function getConfigDeprecationWarning(
  descriptor: ProtocolConfigDescriptor,
  version: string,
): CompatibilityWarning | null {
  if (!descriptor.deprecation) return null;
  // The current version is never "deprecated" — the flag describes the
  // transition period for older-but-still-supported versions only.
  if (
    !isValidConfigVersion(version) ||
    compareConfigVersions(version, descriptor.currentVersion) >= 0
  ) {
    return null;
  }
  if (!isConfigVersionDeprecated(descriptor, version)) return null;
  if (resolveConfigCompatibility(descriptor, version) !== 'supported') return null;
  return {
    code: 'CONFIG_DEPRECATED',
    configId: descriptor.id,
    version,
    message:
      `Configuration "${descriptor.id}" v${version} is deprecated since v${descriptor.deprecation.deprecatedIn} ` +
      `and will stop working after v${descriptor.deprecation.removalIn}. ${descriptor.deprecation.message}`,
  };
}

/**
 * Validate a batch of configuration versions — the entry point an operation
 * calls right before it executes.
 *
 * Returns `{ ok: true, warnings: [...] }` when every version is usable
 * (warnings only for deprecated surfaces), or throws the first
 * `ProtocolConfigIncompatibleError` in declaration order. Compatible versions
 * produce no warnings; that is asserted by tests.
 */
export function validateProtocolCompatibility(
  registry: ProtocolConfigRegistry,
  versions: readonly ProtocolConfigVersionInput[],
  options: ValidateCompatibilityOptions = {},
): CompatibilityValidationResult {
  const resolved: ProtocolConfigVersion[] = [];
  const warnings: CompatibilityWarning[] = [];

  for (const { configId, version } of versions) {
    // Reuse the single-version gate so batch and single semantics cannot diverge.
    resolved.push(validateProtocolConfigVersion(registry, configId, version, options));
    const descriptor = registry.get(configId);
    if (descriptor) {
      const warning = getConfigDeprecationWarning(descriptor, version);
      if (warning && !options.ignoreDeprecation) warnings.push(warning);
    }
  }

  return { ok: true, configs: resolved, warnings };
}

export interface ProtocolConfigVersionInput {
  readonly configId: string;
  readonly version: string;
}

/**
 * Convenience gate for operations: validate compatibility, then run `operation`.
 * The operation only ever sees a validated environment; rejection happens
 * before any side effect.
 */
export async function withProtocolCompatibility<T>(
  registry: ProtocolConfigRegistry,
  versions: readonly ProtocolConfigVersionInput[],
  operation: () => Promise<T>,
  options: ValidateCompatibilityOptions = {},
): Promise<T> {
  validateProtocolCompatibility(registry, versions, options);
  return operation();
}

// ---------------------------------------------------------------------------
// Default registry — the configuration surfaces this frontend consumes.
// Version history mirrors CHANGELOG.md; bump these entries with each change.
// ---------------------------------------------------------------------------

/**
 * The production registry. Kept as data (not code) so it can be rendered into
 * docs and asserted against fixtures without executing anything.
 */
export const DEFAULT_PROTOCOL_CONFIG_REGISTRY = new ProtocolConfigRegistry([
  {
    id: 'commission_tiers',
    description: 'Affiliate multi-tier commission rates (direct / tier-2 / tier-3)',
    currentVersion: '2.0.0',
    minSupportedVersion: '1.1.0',
    deprecation: {
      deprecatedIn: '1.1.0',
      removalIn: '3.0.0',
      message: 'Migrate stored commission snapshots to the v2 shape before v3 ships.',
    },
    compatibility: {
      '1.1.0': 'supported',
      '1.0.0': 'incompatible',
      '2.0.0': 'supported',
    },
  },
  {
    id: 'claim_link_rules',
    description: 'Claim-link expiry, max-uses and amount-threshold rules',
    currentVersion: '1.2.0',
    minSupportedVersion: '1.0.0',
    compatibility: {
      '1.2.0': 'supported',
      '1.1.0': 'supported',
      '1.0.0': 'supported',
    },
  },
  {
    id: 'governance_thresholds',
    description: 'Proposal quorum, timelock duration and execution thresholds',
    currentVersion: '1.0.0',
    minSupportedVersion: '1.0.0',
  },
]);

/**
 * Operations, paired with the configuration surfaces they depend on. The
 * preflight gate (#175) consults this list so an operation cannot run against
 * configuration versions it was never validated against.
 */
export const OPERATION_CONFIG_DEPENDENCIES: Readonly<
  Record<ProtocolOperation, readonly string[]>
> = Object.freeze({
  transfer_funds: ['claim_link_rules'],
  claim_payout: ['commission_tiers'],
  mint_agent: ['claim_link_rules'],
  update_governance: ['governance_thresholds'],
  retry_operation: [],
});

/** Config versions observed in the shipped client, for the validation script. */
export const CLIENT_CONFIG_VERSIONS: readonly ProtocolConfigVersionInput[] = [
  { configId: 'commission_tiers', version: '2.0.0' },
  { configId: 'claim_link_rules', version: '1.2.0' },
  { configId: 'governance_thresholds', version: '1.0.0' },
];
