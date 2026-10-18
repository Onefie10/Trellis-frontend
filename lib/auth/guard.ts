import { NextResponse } from 'next/server';
import {
  checkPermission,
  parseAction,
  parseScope,
  type Action,
  type PermissionDecision,
  type Scope,
} from '@/lib/permissions';
import { resolveActor, type Actor, type ActorResolutionFailure } from '@/lib/auth/actor';

/**
 * Request-level enforcement for `@/lib/permissions`.
 *
 * Route handlers call `requirePermission` first and branch on `ok`. That shape is
 * deliberate: the failure branch returns a response, so a handler physically
 * cannot continue past an authorization failure by forgetting an `if`.
 */

export interface RequirePermissionRequest {
  action: Action;
  resourceOwnerId?: string;
  resourceScope?: Scope;
  context?: {
    confirmed?: boolean;
    actionCountToday?: number;
    amount?: string;
    resourceCount?: number;
  };
}

export type AuthorizationResult =
  | { ok: true; actor: Actor; decision: PermissionDecision }
  | { ok: false; status: 401 | 403 | 500; response: NextResponse };

/**
 * Maps an identity failure to the status that describes it correctly.
 *
 * Never returns `403`: at this point no action has been checked, so the only
 * question is whether the caller proved who they are. A `403` is produced later,
 * by `checkPermission`.
 */
function statusForFailure(failure: ActorResolutionFailure): 401 | 500 {
  // A missing server secret is our bug, not the caller's fault, and must not be
  // reported as an auth problem.
  if (failure === 'server_misconfigured') return 500;
  // Everything else is "we could not establish who you are".
  return 401;
}

function authError(
  status: 401 | 403 | 500,
  body: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: body }, { status });
}

/**
 * Builds the `403` body for a denial.
 *
 * Exported so a route that must validate the request, or load the target
 * resource, *before* it can authorize can still reuse the exact same response
 * shape as `requirePermission` instead of hand-rolling a second one that drifts.
 */
export function deniedResponse(decision: PermissionDecision): NextResponse {
  return authError(403, {
    code: decision.code,
    message: decision.reason,
    action: decision.action,
    // Tells the caller what role would actually be needed. Safe to expose:
    // it is already documented in `lib/permissions.ts` and the PR.
    minimumRole: decision.minimumRole,
    outstandingConditions: decision.outstandingConditions,
  });
}

/**
 * Resolves the actor and checks one action against the matrix.
 *
 * Returns the actor and decision on success so the handler does not have to
 * resolve identity a second time.
 *
 * Use `requireActor` + `checkPermission` + `deniedResponse` instead when the
 * handler has to parse the request, or load the target resource, before it can
 * decide the applicable scope or conditions — the identity half then runs first
 * on its own.
 */
export async function requirePermission(
  request: { headers: { get(name: string): string | null } },
  requirement: RequirePermissionRequest,
): Promise<AuthorizationResult> {
  const resolution = await resolveActor(request);

  if (!resolution.ok) {
    const status = statusForFailure(resolution.failure);
    const body: Record<string, unknown> = {
      code: resolution.failure,
      message: resolution.message,
    };
    if (status === 500) {
      // Do not leak the expected secret length or configuration detail further
      // than naming the missing variable.
      body.error = 'server_misconfigured';
      body.message = 'Authorization is not configured on this server';
    }
    return { ok: false, status, response: authError(status, body) };
  }

  const decision = checkPermission(requirement.action, {
    role: resolution.actor.role,
    actorId: resolution.actor.id,
    resourceOwnerId: requirement.resourceOwnerId,
    resourceScope: requirement.resourceScope,
    context: requirement.context,
  });

  if (!decision.allowed) {
    return { ok: false, status: 403, response: deniedResponse(decision) };
  }

  return { ok: true, actor: resolution.actor, decision };
}

/**
 * Resolves the actor without checking a specific action.
 *
 * For endpoints whose only requirement is "a signed-in user", such as accepting
 * an invitation. Still refuses unauthenticated callers.
 */
export async function requireActor(
  request: { headers: { get(name: string): string | null } },
): Promise<
  { ok: true; actor: Actor } | { ok: false; status: 401 | 500; response: NextResponse }
> {
  const resolution = await resolveActor(request);
  if (!resolution.ok) {
    const status = statusForFailure(resolution.failure);
    return {
      ok: false,
      status,
      response: authError(status, {
        code: resolution.failure,
        message: status === 500 ? 'Authorization is not configured on this server' : resolution.message,
      }),
    };
  }
  return { ok: true, actor: resolution.actor };
}

/**
 * Narrows an untrusted action or scope from a URL query string.
 *
 * Returns `undefined` rather than a default so a typo is a `400`, not a silent
 * fallback to some action the caller did not ask for.
 */
export function parseActionParam(value: string | null): Action | undefined {
  return parseAction(value);
}

export function parseScopeParam(value: string | null): Scope | undefined {
  return parseScope(value);
}
