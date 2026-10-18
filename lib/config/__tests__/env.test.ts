import {
  parseAppConfig,
  sanitizeEnvMessage,
  createSecretRotationManager,
  auditEnvSecrets,
} from '../env';

const validLocal = {
  NEXT_PUBLIC_ENVIRONMENT: 'development',
  NEXT_PUBLIC_API_URL: 'http://localhost:3001',
  NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
};

describe('application environment validation', () => {
  it('accepts a valid local configuration and applies safe feature defaults', () => {
    expect(parseAppConfig(validLocal)).toMatchObject({
      environment: 'development',
      stellarNetwork: 'testnet',
      enableBetaFeatures: false,
    });
  });

  it('reports missing and malformed settings by name without echoing values', () => {
    expect(() => parseAppConfig({ ...validLocal, NEXT_PUBLIC_API_URL: 'not-a-url' })).toThrow(/NEXT_PUBLIC_API_URL/);
    expect(() => parseAppConfig({ ...validLocal, NEXT_PUBLIC_ENABLE_BETA_FEATURES: 'yes' })).toThrow(/NEXT_PUBLIC_ENABLE_BETA_FEATURES/);
    expect(() => parseAppConfig({ NEXT_PUBLIC_API_URL: 'private-value' })).toThrow(/NEXT_PUBLIC_ENVIRONMENT/);
    try {
      parseAppConfig({ ...validLocal, NEXT_PUBLIC_API_URL: 'not-a-url?token-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('token-secret');
    }
  });

  it('rejects insecure deployment and production-like local secrets', () => {
    expect(() => parseAppConfig({
      NEXT_PUBLIC_ENVIRONMENT: 'production',
      NEXT_PUBLIC_API_URL: 'http://api.example.com',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
    })).toThrow(/HTTPS|mainnet/);
    expect(() => parseAppConfig({
      ...validLocal,
      WEBHOOK_SECRET: 'prod-signing-key-that-is-long-enough-to-pass-minimum',
    })).toThrow(/production-like/);
    expect(() => parseAppConfig({ ...validLocal, WEBHOOK_SECRET: 'placeholder-signing-key-with-enough-characters' })).toThrow(/non-placeholder/);
  });
});

describe('secret sanitization', () => {
  const secrets = {
    NEXT_PUBLIC_API_KEY: 'secret-api-key-value',
    WEBHOOK_SECRET: 'webhook-signing-secret-value',
  };

  it('masks secret values in tracebacks', () => {
    const message = 'Request failed with secret-api-key-value and webhook-signing-secret-value';
    const sanitized = sanitizeEnvMessage(message, secrets);
    expect(sanitized).not.toContain('secret-api-key-value');
    expect(sanitized).not.toContain('webhook-signing-secret-value');
    expect(sanitized).toContain('[SECRET_MASKED]');
  });

  it('masks secrets in serialized objects', () => {
    const payload = { url: 'https://api/data', key: 'secret-api-key-value' };
    const sanitized = sanitizeEnvMessage(JSON.stringify(payload), secrets);
    expect(sanitized).not.toContain('secret-api-key-value');
    expect(sanitized).toContain('[SECRET_MASKED]');
  });

  it('leaves non-secret content intact', () => {
    const message = 'Connection to https://api/data failed';
    expect(sanitizeEnvMessage(message, secrets)).toEqual(message);
  });
});

describe('runtime secret rotation', () => {
  it('reloads dynamic variables without restart', () => {
    const manager = createSecretRotationManager({
      NEXT_PUBLIC_ENVIRONMENT: 'development',
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
      NEXT_PUBLIC_API_KEY: 'initial-key-value',
    });

    expect(manager.getConfig().apiKey).toEqual('initial-key-value');

    manager.rotate({ NEXT_PUBLIC_API_KEY: 'rotated-key-value' });
    expect(manager.getConfig().apiKey).toEqual('rotated-key-value');
  });

  it('notifies subscribers on rotation', () => {
    const manager = createSecretRotationManager({
      ...validLocal,
      NEXT_PUBLIC_API_KEY: 'initial-key-value',
    });
    const listener = jest.fn();
    const unsubscribe = manager.subscribe(listener);

    manager.rotate({ NEXT_PUBLIC_API_KEY: 'rotated-key-value' });
    expect(listener).called();

    unsubscribe();
    manager.rotate({ NEXT_PUBLIC_API_KEY: 'another-key-value' });
    expect(listener).called(1);
  });

  it('rejects invalid rotated configuration', () => {
    const manager = createSecretRotationManager(validLocal);
    expect(() => manager.rotate({ NEXT_PUBLIC_API_URL: 'not-a-url' })).toThrow(/NEXT_PUBLIC_API_URL/);
  });
});

describe('environment secret audit', () => {
  it('flags weak or default development secrets', () => {
    const findings = auditEnvSecrets({
      ...validLocal,
      NEXT_PUBLIC_API_KEY: 'dev',
      WEBHOOK_SECRET: 'changeme',
    });
    const names = findings.map((f) => f.name);
    expect(names).toContain('NEXT_PUBLIC_API_KEY');
    expect(names).toContain('WEBHOOK_SECRET');
  });

  it('does not flag strong secrets', () => {
    const findings = auditEnvSecrets({
      ...validLocal,
      NEXT_PUBLIC_API_KEY: '8f3c9b1d4e7a2c5d6f08b4e2d1c3a5f6',
    });
    expect(findings.some((f) => f.name === 'NEXT_PUBLIC_API_KEY')).toBe(false);
  });
});
