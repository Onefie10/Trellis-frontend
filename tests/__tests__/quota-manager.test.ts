import { QuotaManager, QuotaExceededError } from '@/lib/quota-manager';

describe('Quota Manager (Issue #70)', () => {
  let quotaManager: QuotaManager;

  beforeEach(() => {
    quotaManager = new QuotaManager();
    quotaManager.defineResource('api_calls', { defaultLimit: 5, resetWindowMs: 1000 });
    quotaManager.defineResource('storage_bytes', { defaultLimit: 100 });
  });

  afterEach(() => {
    quotaManager.clearAll();
  });

  it('allows usage within limits', () => {
    const actor = 'user_1';
    
    // Consume 3 out of 5 API calls
    expect(() => quotaManager.consume(actor, 'api_calls', 3)).not.toThrow();
    const stats = quotaManager.inspect(actor, 'api_calls');
    expect(stats.used).toBe(3);
    expect(stats.limit).toBe(5);

    // Consume remaining 2
    expect(() => quotaManager.consume(actor, 'api_calls', 2)).not.toThrow();
    expect(quotaManager.inspect(actor, 'api_calls').used).toBe(5);
  });

  it('blocks usage that exceeds limits', () => {
    const actor = 'user_2';
    
    expect(() => quotaManager.consume(actor, 'api_calls', 6)).toThrow(QuotaExceededError);
    
    // Usage should remain 0 since the transaction was blocked entirely
    expect(quotaManager.inspect(actor, 'api_calls').used).toBe(0);

    // Consume 4, then try to consume 2
    quotaManager.consume(actor, 'api_calls', 4);
    expect(() => quotaManager.consume(actor, 'api_calls', 2)).toThrow(QuotaExceededError);
    
    // Usage remains 4
    expect(quotaManager.inspect(actor, 'api_calls').used).toBe(4);
  });

  it('allows maintainers to inspect quota usage', () => {
    const actorA = 'actorA';
    quotaManager.consume(actorA, 'storage_bytes', 50);

    const stats = quotaManager.inspect(actorA, 'storage_bytes');
    expect(stats.used).toBe(50);
    expect(stats.limit).toBe(100);
    expect(stats.resetAt).toBeUndefined(); // Storage has no reset window
  });

  it('supports overrides for specific actors', () => {
    const powerUser = 'power_user';
    
    // Override default 5 to 20
    quotaManager.setOverride(powerUser, 'api_calls', 20);
    
    // Inspect shows new limit
    const stats = quotaManager.inspect(powerUser, 'api_calls');
    expect(stats.limit).toBe(20);

    // Can consume beyond default limit
    expect(() => quotaManager.consume(powerUser, 'api_calls', 15)).not.toThrow();
    
    // But still enforces the new limit
    expect(() => quotaManager.consume(powerUser, 'api_calls', 10)).toThrow(QuotaExceededError);
    
    // Clear override reverts to default limit
    quotaManager.clearOverride(powerUser, 'api_calls');
    expect(quotaManager.inspect(powerUser, 'api_calls').limit).toBe(5);
  });

  it('resets usage after reset window expires', async () => {
    const actor = 'user_3';
    
    quotaManager.consume(actor, 'api_calls', 5);
    expect(() => quotaManager.consume(actor, 'api_calls', 1)).toThrow(QuotaExceededError);

    const statsBefore = quotaManager.inspect(actor, 'api_calls');
    expect(statsBefore.used).toBe(5);
    
    // Mock Date.now to simulate time travel (1001 ms into the future)
    const originalDateNow = Date.now;
    Date.now = jest.fn(() => originalDateNow() + 1001);

    // Should be able to consume again because window expired
    expect(() => quotaManager.consume(actor, 'api_calls', 1)).not.toThrow();
    
    const statsAfter = quotaManager.inspect(actor, 'api_calls');
    expect(statsAfter.used).toBe(1);

    // Restore Date.now
    Date.now = originalDateNow;
  });

  it('allows manual reset of usage', () => {
    const actor = 'user_4';
    
    quotaManager.consume(actor, 'storage_bytes', 100);
    expect(() => quotaManager.consume(actor, 'storage_bytes', 1)).toThrow(QuotaExceededError);

    quotaManager.reset(actor, 'storage_bytes');
    
    // Can consume again
    expect(() => quotaManager.consume(actor, 'storage_bytes', 50)).not.toThrow();
    expect(quotaManager.inspect(actor, 'storage_bytes').used).toBe(50);
  });
});
