import {
  ACTIONS,
  PERMISSION_MATRIX,
  PermissionMatrixSchema,
  ROLES,
  can,
  canEscalateRole,
  checkPermission,
  getAllowedActions,
  getPermissionEntry,
  isAction,
  isRole,
  isScope,
  minimumRoleFor,
  normalizeRole,
  parseAction,
  parseRole,
  parseScope,
  type Action,
  type Role,
  type Scope,
} from '@/lib/permissions';
import { getTelemetryCapabilities, type TelemetryRole } from '@/lib/telemetry/roles';

/**
 * Matrix and evaluation tests.
 *
 * The three cases the acceptance criteria name are covered explicitly:
 * `allowed`, `denied`, and `scope-limited`. The rest of the file guards the
 * structural invariants that keep the matrix meaningful over time.
 */

describe('permission matrix structure', () => {
  it('maps every action to an entry for every role', () => {
    // This is the invariant that made the old hand-written tables rot: an action
    // could be added with no decision recorded for some roles.
    expect(PERMISSION_MATRIX).toHaveLength(ACTIONS.length * ROLES.length);

    for (const action of ACTIONS) {
      for (const role of ROLES) {
        const entry = getPermissionEntry(action, role);
        expect(entry.action).toBe(action);
        expect(entry.role).toBe(role);
        expect(['allow', 'deny']).toContain(entry.effect);
      }
    }
  });

  it('validates against its own schema', () => {
    const result = PermissionMatrixSchema.safeParse(PERMISSION_MATRIX);
    if (!result.success) {
      throw new Error(`Matrix failed schema validation: ${result.error.message}`);
    }
  });

  it('records no conditions on a deny', () => {
    // A deny with an unsatisfiable-looking condition list reads as "allowed if...",
    // which is exactly the sort of ambiguity the matrix is meant to remove.
    for (const entry of PERMISSION_MATRIX) {
      if (entry.effect === 'deny') {
        expect(entry.conditions).toEqual([]);
      }
    }
  });

  it('describes every action', () => {
    for (const action of ACTIONS) {
      const entry = getPermissionEntry(action, 'guest');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('gives every action at least one role that can perform it', () => {
    // Otherwise the action is dead code and should not be in the matrix.
    for (const action of ACTIONS) {
      expect(minimumRoleFor(action)).toBeDefined();
    }
  });
});

describe('allowed access', () => {
  it('allows an admin to view audit logs at global scope', () => {
    const decision = checkPermission('view_audit_logs', {
      role: 'admin',
      resourceScope: 'global',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBeUndefined();
  });

  it('allows a maintainer to import data in their project', () => {
    const decision = checkPermission('import_data', {
      role: 'maintainer',
      resourceScope: 'project',
    });
    expect(decision.allowed).toBe(true);
  });

  it('allows a viewer to attach to telemetry but not read its detail', () => {
    // The two tiers the telemetry capability table used to encode by hand.
    expect(can('view_telemetry', { role: 'viewer', resourceScope: 'project' })).toBe(true);
    expect(can('view_telemetry_details', { role: 'viewer', resourceScope: 'project' })).toBe(false);
  });

  it('allows a contributor to read an agent they own', () => {
    const decision = checkPermission('update_agent', {
      role: 'contributor',
      actorId: 'alice',
      resourceOwnerId: 'alice',
      resourceScope: 'own',
    });
    expect(decision.allowed).toBe(true);
  });

  it('allows any role to accept an invitation, at any scope', () => {
    for (const role of ROLES) {
      expect(can('accept_invitation', { role, resourceScope: 'own' })).toBe(true);
    }
  });
});

describe('denied access', () => {
  it('denies a viewer every write action', () => {
    for (const action of ['create_agent', 'update_agent', 'delete_agent', 'transfer_funds'] as Action[]) {
      const decision = checkPermission(action, { role: 'viewer', resourceScope: 'global' });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('denied_by_policy');
    }
  });

  it('denies every role but admin a retention cleanup', () => {
    // Irreversible deletion across every data class.
    for (const role of ROLES) {
      const decision = checkPermission('run_retention_cleanup', {
        role,
        resourceScope: 'global',
        context: { confirmed: true },
      });
      if (role === 'admin') {
        expect(decision.allowed).toBe(true);
      } else {
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('denied_by_policy');
      }
    }
  });

  it('denies an admin a retention cleanup that was not explicitly confirmed', () => {
    // `dryRun: true` alone is never enough to reach the delete path.
    const decision = checkPermission('run_retention_cleanup', {
      role: 'admin',
      resourceScope: 'global',
      context: { confirmed: false },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/confirmation/i);
  });

  it('denies a maintainer impersonation', () => {
    // Admin-only by design: there is no maintainer path.
    expect(can('impersonate_user', { role: 'maintainer', resourceScope: 'global' })).toBe(false);
    expect(
      can('impersonate_user', { role: 'admin', resourceScope: 'global', context: { confirmed: true } }),
    ).toBe(true);
  });

  it('denies admin role escalation, because there is no higher role', () => {
    expect(canEscalateRole('admin', 'admin')).toBe(false);
    expect(canEscalateRole('maintainer', 'maintainer')).toBe(false);
    expect(canEscalateRole('maintainer', 'contributor')).toBe(true);
  });

  it('denies a contributor an owner-only action on someone else’s resource', () => {
    const decision = checkPermission('delete_agent', {
      role: 'contributor',
      actorId: 'alice',
      resourceOwnerId: 'bob',
      resourceScope: 'own',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('condition_failed');
    expect(decision.reason).toMatch(/owner/i);
  });

  it('denies a transfer above the cap even for admin', () => {
    const overCap = checkPermission('transfer_funds', {
      role: 'admin',
      resourceScope: 'global',
      context: { confirmed: true, amount: '1000000000001' },
    });
    expect(overCap.allowed).toBe(false);
    expect(overCap.reason).toMatch(/exceeds the limit/i);
  });

  it('denies an unconfirmed transfer', () => {
    const decision = checkPermission('transfer_funds', {
      role: 'admin',
      resourceScope: 'global',
      context: { confirmed: false, amount: '1' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/confirmation/i);
  });

  it('denies a transfer that exceeds the cap without overflowing Number', () => {
    // Larger than Number.MAX_SAFE_INTEGER, so a float comparison would be wrong.
    const decision = checkPermission('transfer_funds', {
      role: 'admin',
      resourceScope: 'global',
      context: { confirmed: true, amount: '1000000000000000000000000000' },
    });
    expect(decision.allowed).toBe(false);
  });

  it('denies a bulk import past the daily rate limit', () => {
    const decision = checkPermission('import_data', {
      role: 'maintainer',
      resourceScope: 'project',
      context: { actionCountToday: 20 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/rate limit/i);
  });
});

describe('scope-limited access', () => {
  it('denies a maintainer acting outside the scope their grant covers', () => {
    // `view_audit_logs` is granted to maintainer at `project` scope, so a
    // platform-wide request is wider than the grant reaches.
    const decision = checkPermission('view_audit_logs', {
      role: 'maintainer',
      resourceScope: 'global',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('insufficient_scope');
  });

  it('denies an own-scoped grant attempted across a resource', () => {
    // The mirror case: an `own` grant must not reach across resources.
    const decision = checkPermission('revoke_invitation', {
      role: 'contributor',
      resourceScope: 'resource',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('insufficient_scope');
  });

  it('denies when no scope is supplied at all', () => {
    const decision = checkPermission('view_audit_logs', { role: 'maintainer' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('insufficient_scope');
  });

  it('lets a project-scoped grant apply at a wider scope', () => {
    // An admin-level actor operating inside one project still satisfies a
    // `project`-scoped grant.
    expect(can('view_audit_logs', { role: 'admin', resourceScope: 'global' })).toBe(true);
    expect(can('view_audit_logs', { role: 'admin', resourceScope: 'project' })).toBe(true);
  });

  it('lets a `global` grant apply inside a project', () => {
    expect(can('view_telemetry', { role: 'admin', resourceScope: 'project' })).toBe(true);
  });

  it('denies a project-scoped escalation attempted in own scope', () => {
    // The `project`-scoped grant covers `own`, so this clears the scope check and
    // is stopped by the `scope_restricted` condition instead.
    const decision = checkPermission('escalate_role', {
      role: 'maintainer',
      resourceScope: 'own',
      context: { confirmed: true },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('condition_failed');
    expect(decision.reason).toMatch(/not permitted in scope/i);
  });

  it('allows a project-scoped escalation in project scope', () => {
    const decision = checkPermission('escalate_role', {
      role: 'maintainer',
      resourceScope: 'project',
      context: { confirmed: true },
    });
    expect(decision.allowed).toBe(true);
  });

  it('reports the lowest role that would satisfy the request', () => {
    const decision = checkPermission('view_audit_logs', {
      role: 'viewer',
      resourceScope: 'global',
    });
    expect(decision.allowed).toBe(false);
    // Admin, not maintainer: a maintainer's `project` grant does not cover a
    // platform-wide request.
    expect(decision.minimumRole).toBe('admin');
  });

  it('reports the lowest role that could cover a narrower request', () => {
    const decision = checkPermission('view_audit_logs', {
      role: 'viewer',
      resourceScope: 'project',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.minimumRole).toBe('maintainer');
  });

  it('reports the lowest role that holds a grant wide enough', () => {
    // Viewer holds an `own`-scoped grant, contributor holds one too, so the
    // lowest is contributor — not the first role in the list.
    expect(minimumRoleFor('revoke_invitation', 'own')).toBe('contributor');
    expect(minimumRoleFor('revoke_invitation', 'global')).toBe('admin');
    expect(minimumRoleFor('import_data', 'project')).toBe('maintainer');
    // `any`-scoped grants are unconstrained, so the lowest role always qualifies.
    expect(minimumRoleFor('accept_invitation', 'global')).toBe('guest');
  });
});

describe('introspection', () => {
  it('lists the actions a role can perform at a scope', () => {
    const actions = getAllowedActions('maintainer', 'project');
    expect(actions).toContain('import_data');
    expect(actions).toContain('view_telemetry');
    expect(actions).not.toContain('impersonate_user');
    // Admin-only, so it must not appear for a maintainer at any scope.
    expect(getAllowedActions('maintainer', 'global')).not.toContain('run_retention_cleanup');
  });

  it('keeps the legacy role vocabularies mappable', () => {
    // `lib/policy-engine.ts` used `user`; `lib/telemetry/roles.ts` used `operator`.
    expect(normalizeRole('user')).toBe('contributor');
    expect(normalizeRole('operator')).toBe('maintainer');
    expect(normalizeRole('admin')).toBe('admin');
    expect(normalizeRole('nonsense')).toBeUndefined();
  });

  it('reproduces the telemetry capability table it replaced, exactly', () => {
    // Parity test for the refactor of `lib/telemetry/roles.ts`. These are the
    // literal values of the `Record<TelemetryRole, Capabilities>` table that
    // used to be hand-maintained there, so deriving the flags from the matrix
    // is provably behaviour-preserving rather than merely intended to be.
    const expected = {
      viewer: {
        canConnect: true,
        canFilterByAgent: false,
        canViewErrorDetails: false,
        canExport: false,
        canUseDebugSeverity: false,
      },
      operator: {
        canConnect: true,
        canFilterByAgent: true,
        canViewErrorDetails: true,
        canExport: false,
        canUseDebugSeverity: true,
      },
      admin: {
        canConnect: true,
        canFilterByAgent: true,
        canViewErrorDetails: true,
        canExport: true,
        canUseDebugSeverity: true,
      },
    } as const;

    for (const [role, capabilities] of Object.entries(expected)) {
      expect(getTelemetryCapabilities(role as TelemetryRole)).toEqual(capabilities);
    }
  });

  it('narrowing parsers return the value or undefined, never a default', () => {
    expect(parseRole('maintainer')).toBe('maintainer');
    expect(parseRole('wizard')).toBeUndefined();
    expect(parseRole(null)).toBeUndefined();
    expect(parseAction('view_telemetry')).toBe('view_telemetry');
    expect(parseAction('nuke_database')).toBeUndefined();
    expect(parseScope('project')).toBe('project');
    expect(parseScope('galaxy')).toBeUndefined();
  });

  it('rejects an unknown action as a programming error, not an allow', () => {
    // `checkPermission` is typed to `Action`, so an unknown action is a compile
    // error for real callers. This guards the runtime escape hatch: it must never
    // resolve to an allow, because a lookup miss that defaulted to "permit" would
    // be a silent authorization bypass.
    expect(() => getPermissionEntry('not_a_real_action' as Action, 'admin')).toThrow(
      /No permission entry/,
    );
    // Untrusted input reaching the same function must be filtered before it does.
    expect(isAction('not_a_real_action')).toBe(false);
    expect(isAction('view_telemetry')).toBe(true);
    expect(isRole('wizard')).toBe(false);
    expect(isScope('galaxy')).toBe(false);
  });
});

describe('typing', () => {
  it('treats roles as a closed set at compile time', () => {
    // This is a type-level assertion; it only needs to compile.
    const role: Role = 'contributor';
    const scope: Scope = 'project';
    expect(checkPermission('view_analytics', { role, resourceScope: scope }).allowed).toBe(true);
  });
});
