import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import {
  ACTIONS,
  PERMISSION_MATRIX,
  ROLES,
  describeAction,
  getAllowedActions,
  getPermissionEntry,
  parseAction,
  parseRole,
  roleLevel,
} from '@/lib/permissions';

/**
 * Permission matrix introspection.
 *
 * Replaces the hand-maintained tables in `lib/telemetry/roles.ts` and
 * `lib/invitations.ts` with a read of the one matrix those tables are supposed
 * to agree with, so drift is visible instead of silent.
 *
 * `view_permissions` is itself governed by the matrix, which is the least
 * surprising possible answer: the matrix is not more secret than the roles it
 * describes, and a client that needs to know what it may do has to be able to
 * ask.
 */

/** Scope the matrix is read at: the widest a maintainer may read it. */
const MATRIX_SCOPE = 'project' as const;
export async function GET(request: NextRequest) {
  // Checked at `project` scope, the widest scope a maintainer may read. Checking
  // at `global` would fail a maintainer's own `project`-scoped grant and make the
  // endpoint admin-only, which is not the intent.
  const auth = await requirePermission(request, {
    action: 'view_permissions',
    resourceScope: MATRIX_SCOPE,
  });
  if (!auth.ok) return auth.response;

  // `?role=` and `?action=` narrow to `undefined` both when absent and when
  // invalid, so the raw params are kept to tell a `400` apart from "no filter".
  const rawRole = request.nextUrl.searchParams.get('role');
  const rawAction = request.nextUrl.searchParams.get('action');
  const role = parseRole(rawRole);
  const action = parseAction(rawAction);

  if (rawRole !== null && role === undefined) {
    return NextResponse.json(
      { error: 'invalid_role', message: `Unknown role "${rawRole}"`, knownRoles: ROLES },
      { status: 400 },
    );
  }
  if (rawAction !== null && action === undefined) {
    return NextResponse.json(
      { error: 'invalid_action', message: `Unknown action "${rawAction}"`, knownActions: ACTIONS },
      { status: 400 },
    );
  }

  if (role !== undefined && action !== undefined) {
    return NextResponse.json({ entry: getPermissionEntry(action, role) });
  }
  if (action !== undefined) {
    return NextResponse.json({
      action,
      description: describeAction(action),
      grants: ROLES.map((candidate) => getPermissionEntry(action, candidate)),
    });
  }
  if (role !== undefined) {
    return NextResponse.json({
      role,
      level: roleLevel(role),
      actions: getAllowedActions(role, MATRIX_SCOPE),
      entries: PERMISSION_MATRIX.filter((entry) => entry.role === role),
    });
  }

  return NextResponse.json({
    roles: ROLES.map((candidate) => ({
      role: candidate,
      level: roleLevel(candidate),
      actions: getAllowedActions(candidate, MATRIX_SCOPE),
    })),
    actions: ACTIONS.map((action) => ({ action, description: describeAction(action) })),
    matrix: PERMISSION_MATRIX,
  });
}
