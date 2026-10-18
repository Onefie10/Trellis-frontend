import {
  isGranted,
  normalizeRole,
  type Action,
  type Role,
} from '@/lib/permissions';

/**
 * Telemetry capabilities, derived from the centralized permission matrix.
 *
 * This file used to hold a hand-maintained `Record<TelemetryRole, Capabilities>`
 * table, with a second and incompatible role vocabulary
 * (`viewer | operator | admin`) and a comment telling the reader to "keep in
 * sync with CAPS". That is precisely the duplication this module removes: every
 * flag below is now the matrix's answer for a specific action, so a grant cannot
 * change in `lib/permissions.ts` and leave this table lying.
 *
 * One action per capability tier:
 *
 * | Capability           | Matrix action            | viewer | operator | admin |
 * |----------------------|--------------------------|--------|----------|-------|
 * | `canConnect`         | `view_telemetry`         | yes    | yes      | yes   |
 * | `canFilterByAgent`   | `view_telemetry_details` | no     | yes      | yes   |
 * | `canViewErrorDetails`| `view_telemetry_details` | no     | yes      | yes   |
 * | `canExport`          | `export_telemetry`       | no     | no       | yes   |
 * | `canUseDebugSeverity`| `view_telemetry_details` | no     | yes      | yes   |
 *
 * `operator` is the old name for the matrix's `maintainer`, resolved through
 * `normalizeRole`, so the client keeps passing `'operator'` while the decision is
 * made in the matrix's vocabulary.
 *
 * Scope note: capabilities are evaluated at `project` scope, the narrowest scope
 * at which the stream exists. A `global` grant covers that; an `own` grant would
 * not.
 */

export type TelemetryRole = 'viewer' | 'operator' | 'admin';

export interface TelemetryCapabilities {
  /** See live stream at all. */
  canConnect: boolean;
  /** Filter by specific agent ref. */
  canFilterByAgent: boolean;
  /** See error/critical details (codes, sanitized messages). */
  canViewErrorDetails: boolean;
  /** Export recent events (still sanitized). */
  canExport: boolean;
  /** Adjust severity filter below info. */
  canUseDebugSeverity: boolean;
}

export const TELEMETRY_ROLES: readonly TelemetryRole[] = ['viewer', 'operator', 'admin'];

/** Narrowest scope the telemetry stream exists at. */
const TELEMETRY_SCOPE = 'project' as const;

const CAPABILITY_ACTIONS: Readonly<Record<keyof TelemetryCapabilities, Action>> = {
  canConnect: 'view_telemetry',
  canFilterByAgent: 'view_telemetry_details',
  canViewErrorDetails: 'view_telemetry_details',
  canExport: 'export_telemetry',
  canUseDebugSeverity: 'view_telemetry_details',
};

function derive(role: Role): TelemetryCapabilities {
  const derived = {} as Record<keyof TelemetryCapabilities, boolean>;
  for (const capability of Object.keys(CAPABILITY_ACTIONS) as (keyof TelemetryCapabilities)[]) {
    // `isGranted`, not `can`: a capability is an affordance, so it reflects the
    // grant rather than the conditions. `export_telemetry` carries
    // `requires_confirmation`, and an admin must still be *able* to export — the
    // confirmation is enforced when the export is performed, not when the button
    // is drawn.
    derived[capability] = isGranted(CAPABILITY_ACTIONS[capability], {
      role,
      resourceScope: TELEMETRY_SCOPE,
    });
  }
  return Object.freeze(derived);
}

/** Frozen so this can be a module-level constant: it runs on every render. */
const DERIVED: Readonly<Record<TelemetryRole, TelemetryCapabilities>> = Object.freeze({
  viewer: derive('viewer'),
  operator: derive('maintainer'),
  admin: derive('admin'),
});

export function getTelemetryCapabilities(role: TelemetryRole): TelemetryCapabilities {
  return DERIVED[role];
}

/** Maps the telemetry vocabulary onto the matrix vocabulary. */
export function telemetryRoleToRole(role: TelemetryRole): Role | undefined {
  return normalizeRole(role);
}

/**
 * Maps a matrix role onto the telemetry vocabulary the UI renders.
 *
 * `contributor` collapses to `viewer` because the capability tiers are unchanged
 * between those two roles. `guest` has no tier, and `view_telemetry` is denied to
 * guests anyway, so the session route refuses before reaching this.
 */
export function roleToTelemetryRole(role: Role): TelemetryRole | undefined {
  switch (role) {
    case 'admin':
      return 'admin';
    case 'maintainer':
      return 'operator';
    case 'viewer':
    case 'contributor':
      return 'viewer';
    default:
      return undefined;
  }
}

/** Server-side mirror for the API / WS gateway, now read from the matrix. */
export function roleAllowsAgentFilter(role: TelemetryRole): boolean {
  return getTelemetryCapabilities(role).canFilterByAgent;
}

export function roleAllowsErrorDetails(role: TelemetryRole): boolean {
  return getTelemetryCapabilities(role).canViewErrorDetails;
}
