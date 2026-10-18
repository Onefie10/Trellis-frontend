import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getPermissionEntry, type Role } from '@/lib/permissions';
import {
  getTelemetryCapabilities,
  roleToTelemetryRole,
  type TelemetryRole,
} from '@/lib/telemetry/roles';

/**
 * Telemetry session capabilities.
 *
 * This route used to read `?role=` (GET) or `body.role` (POST) and return that
 * string's capability table verbatim:
 *
 * ```ts
 * const role = parseRole(req.nextUrl.searchParams.get('role'));
 * return NextResponse.json({ role, capabilities: getTelemetryCapabilities(role) });
 * ```
 *
 * `parseRole` validated only that the value was *one of the three names* — never
 * that the caller held it. `GET /api/telemetry/session?role=admin` returned the
 * admin capability set to anyone who asked. The old comment ("Production should
 * validate JWT / session and ignore client-supplied role claims") described the
 * fix without implementing it.
 *
 * The role now comes from a signed actor token via `requirePermission`, and the
 * capabilities are derived from the matrix for the role the caller actually
 * holds. A `?role=` or `body.role` is no longer read at all: a client that sends
 * one is ignored rather than obeyed.
 */

/** Narrowest scope the telemetry stream exists at. */
const TELEMETRY_SCOPE = 'project' as const;

function sessionPayload(role: Role, telemetryRole: TelemetryRole) {
  return {
    /**
     * The client renders with the telemetry vocabulary, because
     * `features/agent-telemetry` types its role state as `TelemetryRole`. The
     * authorizing role is reported as `matrix` alongside it so an operator can
     * tell which vocabulary they are looking at.
     */
    role: { telemetry: telemetryRole, matrix: role },
    // Echoed so a caller can see which grants were consulted without a second
    // round trip to `/api/permissions`.
    grants: {
      viewTelemetry: getPermissionEntry('view_telemetry', role),
      viewTelemetryDetails: getPermissionEntry('view_telemetry_details', role),
    },
    capabilities: getTelemetryCapabilities(telemetryRole),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requirePermission(request, {
    action: 'view_telemetry',
    resourceScope: TELEMETRY_SCOPE,
  });
  if (!auth.ok) return auth.response;

  const telemetryRole = roleToTelemetryRole(auth.actor.role);
  if (!telemetryRole) {
    // `view_telemetry` is denied to `guest`, so reaching here means the matrix
    // and the telemetry vocabulary have drifted apart. Refusing beats guessing.
    return NextResponse.json(
      { error: 'unsupported_role', message: `No telemetry role for "${auth.actor.role}"` },
      { status: 403 },
    );
  }

  return NextResponse.json(sessionPayload(auth.actor.role, telemetryRole));
}

export async function POST(request: NextRequest) {
  return GET(request);
}
