/** @jest-environment node */
import { NextRequest } from 'next/server';
import { POST as supportAccessPOST } from '@/app/api/support-access/route';
import {
  ACTOR_TOKEN_SECRET_ENV,
  issueActorToken,
} from '@/lib/auth/actor';

const SECRET = 'support-access-test-secret-at-least-32-chars';

function request(token: string, body: unknown) {
  return new NextRequest('https://example.test/api/support-access', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/support-access', () => {
  const originalSecret = process.env[ACTOR_TOKEN_SECRET_ENV];

  beforeEach(() => {
    process.env[ACTOR_TOKEN_SECRET_ENV] = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[ACTOR_TOKEN_SECRET_ENV];
    else process.env[ACTOR_TOKEN_SECRET_ENV] = originalSecret;
  });

  it('denies non-admins even when they request a confirmed session', async () => {
    const token = await issueActorToken({ id: 'support-viewer', role: 'viewer' });
    const response = await supportAccessPOST(
      request(token, {
        action: 'start',
        targetUserId: 'customer-1',
        reason: 'Investigate a reported issue',
        confirm: true,
      }),
    );

    expect(response.status).toBe(403);
  });

  it('requires confirmation and preserves a private, append-only audit trail', async () => {
    const adminToken = await issueActorToken({ id: 'support-admin-a', role: 'admin' });
    const otherAdminToken = await issueActorToken({ id: 'support-admin-b', role: 'admin' });
    const unconfirmed = await supportAccessPOST(
      request(adminToken, {
        action: 'start',
        targetUserId: 'customer-2',
        reason: 'Investigate a reported issue',
      }),
    );
    expect(unconfirmed.status).toBe(400);

    const started = await supportAccessPOST(
      request(adminToken, {
        action: 'start',
        targetUserId: 'customer-2',
        scope: 'read_only',
        durationMinutes: 10,
        reason: 'Investigate a reported issue',
        confirm: true,
      }),
    );
    expect(started.status).toBe(201);
    const { session } = await started.json();
    expect(session.expiresAt).toBeTruthy();

    const crossAdminAudit = await supportAccessPOST(
      request(otherAdminToken, {
        action: 'audit',
        sessionId: session.id,
        confirm: true,
      }),
    );
    expect(crossAdminAudit.status).toBe(404);

    const ended = await supportAccessPOST(
      request(adminToken, {
        action: 'end',
        sessionId: session.id,
        reason: 'Support review complete',
        confirm: true,
      }),
    );
    expect(ended.status).toBe(200);

    const audit = await supportAccessPOST(
      request(adminToken, { action: 'audit', sessionId: session.id, confirm: true }),
    );
    const { events } = await audit.json();
    expect(events.map((event: { action: string }) => event.action)).toEqual([
      'session_started',
      'session_ended',
    ]);
  });
});
