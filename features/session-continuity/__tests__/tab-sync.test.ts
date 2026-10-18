import { createSessionSyncMessage } from '../tab-sync';
import { DomainEventValidationError } from '../../../lib/domain-events';

describe('session tab synchronization', () => {
  it('creates a versioned, validated cross-tab envelope', () => {
    const message = createSessionSyncMessage('WALLET_DISCONNECTED', { reason: 'logout' }, 'tab-a');

    expect(message.name).toBe('WALLET_DISCONNECTED');
    expect(message.source).toBe('tab-a');
    expect(message.payload).toEqual({ reason: 'logout' });
  });

  it('stamps the schema version explicitly and an ISO timestamp', () => {
    const message = createSessionSyncMessage('WALLET_DISCONNECTED', {}, 'tab-a');

    expect(message.version).toBe('1.0.0');
    expect(message.id).toEqual(expect.any(String));
    expect(message.timestamp).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(message.timestamp))).toBe(false);
  });

  it('rejects a payload that does not match the registered schema', () => {
    // `reason` must be a string; a drifted producer must not be able to
    // broadcast it.
    expect(() =>
      createSessionSyncMessage(
        'WALLET_DISCONNECTED',
        { reason: 42 } as unknown as { reason?: string },
        'tab-a',
      ),
    ).toThrow(DomainEventValidationError);
  });

  it('requires the network name for a network change', () => {
    expect(() =>
      createSessionSyncMessage('NETWORK_CHANGED', {} as { network: 'mainnet' }, 'tab-a'),
    ).toThrow(DomainEventValidationError);
  });

  it('accepts the network vocabulary the app actually produces', () => {
    // This previously threw, because the catalog expected a `public` value the
    // app never emits. See docs/DOMAIN_EVENTS.md.
    const message = createSessionSyncMessage('NETWORK_CHANGED', { network: 'mainnet' }, 'tab-a');

    expect(message.payload).toEqual({ network: 'mainnet' });
    expect(message.version).toBe('2.0.0');
  });
});
