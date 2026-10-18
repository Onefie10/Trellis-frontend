/**
 * @jest-environment node
 *
 * Node rather than the default jsdom: `next/server` needs the web `Request`,
 * `Response`, and `Headers` globals that jsdom does not provide, and
 * `lib/auth/actor.ts` uses `crypto.subtle` for HMAC signing.
 */
import { NextRequest } from 'next/server';
import {
  ACTOR_TOKEN_SECRET_ENV,
  issueActorToken,
  resolveActor,
  verifyActorToken,
} from '@/lib/auth/actor';
import { parseActionParam, requirePermission } from '@/lib/auth/guard';
import { ACTIONS, ROLES } from '@/lib/permissions';
import { GET as permissionsGET } from '@/app/api/permissions/route';
import { GET as telemetryGET } from '@/app/api/telemetry/session/route';
import { POST as securityPOST } from '@/app/api/security/route';
import { POST as retentionPOST } from '@/app/api/retention/run/route';

/**
 * Server-side rejection tests.
 *
 * The point of these is the negative case: a caller who asserts a role must not
 * get it. A test suite that only signs a token and checks a `200` would pass
 * against an implementation that reads the role from a header, so every failure
 * mode below is asserted explicitly.
 */

const SECRET = 'a'.repeat(48);
const NOW = 1_800_000_000_000;

function requestWithToken(token: string): NextRequest {
  return new NextRequest('https://example.test/api/permissions', {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function readStatus(response: Response): Promise<{ status: number; body: any }> {
  return { status: response.status, body: await response.json() };
}

describe('actor identity', () => {
  const originalSecret = process.env[ACTOR_TOKEN_SECRET_ENV];

  beforeEach(() => {
    process.env[ACTOR_TOKEN_SECRET_ENV] = SECRET;
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[ACTOR_TOKEN_SECRET_ENV];
    else process.env[ACTOR_TOKEN_SECRET_ENV] = originalSecret;
    jest.useRealTimers();
  });

  describe('token round trip', () => {
    it('accepts a token it issued', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'maintainer' });
      const result = await resolveActor(requestWithToken(token));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.actor.id).toBe('alice');
        expect(result.actor.role).toBe('maintainer');
      }
    });

    it('rejects a token whose role was edited after signing', async () => {
      // The attack this blocks: decode a viewer token, swap in "admin", resend.
      const token = await issueActorToken({ id: 'mallory', role: 'viewer' });
      const [encoded, signature] = token.split('.') as [string, string];
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      payload.role = 'admin';
      const forgedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const result = await verifyActorToken(`${forgedPayload}.${signature}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('invalid_signature');
    });

    it('rejects a token signed with a different secret', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      process.env[ACTOR_TOKEN_SECRET_ENV] = 'b'.repeat(48);

      const result = await verifyActorToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('invalid_signature');
    });

    it('rejects an expired token', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' }, { ttlMs: 1000 });
      jest.setSystemTime(NOW + 2000);

      const result = await verifyActorToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('expired_token');
    });

    it('expires a token issued with a zero ttl', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' }, { ttlMs: 0 });
      const result = await verifyActorToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('expired_token');
    });

    it('rejects a token with no signature at all', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const result = await verifyActorToken(token.split('.')[0]);
      expect(result.ok).toBe(false);
    });

    it('rejects a malformed token', async () => {
      for (const bad of ['not-a-token', 'a.b.c', '...', 'only.']) {
        const result = await verifyActorToken(bad);
        expect(result.ok).toBe(false);
      }
    });
  });

  describe('credential handling', () => {
    it('rejects a request with no Authorization header', async () => {
      const result = await resolveActor(new NextRequest('https://example.test/api/permissions'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('missing_credentials');
    });

    it('rejects a non-Bearer scheme', async () => {
      const request = new NextRequest('https://example.test/api/permissions', {
        headers: { authorization: 'Basic YWxpY2U6cGFzcw==' },
      });
      const result = await resolveActor(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('missing_credentials');
    });

    it('ignores a client-supplied role header entirely', async () => {
      // The bypass this module exists to close: no header can raise a role.
      const request = new NextRequest('https://example.test/api/permissions', {
        headers: { 'x-role': 'admin', 'x-user-role': 'admin', 'x-actor-role': 'admin' },
      });
      const result = await resolveActor(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('missing_credentials');
    });

    it('does not let a viewer upgrade itself via headers', async () => {
      const token = await issueActorToken({ id: 'mallory', role: 'viewer' });
      const request = new NextRequest('https://example.test/api/permissions', {
        headers: { authorization: `Bearer ${token}`, 'x-role': 'admin' },
      });
      const auth = await requirePermission(request, {
        action: 'view_permissions',
        resourceScope: 'global',
      });
      expect(auth.ok).toBe(false);
    });

    it('reports an unset secret as a server fault, not an auth failure', async () => {
      // Mint a valid token first; the fault must be in verifying, not issuing.
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      delete process.env[ACTOR_TOKEN_SECRET_ENV];
      const result = await verifyActorToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('server_misconfigured');
    });

    it('refuses to sign a token when the secret is missing', async () => {
      delete process.env[ACTOR_TOKEN_SECRET_ENV];
      await expect(issueActorToken({ id: 'alice', role: 'admin' })).rejects.toThrow(
        /PERMISSION_TOKEN_SECRET/,
      );
    });

    it('refuses a secret that is too short to be meaningful', async () => {
      process.env[ACTOR_TOKEN_SECRET_ENV] = 'short';
      await expect(issueActorToken({ id: 'alice', role: 'admin' })).rejects.toThrow(/32/);
    });
  });
});

describe('route-level enforcement', () => {
  const originalSecret = process.env[ACTOR_TOKEN_SECRET_ENV];

  beforeEach(() => {
    process.env[ACTOR_TOKEN_SECRET_ENV] = SECRET;
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[ACTOR_TOKEN_SECRET_ENV];
    else process.env[ACTOR_TOKEN_SECRET_ENV] = originalSecret;
    jest.useRealTimers();
  });

  const scoped = (token: string, path: string) =>
    new NextRequest(`https://example.test${path}`, { headers: { authorization: `Bearer ${token}` } });

  describe('GET /api/permissions', () => {
    it('serves the full matrix to a maintainer at project scope', async () => {
      const token = await issueActorToken({ id: 'mona', role: 'maintainer' });
      const { status, body } = await readStatus(
        await permissionsGET(scoped(token, '/api/permissions')),
      );
      expect(status).toBe(200);
      // The matrix is complete, not filtered to the caller.
      expect(body.matrix).toHaveLength(ACTIONS.length * ROLES.length);
      const maintainer = body.roles.find((entry: { role: string }) => entry.role === 'maintainer');
      expect(maintainer.actions).toContain('import_data');
      // Admin-only at this scope, so it must not be advertised to a maintainer.
      expect(maintainer.actions).not.toContain('run_retention_cleanup');
    });

    it('narrows to a single role when asked', async () => {
      const token = await issueActorToken({ id: 'mona', role: 'maintainer' });
      const { status, body } = await readStatus(
        await permissionsGET(scoped(token, '/api/permissions?role=maintainer')),
      );
      expect(status).toBe(200);
      expect(body.role).toBe('maintainer');
      expect(body.level).toBe(3);
      expect(body.actions).toContain('view_telemetry');
      // Only that role's rows.
      expect(body.entries.every((entry: { role: string }) => entry.role === 'maintainer')).toBe(true);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const { status, body } = await readStatus(
        await permissionsGET(new NextRequest('https://example.test/api/permissions')),
      );
      expect(status).toBe(401);
      expect(body.error.code).toBe('missing_credentials');
    });

    it('rejects a viewer with 403, not 401', async () => {
      // Authenticated but not permitted, so the status must distinguish the two.
      const token = await issueActorToken({ id: 'vic', role: 'viewer' });
      const { status, body } = await readStatus(
        await permissionsGET(scoped(token, '/api/permissions')),
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('denied_by_policy');
      expect(body.error.minimumRole).toBe('maintainer');
    });

    it('returns 500 when the server secret is unset', async () => {
      // Mint a valid token first; the fault is in verifying, not issuing.
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      delete process.env[ACTOR_TOKEN_SECRET_ENV];
      const { status, body } = await readStatus(
        await permissionsGET(scoped(token, '/api/permissions')),
      );
      expect(status).toBe(500);
      expect(body.error.code).toBe('server_misconfigured');
    });

    it('rejects an unknown role query parameter with 400', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const { status, body } = await readStatus(
        await permissionsGET(scoped(token, '/api/permissions?role=wizard')),
      );
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_role');
    });

    it('rejects an unknown action query parameter with 400', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const { status, body } = await readStatus(
        await permissionsGET(scoped(token, '/api/permissions?action=nuke_database')),
      );
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_action');
    });
  });

  describe('GET /api/telemetry/session', () => {
    it('refuses a client-asserted admin role and serves the caller its own caps', async () => {
      // The regression this route is here to prevent. Before the matrix it read
      // `?role=` and returned that role's capability table, so a viewer asking
      // for `admin` got `canExport: true`.
      const token = await issueActorToken({ id: 'vic', role: 'viewer' });
      const { status, body } = await readStatus(
        await telemetryGET(scoped(token, '/api/telemetry/session?role=admin')),
      );
      expect(status).toBe(200);
      expect(body.role.telemetry).toBe('viewer');
      expect(body.role.matrix).toBe('viewer');
      expect(body.capabilities.canExport).toBe(false);
      expect(body.capabilities.canFilterByAgent).toBe(false);
    });

    it('serves operator capabilities to a maintainer, with the grant that produced them', async () => {
      const token = await issueActorToken({ id: 'mona', role: 'maintainer' });
      const { status, body } = await readStatus(
        await telemetryGET(scoped(token, '/api/telemetry/session')),
      );
      expect(status).toBe(200);
      expect(body.role.telemetry).toBe('operator');
      expect(body.capabilities.canViewErrorDetails).toBe(true);
      // Export stays admin-only even for a maintainer.
      expect(body.capabilities.canExport).toBe(false);
      // The response names the grant it consulted, so this is auditable.
      expect(body.grants.viewTelemetryDetails.action).toBe('view_telemetry_details');
      expect(body.grants.viewTelemetryDetails.role).toBe('maintainer');
    });

    it('ignores a body role on POST exactly as it ignores a query role on GET', async () => {
      const token = await issueActorToken({ id: 'vic', role: 'viewer' });
      const { status, body } = await readStatus(
        await telemetryGET(
          new NextRequest('https://example.test/api/telemetry/session', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'admin' }),
          }),
        ),
      );
      expect(status).toBe(200);
      expect(body.role.telemetry).toBe('viewer');
      expect(body.capabilities.canExport).toBe(false);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const { status, body } = await readStatus(
        await telemetryGET(new NextRequest('https://example.test/api/telemetry/session')),
      );
      expect(status).toBe(401);
      expect(body.error.code).toBe('missing_credentials');
    });
  });

  describe('POST /api/retention/run', () => {
    const post = (token: string | null, body: unknown) =>
      new NextRequest('https://example.test/api/retention/run', {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    it('rejects an unauthenticated caller with 401 before reading the body', async () => {
      // Identity is resolved first, so an anonymous caller never reaches
      // validation — confirmed by sending a body that would fail validation.
      const { status, body } = await readStatus(await retentionPOST(post(null, { dryRun: 'nope' })));
      expect(status).toBe(401);
      expect(body.error.code).toBe('missing_credentials');
    });

    it('rejects a maintainer with 403', async () => {
      // Admin-only by design: deletion is irreversible and spans every class.
      const token = await issueActorToken({ id: 'mona', role: 'maintainer' });
      const { status, body } = await readStatus(await retentionPOST(post(token, { dryRun: false })));
      expect(status).toBe(403);
      expect(body.error.code).toBe('denied_by_policy');
      expect(body.error.minimumRole).toBe('admin');
    });

    it('rejects an admin whose request is still a dry run', async () => {
      // `requires_confirmation` is satisfied only by `dryRun: false`.
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const { status, body } = await readStatus(await retentionPOST(post(token, { dryRun: true })));
      expect(status).toBe(403);
      expect(body.error.code).toBe('condition_failed');
      expect(body.error.message).toMatch(/confirmation/i);
    });

    it('allows an admin who explicitly asked for a live cleanup', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const { status, body } = await readStatus(
        await retentionPOST(post(token, { dryRun: false, dataClasses: ['telemetry'] })),
      );
      expect(status).toBe(200);
      expect(body.dryRun).toBe(false);
      expect(body.results).toHaveLength(1);
    });
  });

  describe('POST /api/security', () => {
    const post = (token: string | null, body: unknown) =>
      new NextRequest('https://example.test/api/security', {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    const auditRecord = {
      id: 'audit_1',
      contractId: 'CABC',
      auditor: 'alice',
      timestamp: '2026-01-01T00:00:00.000Z',
      score: { total: 90, critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
      vulnerabilities: [],
      compliance: [],
      network: 'testnet',
      version: '1.0.0',
    };

    it('rejects an unauthenticated audit write with 401', async () => {
      const { status, body } = await readStatus(
        await securityPOST(post(null, { action: 'record-audit', auditRecord })),
      );
      expect(status).toBe(401);
      expect(body.error.code).toBe('missing_credentials');
    });

    it('rejects a maintainer writing to the audit trail with 403', async () => {
      // `record-audit` maps to `manage_security`, which is admin-only: an actor
      // able to write the trail could launder a finding out of it.
      const token = await issueActorToken({ id: 'mona', role: 'maintainer' });
      const { status, body } = await readStatus(
        await securityPOST(post(token, { action: 'record-audit', auditRecord, confirm: true })),
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('denied_by_policy');
    });

    it('rejects an admin audit write that was not confirmed', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const { status, body } = await readStatus(
        await securityPOST(post(token, { action: 'record-audit', auditRecord })),
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('condition_failed');
    });

    it('allows a confirmed admin audit write', async () => {
      const token = await issueActorToken({ id: 'alice', role: 'admin' });
      const { status, body } = await readStatus(
        await securityPOST(post(token, { action: 'record-audit', auditRecord, confirm: true })),
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.ledgerEntry).toMatchObject({ sequence: expect.any(Number) });
      expect(body.ledgerEntry.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects a contributor reading the audit trail with 403', async () => {
      // Checked at `project` scope, which a maintainer passes and a contributor
      // does not.
      const token = await issueActorToken({ id: 'cass', role: 'contributor' });
      const { status } = await readStatus(
        await securityPOST(post(token, { action: 'audit-history', contractId: 'CABC' })),
      );
      expect(status).toBe(403);
    });

    it('allows a maintainer reading the audit trail at project scope', async () => {
      const token = await issueActorToken({ id: 'mona', role: 'maintainer' });
      const { status, body } = await readStatus(
        await securityPOST(post(token, { action: 'audit-history', contractId: 'CABC' })),
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.ledger).toMatchObject({
        schemaVersion: 1,
        verification: { valid: true },
      });
      expect(body.ledger.entries[0]).toMatchObject({
        category: 'privileged',
        eventType: 'security.audit.recorded',
        actorId: 'alice',
      });
    });
  });
});

describe('query parameter parsing', () => {
  it('returns undefined for an unknown action rather than defaulting', () => {
    expect(parseActionParam('view_telemetry')).toBe('view_telemetry');
    expect(parseActionParam('drop_tables')).toBeUndefined();
    expect(parseActionParam(null)).toBeUndefined();
  });
});
