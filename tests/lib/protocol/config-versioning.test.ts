import {
  compareConfigVersions,
  DEFAULT_PROTOCOL_CONFIG_REGISTRY,
  getConfigDeprecationWarning,
  isValidConfigVersion,
  OPERATION_CONFIG_DEPENDENCIES,
  ProtocolConfigIncompatibleError,
  ProtocolConfigRegistry,
  resolveConfigCompatibility,
  validateProtocolCompatibility,
  validateProtocolConfigVersion,
  withProtocolCompatibility,
} from '@/lib/protocol/config-versioning';

const registry = DEFAULT_PROTOCOL_CONFIG_REGISTRY;

describe('protocol config versioning (#178)', () => {
  describe('version format and comparison', () => {
    it('accepts x.y and x.y.z versions', () => {
      expect(isValidConfigVersion('1.0')).toBe(true);
      expect(isValidConfigVersion('1.0.0')).toBe(true);
      expect(isValidConfigVersion('10.20.30')).toBe(true);
    });

    it('rejects malformed and pre-release versions', () => {
      expect(isValidConfigVersion('1')).toBe(false);
      expect(isValidConfigVersion('v1.0.0')).toBe(false);
      expect(isValidConfigVersion('1.0.0-beta')).toBe(false);
      expect(isValidConfigVersion('')).toBe(false);
      expect(isValidConfigVersion('abc')).toBe(false);
    });

    it('compares versions numerically', () => {
      expect(compareConfigVersions('1.0.0', '2.0.0')).toBe(-1);
      expect(compareConfigVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareConfigVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareConfigVersions('1.2.0', '1.10.0')).toBe(-1); // numeric, not lexical
      expect(compareConfigVersions('1.0', '1.0.0')).toBe(0);
    });

    it('throws comparing malformed versions', () => {
      expect(() => compareConfigVersions('garbage', '1.0.0')).toThrow(/invalid/i);
    });
  });

  describe('registry', () => {
    it('exposes the default configuration surfaces', () => {
      expect(registry.ids()).toEqual(
        expect.arrayContaining(['commission_tiers', 'claim_link_rules', 'governance_thresholds']),
      );
    });

    it('rejects descriptors with invalid version metadata', () => {
      expect(
        () =>
          new ProtocolConfigRegistry([
            {
              id: 'bad',
              description: 'bad current version',
              currentVersion: 'not-a-version',
              minSupportedVersion: '1.0.0',
            },
          ]),
      ).toThrow(/invalid currentVersion/i);
    });

    it('rejects descriptors whose floor is newer than current', () => {
      expect(
        () =>
          new ProtocolConfigRegistry([
            {
              id: 'bad',
              description: 'inverted range',
              currentVersion: '1.0.0',
              minSupportedVersion: '2.0.0',
            },
          ]),
      ).toThrow(/minSupportedVersion/);
    });
  });

  describe('resolveConfigCompatibility — the four acceptance classes', () => {
    it('current version is supported', () => {
      expect(resolveConfigCompatibility(registry.get('governance_thresholds')!, '1.0.0')).toBe(
        'supported',
      );
    });

    it('old-but-compatible version is supported', () => {
      expect(resolveConfigCompatibility(registry.get('claim_link_rules')!, '1.0.0')).toBe(
        'supported',
      );
    });

    it('old-incompatible version is incompatible', () => {
      expect(resolveConfigCompatibility(registry.get('commission_tiers')!, '1.0.0')).toBe(
        'incompatible',
      );
    });

    it('future-unknown version is incompatible', () => {
      expect(resolveConfigCompatibility(registry.get('claim_link_rules')!, '9.0.0')).toBe(
        'incompatible',
      );
    });

    it('explicit migration_required entries are honoured', () => {
      const custom = new ProtocolConfigRegistry([
        {
          id: 'c',
          description: 'custom',
          currentVersion: '2.0.0',
          minSupportedVersion: '1.0.0',
          compatibility: { '1.5.0': 'migration_required' },
        },
      ]);
      expect(resolveConfigCompatibility(custom.get('c')!, '1.5.0')).toBe('migration_required');
    });
  });

  describe('validateProtocolConfigVersion — fail-early errors', () => {
    it('passes current versions without warnings', () => {
      const result = validateProtocolConfigVersion(registry, 'claim_link_rules', '1.2.0');
      expect(result.compatibility).toBe('supported');
    });

    it('rejects too-old versions with VERSION_TOO_OLD', () => {
      try {
        validateProtocolConfigVersion(registry, 'commission_tiers', '1.0.0');
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolConfigIncompatibleError);
        const err = error as ProtocolConfigIncompatibleError;
        expect(err.code).toBe('VERSION_TOO_OLD');
        expect(err.configId).toBe('commission_tiers');
        expect(err.message).toMatch(/too old/i);
        expect(err.message).toMatch(/1\.1\.0/); // names the required floor
      }
    });

    it('rejects future-unknown versions with VERSION_UNKNOWN', () => {
      try {
        validateProtocolConfigVersion(registry, 'claim_link_rules', '9.9.9');
        throw new Error('should have thrown');
      } catch (error) {
        const err = error as ProtocolConfigIncompatibleError;
        expect(err.code).toBe('VERSION_UNKNOWN');
        expect(err.message).toMatch(/newer than this app supports/i);
      }
    });

    it('rejects migration-required versions with MIGRATION_REQUIRED', () => {
      const custom = new ProtocolConfigRegistry([
        {
          id: 'c',
          description: 'custom',
          currentVersion: '2.0.0',
          minSupportedVersion: '1.0.0',
          compatibility: { '1.5.0': 'migration_required' },
        },
      ]);
      try {
        validateProtocolConfigVersion(custom, 'c', '1.5.0');
        throw new Error('should have thrown');
      } catch (error) {
        const err = error as ProtocolConfigIncompatibleError;
        expect(err.code).toBe('MIGRATION_REQUIRED');
      }
    });

    it('treats malformed versions as too-old, not a crash', () => {
      expect(() => validateProtocolConfigVersion(registry, 'claim_link_rules', 'bogus')).toThrow(
        ProtocolConfigIncompatibleError,
      );
    });

    it('fails fast on unknown config ids', () => {
      expect(() => validateProtocolConfigVersion(registry, 'nonexistent', '1.0.0')).toThrow(
        /unknown protocol configuration/i,
      );
    });
  });

  describe('deprecation warnings', () => {
    it('warns for compatible-but-deprecated versions', () => {
      const descriptor = registry.get('commission_tiers')!;
      const warning = getConfigDeprecationWarning(descriptor, '1.1.0');
      expect(warning).not.toBeNull();
      expect(warning!.code).toBe('CONFIG_DEPRECATED');
      expect(warning!.message).toMatch(/deprecated since v1\.1\.0/);
      expect(warning!.message).toMatch(/after v3\.0\.0/);
    });

    it('does not warn for current versions', () => {
      const descriptor = registry.get('commission_tiers')!;
      expect(getConfigDeprecationWarning(descriptor, '2.0.0')).toBeNull();
    });

    it('does not warn for incompatible versions (they fail instead)', () => {
      const descriptor = registry.get('commission_tiers')!;
      expect(getConfigDeprecationWarning(descriptor, '1.0.0')).toBeNull();
    });
  });

  describe('validateProtocolCompatibility — batch gate', () => {
    it('accepts all-current versions with zero warnings', () => {
      const result = validateProtocolCompatibility(registry, [
        { configId: 'commission_tiers', version: '2.0.0' },
        { configId: 'claim_link_rules', version: '1.2.0' },
        { configId: 'governance_thresholds', version: '1.0.0' },
      ]);
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it('accepts old-compatible versions but surfaces deprecation warnings', () => {
      const result = validateProtocolCompatibility(registry, [
        { configId: 'commission_tiers', version: '1.1.0' },
      ]);
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].configId).toBe('commission_tiers');
    });

    it('throws on the first incompatible version', () => {
      expect(() =>
        validateProtocolCompatibility(registry, [
          { configId: 'claim_link_rules', version: '1.2.0' },
          { configId: 'commission_tiers', version: '1.0.0' },
        ]),
      ).toThrow(ProtocolConfigIncompatibleError);
    });
  });

  describe('withProtocolCompatibility — operation gate', () => {
    it('runs the operation when compatible', async () => {
      const ran = await withProtocolCompatibility(
        registry,
        [{ configId: 'claim_link_rules', version: '1.2.0' }],
        async () => 'ran',
      );
      expect(ran).toBe('ran');
    });

    it('refuses the operation when incompatible', async () => {
      await expect(
        withProtocolCompatibility(
          registry,
          [{ configId: 'commission_tiers', version: '1.0.0' }],
          async () => 'should not run',
        ),
      ).rejects.toThrow(ProtocolConfigIncompatibleError);
    });
  });

  describe('operation dependencies', () => {
    it('declares dependencies for every protocol operation', () => {
      for (const configIds of Object.values(OPERATION_CONFIG_DEPENDENCIES)) {
        for (const configId of configIds) {
          expect(registry.get(configId)).toBeDefined();
        }
      }
    });
  });
});
