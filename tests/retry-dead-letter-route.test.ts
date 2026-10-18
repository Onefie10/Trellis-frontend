/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/retry/dead-letters/route';
import { RetryScheduler, deadLetterQueue } from '@/lib/retry';

/**
 * Tests for the maintainer-facing dead-letter endpoint.
 *
 * The authorization gate matters more here than the filtering: dead-letter
 * records carry caller `context` (wallet addresses, operation ids) and error
 * bodies, so an unguarded list is a data leak rather than a missing feature.
 */

const TOKEN = 'test-admin-token';
const BASE = 'https://example.test/api/retry/dead-letters';

function request(query = '', init: RequestInit = {}): NextRequest {
  return new NextRequest(`${BASE}${query}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

/**
 * Drives one operation to a terminal failure so the shared queue has something to
 * list. Uses the same singleton the route reads, which is the only way the test
 * exercises the real wiring rather than a stand-in.
 */
async function seedDeadLetter(operationClass: 'transaction' | 'webhook' = 'transaction'): Promise<string> {
  await expect(
    new RetryScheduler(deadLetterQueue).execute(() => Promise.reject(new Error('ECONNRESET')), {
      operationClass,
      operationId: `op_${operationClass}`,
      policy: { retryable: true, maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => {},
    }),
  ).rejects.toThrow();

  const [record] = deadLetterQueue.list();
  return record.id;
}

describe('dead-letter route authorization', () => {
  const originalToken = process.env.DEAD_LETTER_ADMIN_TOKEN;

  beforeEach(() => {
    deadLetterQueue.clear();
    process.env.DEAD_LETTER_ADMIN_TOKEN = TOKEN;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.DEAD_LETTER_ADMIN_TOKEN;
    else process.env.DEAD_LETTER_ADMIN_TOKEN = originalToken;
  });

  it('should fail closed when no token is configured', async () => {
    // An unset token must not degrade into "serve everything": that would publish
    // every dead-letter record in the process.
    delete process.env.DEAD_LETTER_ADMIN_TOKEN;
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'not_configured' });
  });

  it('should reject a request with no bearer token', async () => {
    const response = await GET(new NextRequest(BASE));
    expect(response.status).toBe(401);
  });

  it('should reject a wrong bearer token', async () => {
    const response = await GET(
      new NextRequest(BASE, { headers: { authorization: 'Bearer wrong-token-value' } }),
    );
    expect(response.status).toBe(401);
  });

  it('should reject a token of the wrong length without leaking a length oracle', async () => {
    const response = await GET(
      new NextRequest(BASE, { headers: { authorization: `Bearer ${TOKEN}x` } }),
    );
    expect(response.status).toBe(401);
  });
});

describe('dead-letter route listing', () => {
  beforeEach(() => {
    deadLetterQueue.clear();
    process.env.DEAD_LETTER_ADMIN_TOKEN = TOKEN;
  });

  it('should return records and aggregate stats for an authorized caller', async () => {
    const id = await seedDeadLetter();
    const response = await GET(request());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].id).toBe(id);
    expect(body.stats.total).toBe(1);
    expect(body.stats.unresolved).toBe(1);
  });

  it('should hide resolved records unless includeResolved is set', async () => {
    const id = await seedDeadLetter();
    await POST(request('', { method: 'POST', body: JSON.stringify({ id, outcome: 'discarded' }) }));

    const hidden = await (await GET(request())).json();
    expect(hidden.records).toHaveLength(0);

    const shown = await (await GET(request('?includeResolved=true'))).json();
    expect(shown.records).toHaveLength(1);
  });

  it('should reject an unknown reason rather than silently ignoring it', async () => {
    const response = await GET(request('?reason=because_i_said_so'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_reason' });
  });

  it('should reject an unknown operation class rather than silently ignoring it', async () => {
    const response = await GET(request('?operationClass=side_effect'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_operation_class' });
  });

  it('should accept a real operation class as a filter', async () => {
    await seedDeadLetter('webhook');
    const response = await GET(request('?operationClass=webhook'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ records: [{ operationClass: 'webhook' }] });
  });

  it('should reject a limit outside the allowed range', async () => {
    expect((await GET(request('?limit=0'))).status).toBe(400);
    expect((await GET(request('?limit=201'))).status).toBe(400);
    expect((await GET(request('?limit=abc'))).status).toBe(400);
  });
});

describe('dead-letter route resolution', () => {
  beforeEach(() => {
    deadLetterQueue.clear();
    process.env.DEAD_LETTER_ADMIN_TOKEN = TOKEN;
  });

  it('should mark a record as replayed', async () => {
    const id = await seedDeadLetter();
    const response = await POST(
      request('', { method: 'POST', body: JSON.stringify({ id, outcome: 'replayed', notes: 'fixed upstream' }) }),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.record.resolution).toBe('replayed');
    expect(body.record.resolvedAt).toEqual(expect.any(String));
  });

  it('should refuse to resolve the same record twice', async () => {
    const id = await seedDeadLetter();
    const payload = { method: 'POST', body: JSON.stringify({ id, outcome: 'discarded' }) };
    expect((await POST(request('', payload))).status).toBe(200);

    const second = await POST(request('', payload));
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: 'already_resolved' });
  });

  it('should return 404 for an unknown id', async () => {
    const response = await POST(
      request('', { method: 'POST', body: JSON.stringify({ id: 'dlq_missing', outcome: 'replayed' }) }),
    );
    expect(response.status).toBe(404);
  });

  it('should reject an outcome outside the allowed set', async () => {
    const id = await seedDeadLetter();
    const response = await POST(
      request('', { method: 'POST', body: JSON.stringify({ id, outcome: 'delete_everything' }) }),
    );
    expect(response.status).toBe(400);
  });

  it('should reject a missing id', async () => {
    const response = await POST(request('', { method: 'POST', body: JSON.stringify({ outcome: 'replayed' }) }));
    expect(response.status).toBe(400);
  });

  it('should reject a non-JSON body', async () => {
    const response = await POST(request('', { method: 'POST', body: 'not json' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_json' });
  });

  it('should bound operator notes', async () => {
    const id = await seedDeadLetter();
    const response = await POST(
      request('', { method: 'POST', body: JSON.stringify({ id, outcome: 'discarded', notes: 'x'.repeat(5000) }) }),
    );
    const body = await response.json();
    expect(body.record.resolutionNotes).toHaveLength(2000);
  });
});
