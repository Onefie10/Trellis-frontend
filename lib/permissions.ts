import { z } from 'zod';

/**
 * Centralised permission matrix.
 *
 * Why this exists: authorization was spread across three modules with three
 * incompatible role vocabularies — `lib/policy-engine.ts` (`admin | maintainer |
 * user | guest`), `lib/invitations.ts` (`viewer | contributor | maintainer |
 * admin`, with its own `roleHierarchy` and its own `canEscalateRole`), and
 * `lib/telemetry/roles.ts` (`viewer | operator | admin`). Route handlers then
 * reached for whichever helper they happened to find, so "is this allowed?" had
 * no single answer and no way to be tested exhaustively.
 *
 * This module is that single answer. It is deliberately pure — no request, no
 * environment, no I/O — so it can be unit-tested exhaustively and imported from
 * both server and client. Identity resolution and request-level rejection live in
 * `lib/auth/`.
 *
 * The matrix is declared per action as grants for every role, then expanded.
 * That structure makes "every privileged action maps to a permission entry" true
 * by construction rather than by review: a new action cannot be added without
 * making an explicit grant-or-deny decision for all five roles.
 *
 * Scope: role/scope/condition authorization. Rate limiting stays in
 * `lib/security/rate-limit`, business rules stay in `lib/policy-engine.ts`.
 */

export const ROLES = ['guest', 'viewer', 'contributor', 'maintainer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Scope of the resource being acted on, ordered narrowest to widest.
 *
 * `any` means the grant is not scope-constrained, for actions that are equally
 * valid anywhere (e.g. accepting your own invitation).
 */
export const SCOPES = ['own', 'resource', 'project', 'global', 'any'] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * Every privileged maintainer and service action.
 *
 * Derived from an audit of the privileged surfaces in this repository:
 *
 * | `view_analytics`        | `app/api/metrics/*`, `app/api/analytics`               |
 * | `view_telemetry`        | `app/api/telemetry/session`                            |
 * | `view_telemetry_details`| the `canFilterByAgent` / `canViewErrorDetails` tiers    |
 * | `export_telemetry`      | the `canExport` tier of `lib/telemetry/roles.ts`        |
 * | `export_data`           | `app/api/export`, `app/api/security` (export action)   |
 * | `import_data`           | `app/api/import`                                       |
 * | `manage_webhooks`       | `components/notifications/WebhookManager`              |
 * | `manage_billing`        | payout and plan management                             |
 * | `view_audit_logs`       | `app/api/security` (audit-history action)              |
 * | `manage_security`       | `app/api/security` (record-audit action)               |
 * | `run_retention_cleanup` | `app/api/retention/run` — irreversible data deletion  |
 * | `retry_operation`       | `lib/policy-engine.ts`, which declared it with no entry|
 * | `create_invitation` …   | `lib/invitations.ts` lifecycle                         |
 * | `view_permissions`      | `app/api/permissions`                                  |
 *
 * Adding an entry here is the only way to introduce a new action: `MATRIX` is
 * typed `Record<Action, ActionDefinition>`, so the compiler rejects an action
 * that has no per-role decision.
 */
export const ACTIONS = [
  'create_agent',
  'read_agent',
  'update_agent',
  'delete_agent',
  'transfer_funds',
  'invite_collaborator',
  'manage_members',
  'escalate_role',
  'impersonate_user',
  'view_analytics',
  'view_telemetry',
  'view_telemetry_details',
  'export_telemetry',
  'export_data',
  'import_data',
  'manage_webhooks',
  'manage_billing',
  'view_audit_logs',
  'manage_security',
  'run_retention_cleanup',
  'create_invitation',
  'revoke_invitation',
  'accept_invitation',
  'reject_invitation',
  'retry_operation',
  'view_permissions',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Extra predicates a grant can carry. These narrow an allow; they can never
 * turn a deny into an allow.
 */
export const PERMISSION_CONDITIONS = [
  'owner_only',
  'requires_confirmation',
  'rate_limited',
  'max_resources',
  'max_amount',
  'scope_restricted',
] as const;
export type PermissionConditionType = (typeof PERMISSION_CONDITIONS)[number];

export type PermissionCondition =
  | { type: 'owner_only' }
  | { type: 'requires_confirmation' }
  | { type: 'rate_limited'; maxPerDay: number }
  | { type: 'max_resources'; limit: number }
  /** Base-unit integer string, matching Stellar's stroop amounts. */
  | { type: 'max_amount'; limit: string }
  | { type: 'scope_restricted'; allowedScopes: Scope[] };

export type Effect = 'allow' | 'deny';

export interface PermissionEntry {
  action: Action;
  role: Role;
  /** Narrowest scope at which this grant takes effect. */
  scope: Scope;
  effect: Effect;
  conditions: PermissionCondition[];
  description: string;
}

interface Grant {
  scope: Scope;
  conditions?: PermissionCondition[];
}

interface ActionDefinition {
  description: string;
  grants: { [R in Role]: Grant | { effect: 'deny' } };
}

/** Deny shorthand so each definition stays readable. */
const DENY = { effect: 'deny' } as const;

const ownerOnly: PermissionCondition[] = [{ type: 'owner_only' }];

/**
 * The matrix.
 *
 * Kept as one declaration per action, with an explicit entry for every role, so
 * a reviewer can audit a single action top-to-bottom without cross-referencing
 * a flat 120-row list.
 */
const MATRIX: Record<Action, ActionDefinition> = {
  create_agent: {
    description: 'Publish a new agent to the marketplace',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'project' },
      viewer: DENY,
      guest: DENY,
    },
  },
  read_agent: {
    description: 'View agent metadata and listings',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'project' },
      viewer: { scope: 'project' },
      guest: { scope: 'own' },
    },
  },
  update_agent: {
    description: 'Modify an existing agent definition',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'own', conditions: ownerOnly },
      viewer: DENY,
      guest: DENY,
    },
  },
  delete_agent: {
    description: 'Remove an agent definition',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'own', conditions: ownerOnly },
      viewer: DENY,
      guest: DENY,
    },
  },
  transfer_funds: {
    description: 'Move Stellar assets between accounts',
    grants: {
      // Deliberately bounded. Unbounded fund movement is the highest-consequence
      // action in the system, so even admin is capped and must confirm.
      admin: {
        scope: 'global',
        conditions: [{ type: 'max_amount', limit: '1000000000000' }, { type: 'requires_confirmation' }],
      },
      maintainer: {
        scope: 'project',
        conditions: [{ type: 'max_amount', limit: '10000000000' }, { type: 'requires_confirmation' }],
      },
      contributor: {
        scope: 'own',
        conditions: ownerOnly.concat([
          { type: 'max_amount', limit: '1000000' },
          { type: 'requires_confirmation' },
        ]),
      },
      viewer: DENY,
      guest: DENY,
    },
  },
  invite_collaborator: {
    description: 'Invite an external party to collaborate',
    grants: {
      admin: { scope: 'global', conditions: [{ type: 'rate_limited', maxPerDay: 50 }] },
      maintainer: { scope: 'project', conditions: [{ type: 'rate_limited', maxPerDay: 20 }] },
      contributor: { scope: 'project', conditions: [{ type: 'rate_limited', maxPerDay: 5 }] },
      viewer: DENY,
      guest: DENY,
    },
  },
  manage_members: {
    description: 'Add, remove, or change project membership',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  escalate_role: {
    description: 'Raise an actor to a higher role',
    grants: {
      admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
      // A maintainer may promote within their own project but not to admin;
      // `canEscalateRole` enforces the ceiling.
      maintainer: {
        scope: 'project',
        conditions: [{ type: 'requires_confirmation' }, { type: 'scope_restricted', allowedScopes: ['project', 'resource'] }],
      },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  impersonate_user: {
    description: 'Act as another user for support purposes',
    grants: {
      // The most dangerous action available. Admin-only, explicit confirmation,
      // and always audited — there is intentionally no maintainer path.
      admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
      maintainer: DENY,
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  view_analytics: {
    description: 'View aggregate platform analytics',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'project' },
      viewer: { scope: 'project' },
      guest: DENY,
    },
  },
  view_telemetry: {
    description: 'Attach to a live telemetry stream',
    grants: {
      // Telemetry is read-only and per-project, so every signed-in role may
      // attach. What they may then *do* with the stream is the next two entries.
      admin: { scope: 'global' },
      maintainer: { scope: 'global' },
      contributor: { scope: 'project' },
      viewer: { scope: 'project' },
      guest: DENY,
    },
  },
  view_telemetry_details: {
    description: 'Narrow a telemetry stream to one agent, or read error-level detail',
    grants: {
      // Narrowing to a single agent and reading sanitized error codes both
      // expose another agent's internals, so both are maintainer-and-above. They
      // were already one tier in `lib/telemetry/roles.ts`; stating it here makes
      // it auditable instead of implicit.
      admin: { scope: 'global' },
      maintainer: { scope: 'global' },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  export_telemetry: {
    description: 'Export the raw telemetry event stream off-platform',
    grants: {
      // Deliberately narrower than `export_data`: a user exporting their own
      // records is not the same as pulling the whole event stream.
      admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
      maintainer: DENY,
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  export_data: {
    description: 'Export platform or account data',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'own', conditions: ownerOnly },
      viewer: DENY,
      guest: DENY,
    },
  },
  import_data: {
    description: 'Bulk-import records from an external file',
    grants: {
      // A bulk import writes many records at once, so the maintainer grant is
      // capped per day rather than being an unbounded write primitive.
      admin: { scope: 'global', conditions: [{ type: 'rate_limited', maxPerDay: 100 }] },
      maintainer: { scope: 'project', conditions: [{ type: 'rate_limited', maxPerDay: 20 }] },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  manage_webhooks: {
    description: 'Register, rotate, or delete webhook endpoints',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  manage_billing: {
    description: 'Change payment methods, invoices, or plan',
    grants: {
      admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
      maintainer: DENY,
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  view_audit_logs: {
    description: 'Read the security audit trail',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  manage_security: {
    description: 'Change platform security settings or record a security audit entry',
    grants: {
      // Recording an audit entry appends to the trail that `view_audit_logs`
      // serves, so an actor able to write it could launder a finding. Admin only.
      admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
      maintainer: DENY,
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  run_retention_cleanup: {
    description: 'Delete records that have passed their retention window',
    grants: {
      // Irreversible, and it runs across every data class, so there is
      // intentionally no maintainer path. The `requires_confirmation` condition
      // is what a handler satisfies by honouring an explicit `dryRun: false` in
      // the request body: a dry run alone is never enough to delete anything.
      admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
      maintainer: DENY,
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
  create_invitation: {
    description: 'Issue an invitation link',
    grants: {
      admin: { scope: 'global', conditions: [{ type: 'rate_limited', maxPerDay: 100 }] },
      maintainer: { scope: 'project', conditions: [{ type: 'rate_limited', maxPerDay: 25 }] },
      contributor: { scope: 'project', conditions: [{ type: 'rate_limited', maxPerDay: 5 }] },
      viewer: DENY,
      guest: DENY,
    },
  },
  revoke_invitation: {
    description: 'Invalidate an outstanding invitation',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'own', conditions: ownerOnly },
      viewer: DENY,
      guest: DENY,
    },
  },
  accept_invitation: {
    description: 'Accept an invitation addressed to you',
    grants: {
      // Every role may accept. This is the one action that is not privileged, and
      // it is scoped `any` because the target is the actor's own membership.
      admin: { scope: 'any' },
      maintainer: { scope: 'any' },
      contributor: { scope: 'any' },
      viewer: { scope: 'any' },
      guest: { scope: 'any' },
    },
  },
  reject_invitation: {
    description: 'Decline an invitation addressed to you',
    grants: {
      admin: { scope: 'any' },
      maintainer: { scope: 'any' },
      contributor: { scope: 'any' },
      viewer: { scope: 'any' },
      guest: { scope: 'any' },
    },
  },
  retry_operation: {
    description: 'Force an immediate retry of a failed operation',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: { scope: 'own', conditions: ownerOnly },
      viewer: DENY,
      guest: DENY,
    },
  },
  view_permissions: {
    description: 'Read the permission matrix itself',
    grants: {
      admin: { scope: 'global' },
      maintainer: { scope: 'project' },
      contributor: DENY,
      viewer: DENY,
      guest: DENY,
    },
  },
};

/** Numeric rank used for scope comparison. `any` is exempt from comparison. */
const SCOPE_RANK: Record<Scope, number> = {
  own: 1,
  resource: 2,
  project: 3,
  global: 4,
  any: Number.POSITIVE_INFINITY,
};

const ROLE_RANK: Record<Role, number> = {
  guest: 0,
  viewer: 1,
  contributor: 2,
  maintainer: 3,
  admin: 4,
};

/**
 * The fully expanded matrix: one entry per action per role.
 *
 * Derived from `MATRIX` rather than hand-written, which is what guarantees the
 * acceptance criterion that every privileged action maps to a permission entry.
 */
export const PERMISSION_MATRIX: readonly PermissionEntry[] = Object.freeze(
  ACTIONS.flatMap((action) => {
    const definition = MATRIX[action];
    return ROLES.map((role): PermissionEntry => {
      const grant = definition.grants[role];
      const isDeny = 'effect' in grant && grant.effect === 'deny';
      return Object.freeze({
        action,
        role,
        scope: isDeny ? 'any' : (grant as Grant).scope,
        effect: isDeny ? 'deny' : 'allow',
        conditions: isDeny ? [] : [...((grant as Grant).conditions ?? [])],
        description: definition.description,
      });
    });
  })
);

const ENTRY_INDEX: ReadonlyMap<string, PermissionEntry> = new Map(
  PERMISSION_MATRIX.map((entry) => [`${entry.action}:${entry.role}`, entry]),
);

export function getPermissionEntry(action: Action, role: Role): PermissionEntry {
  const entry = ENTRY_INDEX.get(`${action}:${role}`);
  // The matrix is total by construction, so a miss means a bug, not bad input.
  if (!entry) {
    throw new Error(`No permission entry for action ${action} and role ${role}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Zod mirrors, so the matrix can be validated in tests and at API boundaries.
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(ROLES);
export const ScopeSchema = z.enum(SCOPES);
export const ActionSchema = z.enum(ACTIONS);

export const PermissionConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('owner_only') }),
  z.object({ type: z.literal('requires_confirmation') }),
  z.object({ type: z.literal('rate_limited'), maxPerDay: z.number().int().positive() }),
  z.object({ type: z.literal('max_resources'), limit: z.number().int().positive() }),
  z.object({ type: z.literal('max_amount'), limit: z.string().regex(/^\d+$/) }),
  z.object({ type: z.literal('scope_restricted'), allowedScopes: z.array(ScopeSchema).min(1) }),
]);

export const PermissionEntrySchema = z.object({
  action: ActionSchema,
  role: RoleSchema,
  scope: ScopeSchema,
  effect: z.enum(['allow', 'deny']),
  conditions: z.array(PermissionConditionSchema),
  description: z.string().min(1),
});

export const PermissionMatrixSchema = z.array(PermissionEntrySchema).length(
  ACTIONS.length * ROLES.length,
);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PermissionCheckInput {
  role: Role;
  /** Stable id of the acting principal, e.g. a wallet address. */
  actorId?: string;
  /** Owner of the resource being acted on. Required by `owner_only`. */
  resourceOwnerId?: string;
  /** Scope the action is being performed in. Required for scope-limited grants. */
  resourceScope?: Scope;
  /** Facts the conditions are evaluated against. */
  context?: {
    confirmed?: boolean;
    /** Times this actor has performed the action today. */
    actionCountToday?: number;
    /** Amount in base units, as a decimal string. */
    amount?: string;
    resourceCount?: number;
  };
}

export type PermissionDenialCode =
  | 'denied_by_policy'
  | 'insufficient_scope'
  | 'condition_failed'
  | 'unknown_actor';

export interface PermissionDecision {
  allowed: boolean;
  /** Stable machine-readable code. Absent when allowed. */
  code?: PermissionDenialCode;
  /** Operator-facing explanation, safe to return to the client. */
  reason: string;
  action: Action;
  role: Role;
  /** Lowest role that would be allowed at the requested scope, for `403` bodies. */
  minimumRole?: Role;
  conditions: PermissionCondition[];
  /** Conditions that still need to be satisfied, when the grant is otherwise valid. */
  outstandingConditions: PermissionCondition[];
}

function conditionFailure(
  condition: PermissionCondition,
  input: PermissionCheckInput,
): string | null {
  switch (condition.type) {
    case 'owner_only': {
      if (!input.actorId) return 'Actor identity is required for an owner-only action';
      if (!input.resourceOwnerId) return 'Resource owner could not be determined';
      if (input.actorId !== input.resourceOwnerId) {
        return 'Action is restricted to the resource owner';
      }
      return null;
    }
    case 'requires_confirmation': {
      if (!input.context?.confirmed) {
        return 'Action requires explicit confirmation';
      }
      return null;
    }
    case 'rate_limited': {
      const used = input.context?.actionCountToday ?? 0;
      if (used >= condition.maxPerDay) {
        return `Rate limit exceeded: ${used}/${condition.maxPerDay} today`;
      }
      return null;
    }
    case 'max_resources': {
      const count = input.context?.resourceCount ?? 0;
      if (count >= condition.limit) {
        return `Resource limit reached: ${count}/${condition.limit}`;
      }
      return null;
    }
    case 'max_amount': {
      const raw = input.context?.amount;
      if (raw === undefined) return 'An amount is required for this action';
      if (!/^\d+$/.test(raw)) return 'Amount must be a non-negative integer string';
      // BigInt, because base-unit amounts overflow Number on large transfers.
      if (BigInt(raw) > BigInt(condition.limit)) {
        return `Amount exceeds the limit of ${condition.limit}`;
      }
      return null;
    }
    case 'scope_restricted': {
      if (!input.resourceScope) return 'A resource scope is required for this action';
      if (!condition.allowedScopes.includes(input.resourceScope)) {
        return `Action is not permitted in scope "${input.resourceScope}"`;
      }
      return null;
    }
    default: {
      // Exhaustiveness guard: adding a condition type without handling it here
      // should be a compile error, not a silent allow.
      const exhaustive: never = condition;
      return `Unsupported condition: ${JSON.stringify(exhaustive)}`;
    }
  }
}

/**
 * Lowest role that would be granted `action` at `scope`, or `undefined` if no
 * role can perform it. Used to tell a caller what would actually be required.
 */
export function minimumRoleFor(
  action: Action,
  scope: Scope = 'global',
): Role | undefined {
  for (const role of ROLES) {
    const entry = getPermissionEntry(action, role);
    if (entry.effect !== 'allow') continue;
    if (entry.scope === 'any') return role;
    if (SCOPE_RANK[entry.scope] >= SCOPE_RANK[scope]) return role;
  }
  return undefined;
}

/**
 * Authorizes one action for one actor.
 *
 * Evaluation order is deny-first and terminates on the first failure, so the
 * returned `reason` names the actual blocker rather than a downstream symptom.
 * Conditions can only subtract permission, never add it.
 */
export function checkPermission(
  action: Action,
  input: PermissionCheckInput,
): PermissionDecision {
  const entry = getPermissionEntry(action, input.role);
  const base = {
    action,
    role: input.role,
    conditions: entry.conditions,
    outstandingConditions: [] as PermissionCondition[],
  };

  if (entry.effect === 'deny') {
    return {
      ...base,
      allowed: false,
      code: 'denied_by_policy',
      reason: `Role "${input.role}" is not permitted to ${action}`,
      minimumRole: minimumRoleFor(action, input.resourceScope ?? 'global'),
    };
  }

  // A grant covers every scope it is at least as wide as. A `global` grant
  // therefore applies inside a project, while an `own` grant does not reach
  // across resources. Comparing the other way round would invert the whole
  // hierarchy and make `global` the narrowest grant there is.
  if (entry.scope !== 'any') {
    if (!input.resourceScope) {
      return {
        ...base,
        allowed: false,
        code: 'insufficient_scope',
        reason: `${action} requires a resource scope; none was supplied`,
        minimumRole: minimumRoleFor(action),
      };
    }
    if (SCOPE_RANK[entry.scope] < SCOPE_RANK[input.resourceScope]) {
      return {
        ...base,
        allowed: false,
        code: 'insufficient_scope',
        reason: `${action} requires "${entry.scope}" scope or wider, but the request is scoped to "${input.resourceScope}"`,
        minimumRole: minimumRoleFor(action, input.resourceScope),
      };
    }
  }

  const outstanding: PermissionCondition[] = [];
  for (const condition of entry.conditions) {
    const failure = conditionFailure(condition, input);
    if (failure) {
      outstanding.push(condition);
      return {
        ...base,
        allowed: false,
        code: 'condition_failed',
        reason: failure,
        outstandingConditions: outstanding,
      };
    }
  }

  return { ...base, allowed: true, reason: `Role "${input.role}" may ${action}` };
}

/** Convenience predicate for call sites that do not need the reason. */
export function can(
  action: Action,
  input: PermissionCheckInput,
): boolean {
  return checkPermission(action, input).allowed;
}

/**
 * Whether a role holds a grant for `action` that is wide enough for `scope`.
 *
 * Deliberately ignores conditions, so it answers "is this available to me at
 * all" rather than "may I perform it right now, given these facts". Use
 * `checkPermission` for the second question — that is the one a route handler
 * must call before acting.
 *
 * The split exists because a condition like `requires_confirmation` describes
 * how an action is *performed*, not whether the actor is entitled to it. Folding
 * that into an entitlement check makes an admin look as though they cannot export
 * anything until they have already confirmed the export, which is circular and
 * makes capability tables and UI affordance gates wrong.
 */
export function isGranted(
  action: Action,
  input: { role: Role; resourceScope?: Scope },
): boolean {
  const entry = getPermissionEntry(action, input.role);
  if (entry.effect === 'deny') return false;
  if (entry.scope === 'any') return true;
  if (!input.resourceScope) return false;
  return SCOPE_RANK[entry.scope] >= SCOPE_RANK[input.resourceScope];
}

/**
 * True when `actor` outranks `target`.
 *
 * Refuses self-escalation and any promotion to a role at or above the actor's
 * own, so a maintainer cannot mint an admin. `admin` is also refused because
 * there is no higher role to escalate to.
 */
export function canEscalateRole(actor: Role, target: Role): boolean {
  if (actor === 'admin') return false;
  return ROLE_RANK[target] < ROLE_RANK[actor];
}

export function roleLevel(role: Role): number {
  return ROLE_RANK[role];
}

// ---------------------------------------------------------------------------
// Introspection, for the permissions API and docs.
// ---------------------------------------------------------------------------

/** Grants a role holds, at any scope. */
export function getPermissionsForRole(role: Role): PermissionEntry[] {
  return PERMISSION_MATRIX.filter((entry) => entry.role === role && entry.effect === 'allow');
}

/** Actions a role holds a grant for within a scope, ignoring conditions. */
export function getAllowedActions(role: Role, scope: Scope = 'global'): Action[] {
  return ACTIONS.filter((action) => isGranted(action, { role, resourceScope: scope }));
}

export function describeAction(action: Action): string {
  return MATRIX[action].description;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/**
 * Value-returning counterparts to the type guards above.
 *
 * `isRole(x) ? x : …` narrows correctly, but the negative branch cannot shrink a
 * plain `string` any further, so a handler that validates with `!isRole(param)`
 * is still holding a `string` afterwards and fails to compile. These return the
 * narrowed value or `undefined`, which narrows in both branches.
 */
export function parseRole(value: string | null | undefined): Role | undefined {
  return isRole(value) ? value : undefined;
}

export function parseAction(value: string | null | undefined): Action | undefined {
  return isAction(value) ? value : undefined;
}

export function parseScope(value: string | null | undefined): Scope | undefined {
  return isScope(value) ? value : undefined;
}

/**
 * Bridges the role vocabularies used elsewhere in the repo, so callers can keep
 * their existing types without a second authorization check.
 *
 * - `user` (`lib/policy-engine.ts`) is the old name for `contributor`.
 * - `operator` (`lib/telemetry/roles.ts`) is a maintainer-scoped telemetry role.
 */
export function normalizeRole(value: string): Role | undefined {
  const aliases: Record<string, Role> = {
    user: 'contributor',
    operator: 'maintainer',
  };
  const candidate = aliases[value] ?? value;
  return isRole(candidate) ? candidate : undefined;
}
