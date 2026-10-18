import { sanitizeLabels } from '@/lib/metrics/sanitize';

describe('metrics sanitize', () => {
  it('drops sensitive label keys', () => {
    expect(
      sanitizeLabels({
        job: 'api',
        email: 'x@y.com',
        user_id: '123',
        instance: '10.0.0.1:8080',
      })
    ).toEqual({ job: 'api' });
  });

  it('redacts sensitive values even on non-sensitive keys', () => {
    const out = sanitizeLabels({
      job: 'alice@example.com',
      env: '10.12.1.9',
      walletRef: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(out.job).toContain('[redacted]');
    expect(out.env).toBe('[redacted]');
    expect(out.walletRef).toBeUndefined();
  });

  it('drops unknown, malformed, and unbounded labels while keeping dashboard dimensions', () => {
    expect(
      sanitizeLabels({
        status: '503',
        method: 'POST',
        request_id: 'req-1',
        trace: 'a'.repeat(200),
        'bad label': 'value',
        route: '/users/123456/orders/550e8400-e29b-41d4-a716-446655440000',
      })
    ).toEqual({ status: '503', method: 'POST', route: '/users/:param/orders/:param' });
  });

  it('caps the number of dimensions in a series', () => {
    expect(sanitizeLabels({ job: 'api', env: 'prod', service: 'web', type: 'request', severity: 'info', code: 'ok', state: 'healthy', extra: 'x' })).toEqual({
      job: 'api', env: 'prod', service: 'web', type: 'request', severity: 'info', code: 'ok',
    });
  });
});

