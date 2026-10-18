import {
  compareVersions,
  isValidVersion,
  defineSchema,
  getCurrentSchemaVersion,
  getSupportedSchemaVersions,
  isSchemaVersionSupported,
  migrateRecord,
  normalizeRecord,
  validateRecord,
  prepareRecordForWrite,
  readRecord,
  normalizeAPIResponse,
  isClientVersionCompatible,
  getClientCompatibilityWarnings,
  defineMigrationStrategy,
  getMigrationStrategy,
  initializeDefaultSchemas,
  registerMigration,
  getMigrationStep,
  getMigrationPath,
  applyMigrationStep,
  defineDeprecatedField,
  getDeprecatedField,
  getDeprecatedFields,
  formatDeprecationWarning,
  warnDeprecatedField,
  getRecordField,
  withDeprecationWarnings,
  resetDeprecationWarnings,
  upgradeLoadedRecords,
  upgradeLocalStorageRecords,
  validateRecordWithGuardrails,
  guardRecordWrite,
  guardAPIResponse,
} from '@/lib/schema-versioning';
import type {
  Record,
  SchemaDefinition,
  DeprecatedFieldDescriptor,
  GuardrailOptions,
  UnknownFieldPolicy,
  DeprecatedFieldPolicy,
} from '@/lib/schema-versioning';

describe('Schema Versioning', () => {
  describe('compareVersions', () => {
    it('correctly compares versions', () => {
      expect(compareVersions('1.0', '2.0')).toBe(-1);
      expect(compareVersions('2.0', '1.0')).toBe(1);
      expect(compareVersions('1.0', '1.0')).toBe(0);
    });

    it('handles patch versions', () => {
      expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
      expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
    });

    it('pads missing version parts', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
      expect(compareVersions('2.0', '1.9.9')).toBe(1);
    });
  });

  describe('isValidVersion', () => {
    it('accepts valid version formats', () => {
      expect(isValidVersion('1.0')).toBe(true);
      expect(isValidVersion('2.1')).toBe(true);
      expect(isValidVersion('1.0.0')).toBe(true);
      expect(isValidVersion('10.20.30')).toBe(true);
    });

    it('rejects invalid version formats', () => {
      expect(isValidVersion('1')).toBe(false);
      expect(isValidVersion('1.0.0.0')).toBe(false);
      expect(isValidVersion('v1.0')).toBe(false);
      expect(isValidVersion('1.a')).toBe(false);
    });
  });

  describe('Schema Registration', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('registers schema versions', () => {
      const versions = getSupportedSchemaVersions();
      expect(versions).toContain('1.0');
      expect(versions).toContain('2.0');
    });

    it('rejects invalid version format', () => {
      expect(() => {
        defineSchema({
          version: 'invalid',
          description: 'test',
          fields: {},
        });
      }).toThrow();
    });

    it('tracks current version as highest registered', () => {
      expect(getCurrentSchemaVersion()).toBe('2.0');
    });

    it('checks version support', () => {
      expect(isSchemaVersionSupported('1.0')).toBe(true);
      expect(isSchemaVersionSupported('2.0')).toBe(true);
      expect(isSchemaVersionSupported('3.0')).toBe(false);
    });
  });

  describe('migrateRecord', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('returns same record if versions match', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = migrateRecord(record, '1.0');
      expect(result?.schemaVersion).toBe('1.0');
    });

    it('upgrades record to newer version', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = migrateRecord(record, '2.0');
      expect(result).toBeDefined();
      expect(result?.schemaVersion).toBe('2.0');
    });

    it('applies transforms during migration', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = migrateRecord(record, '2.0');
      expect(result?.migratedAt).toBeDefined();
      expect(result?.previousVersion).toBe('1.0');
    });

    it('handles missing schemaVersion in input', () => {
      const record: any = {
        id: 'test-1',
        // no schemaVersion
      };

      const result = migrateRecord(record, '2.0');
      expect(result).toBeDefined();
      expect(result?.schemaVersion).toBe('2.0');
    });

    it('returns null for unsupported target version', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = migrateRecord(record, '99.0');
      expect(result).toBeNull();
    });

    it('returns null for downgrade attempt', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '2.0',
      };

      const result = migrateRecord(record, '1.0');
      expect(result).toBeNull();
    });
  });

  describe('normalizeRecord', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('migrates to current version', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = normalizeRecord(record);
      expect(result.schemaVersion).toBe(getCurrentSchemaVersion());
    });

    it('preserves already normalized records', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '2.0',
      };

      const result = normalizeRecord(record);
      expect(result.schemaVersion).toBe('2.0');
    });
  });

  describe('validateRecord', () => {
    beforeEach(() => {
      initializeDefaultSchemas();

      // Define schema with required fields
      defineSchema({
        version: '3.0',
        description: 'Test schema with requirements',
        fields: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          email: { type: 'string', required: false },
          schemaVersion: { type: 'string', required: true },
        },
      });
    });

    it('validates record with all required fields', () => {
      const record: Record = {
        id: 'test-1',
        name: 'John Doe',
        schemaVersion: '3.0',
      };

      const result = validateRecord(record);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects missing required fields', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '3.0',
        // missing 'name'
      };

      const result = validateRecord(record);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: name');
    });

    it('allows missing optional fields', () => {
      const record: Record = {
        id: 'test-1',
        name: 'John Doe',
        schemaVersion: '3.0',
        // email not required
      };

      const result = validateRecord(record);
      expect(result.valid).toBe(true);
    });

    it('fails for unsupported schema version', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '99.0',
      };

      const result = validateRecord(record);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not found'))).toBe(true);
    });
  });

  describe('prepareRecordForWrite', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('adds schema version to record', () => {
      const data = { id: 'test-1', name: 'Test' };
      const result = prepareRecordForWrite(data);

      expect(result.schemaVersion).toBeDefined();
      expect(result.schemaVersion).toBe(getCurrentSchemaVersion());
    });

    it('uses specified version if provided', () => {
      const data = { id: 'test-1', name: 'Test' };
      const result = prepareRecordForWrite(data, '1.0');

      expect(result.schemaVersion).toBe('1.0');
    });

    it('applies write transforms', () => {
      defineSchema({
        version: '3.0',
        description: 'Schema with write transform',
        fields: { id: { type: 'string' } },
        transformTo: (data: any) => ({
          ...data,
          processed: true,
          processedAt: Date.now(),
        }),
      });

      const data = { id: 'test-1' };
      const result = prepareRecordForWrite(data, '3.0');

      expect(result.processed).toBe(true);
      expect(result.processedAt).toBeDefined();
    });

    it('throws for unsupported version', () => {
      expect(() => {
        prepareRecordForWrite({ id: 'test-1' }, '99.0');
      }).toThrow();
    });
  });

  describe('readRecord', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('reads and normalizes record', () => {
      const data = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = readRecord(data, true);
      expect(result).toBeDefined();
      expect(result?.schemaVersion).toBe('2.0');
    });

    it('returns null for invalid input', () => {
      expect(readRecord(null)).toBeNull();
      expect(readRecord(undefined)).toBeNull();
      expect(readRecord('string')).toBeNull();
    });

    it('respects autoMigrate flag', () => {
      const data = {
        id: 'test-1',
        schemaVersion: '1.0',
      };

      const result = readRecord(data, false);
      expect(result?.schemaVersion).toBe('1.0');
    });

    it('returns null for unsupported version without autoMigrate', () => {
      const data = {
        id: 'test-1',
        schemaVersion: '99.0',
      };

      const result = readRecord(data, false);
      expect(result).toBeNull();
    });
  });

  describe('normalizeAPIResponse', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('normalizes array of records with mixed versions', () => {
      const responses = [
        { id: 'test-1', schemaVersion: '1.0' },
        { id: 'test-2', schemaVersion: '2.0' },
        { id: 'test-3', schemaVersion: '1.0' },
      ];

      const result = normalizeAPIResponse(responses);
      expect(result).toHaveLength(3);
      expect(result.every(r => r.schemaVersion === '2.0')).toBe(true);
    });

    it('filters out invalid records', () => {
      const responses = [
        { id: 'test-1', schemaVersion: '1.0' },
        null,
        { id: 'test-2', schemaVersion: '1.0' },
      ];

      const result = normalizeAPIResponse(responses);
      expect(result).toHaveLength(2);
    });
  });

  describe('Client Compatibility', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('allows compatible client versions', () => {
      expect(isClientVersionCompatible('2.0')).toBe(true);
      expect(isClientVersionCompatible('1.0')).toBe(true);
    });

    it('rejects incompatible client versions', () => {
      expect(isClientVersionCompatible('99.0')).toBe(false);
      expect(isClientVersionCompatible('invalid')).toBe(false);
    });

    it('provides compatibility warnings for outdated clients', () => {
      const warnings = getClientCompatibilityWarnings('1.0');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.includes('outdated'))).toBe(true);
    });

    it('provides warnings for version mismatch', () => {
      const warnings = getClientCompatibilityWarnings('99.0');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.includes('not supported'))).toBe(true);
    });
  });

  describe('Migration Strategies', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('documents migration strategies', () => {
      defineMigrationStrategy({
        fromVersion: '2.0',
        toVersion: '3.0',
        description: 'Add new fields',
        newFeatures: ['customField'],
      });

      const strategy = getMigrationStrategy('2.0', '3.0');
      expect(strategy).toBeDefined();
      expect(strategy?.description).toBe('Add new fields');
    });

    it('returns null for unknown strategy', () => {
      const strategy = getMigrationStrategy('1.0', '99.0');
      expect(strategy).toBeNull();
    });
  });

  describe('Integration - Full Lifecycle', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('handles complete data flow: write, read, migrate', () => {
      // 1. Prepare data for write
      const inputData = { id: 'claim-1', amount: 100 };
      const prepared = prepareRecordForWrite(inputData);

      expect(prepared.schemaVersion).toBeDefined();

      // 2. Simulate storage and retrieval
      const stored = JSON.parse(JSON.stringify(prepared));

      // 3. Read and normalize
      const read = readRecord(stored, true);

      expect(read).toBeDefined();
      expect(read?.schemaVersion).toBe(getCurrentSchemaVersion());
      expect(read?.id).toBe('claim-1');
    });

    it('handles legacy record compatibility', () => {
      // Old record from system using version 1.0
      const legacyRecord: Record = {
        id: 'old-claim',
        schemaVersion: '1.0',
        amount: 100,
      };

      // New code expects current version
      const normalized = normalizeRecord(legacyRecord);

      expect(normalized.schemaVersion).toBe(getCurrentSchemaVersion());
      expect(normalized.id).toBe('old-claim');
      expect(normalized.amount).toBe(100);
      expect(normalized.migratedAt).toBeDefined();
    });

    it('validates migrated records', () => {
      const oldRecord: Record = {
        id: 'claim-1',
        schemaVersion: '1.0',
      };

      const migrated = migrateRecord(oldRecord, '2.0');
      expect(migrated).toBeDefined();

      const validation = validateRecord(migrated!);
      expect(validation.valid).toBe(true);
    });
  });

  describe('Backward Compatibility', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
    });

    it('preserves existing data during migration', () => {
      const record: Record = {
        id: 'test-1',
        schemaVersion: '1.0',
        customField: 'custom-value',
        amount: 100,
      };

      const migrated = migrateRecord(record, '2.0');

      expect(migrated?.customField).toBe('custom-value');
      expect(migrated?.amount).toBe(100);
    });

    it('handles records missing version gracefully', () => {
      const unversioned: any = {
        id: 'test-1',
        data: 'some-data',
      };

      const result = readRecord(unversioned);
      expect(result).toBeDefined();
      expect(result?.schemaVersion).toBe(getCurrentSchemaVersion());
    });
  });
});


describe('Schema Migration Pipeline (#103)', () => {
  describe('Migration step registry', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
      // Synthetic ordered pipeline: v30 -> v31 -> v32.
      registerMigration(
        '30.0',
        '31.0',
        (data: any) => ({ ...data, stage31: true }),
        'add stage31'
      );
      registerMigration(
        '31.0',
        '32.0',
        (data: any) => ({ ...data, stage32: true, total: (data.value || 0) + 1 }),
        'add stage32'
      );
      // A direct shortcut edge for v40 -> v42.
      registerMigration(
        '40.0',
        '42.0',
        (data: any) => ({ ...data, shortcut: true }),
        'direct shortcut'
      );
    });

    it('resolves a composed step-wise path between non-adjacent versions', () => {
      expect(getMigrationPath('30.0', '32.0')).toEqual(['30.0', '31.0', '32.0']);
    });

    it('prefers a registered direct step over a composed path', () => {
      expect(getMigrationPath('40.0', '42.0')).toEqual(['40.0', '42.0']);
    });

    it('registers and exposes individual migration steps', () => {
      const step = getMigrationStep('30.0', '31.0');
      expect(step).not.toBeNull();
      expect(step?.description).toBe('add stage31');

      const applied = applyMigrationStep('30.0', '31.0', { id: 'r' });
      expect(applied.stage31).toBe(true);
    });

    it('returns null when no migration path exists', () => {
      expect(getMigrationPath('30.0', '99.0')).toBeNull();
    });

    it('migrates v30 -> v32 in one direct call by composing steps', () => {
      const record: Record = { id: 'record-1', schemaVersion: '30.0', value: 41 };

      const result = migrateRecord(record, '32.0');

      expect(result).not.toBeNull();
      expect(result?.schemaVersion).toBe('32.0');
      expect(result?.stage31).toBe(true);
      expect(result?.stage32).toBe(true);
      expect(result?.total).toBe(42);
      expect(result?.previousVersion).toBe('31.0');
      expect(result?.value).toBe(41);
      // The source record must not be mutated.
      expect((record as any).stage31).toBeUndefined();
    });

    it('matches direct and step-wise v30 -> v32 upgrades', () => {
      const record: Record = { id: 'record-2', schemaVersion: '30.0', value: 41 };

      const direct = migrateRecord(record, '32.0');
      const at31 = migrateRecord(record, '31.0');
      const stepWise = migrateRecord(at31!, '32.0');

      expect(stepWise?.schemaVersion).toBe('32.0');
      expect(stepWise?.stage31).toBe(true);
      expect(stepWise?.stage32).toBe(true);
      expect(stepWise?.total).toBe(direct?.total);
      expect(stepWise?.previousVersion).toBe(direct?.previousVersion);
    });

    it('uses a registered direct shortcut step', () => {
      const direct = migrateRecord({ id: 'record-3', schemaVersion: '40.0' }, '42.0');
      expect(direct?.shortcut).toBe(true);
      expect(direct?.schemaVersion).toBe('42.0');
    });
  });

  describe('Deprecated field warnings', () => {
    beforeEach(() => {
      resetDeprecationWarnings();
      defineDeprecatedField({
        field: 'legacyName',
        since: '2.0',
        replacement: 'name',
        message: 'Legacy agent metadata field.',
        removedIn: '4.0',
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('exposes deprecated field descriptors', () => {
      const descriptor: DeprecatedFieldDescriptor | null =
        getDeprecatedField('legacyName');
      expect(descriptor?.replacement).toBe('name');
      expect(getDeprecatedField('name')).toBeNull();
      expect(getDeprecatedFields().some(d => d.field === 'legacyName')).toBe(true);
      expect(getDeprecatedFields('3.0').some(d => d.field === 'legacyName')).toBe(
        true
      );
      expect(getDeprecatedFields('1.0')).toHaveLength(0);
    });

    it('formats informative deprecation guidance', () => {
      const text = formatDeprecationWarning(getDeprecatedField('legacyName')!);
      expect(text).toContain('legacyName');
      expect(text).toContain('2.0');
      expect(text).toContain('"name"');
      expect(text).toContain('4.0');
    });

    it('warns once per deprecated field via getRecordField', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const record: Record = {
        id: 'agent-1',
        schemaVersion: '2.0',
        name: 'Agent',
        legacyName: 'Old Agent',
      };

      expect(getRecordField(record, 'legacyName')).toBe('Old Agent');
      expect(getRecordField(record, 'legacyName')).toBe('Old Agent');

      const legacyWarnings = warnSpy.mock.calls.filter(call =>
        String(call[0]).includes('legacyName')
      );
      expect(legacyWarnings).toHaveLength(1);
    });

    it('does not warn for current (non-deprecated) fields', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const record: Record = { id: 'agent-2', schemaVersion: '2.0', name: 'Agent' };

      expect(getRecordField(record, 'name')).toBe('Agent');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns the fallback when a field is absent', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const record: Record = { id: 'agent-4', schemaVersion: '2.0' };
      expect(getRecordField(record, 'legacyName', 'default')).toBe('default');
    });

    it('supports a proxy accessor that warns on legacy property reads', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const record: Record = { id: 'agent-3', schemaVersion: '2.0', legacyName: 'Old' };
      const proxied = withDeprecationWarnings(record);

      expect(proxied.legacyName).toBe('Old');
      // warn-once: the second read is silent.
      expect(proxied.legacyName).toBe('Old');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Loaded-record upgrader (IndexedDB / LocalStorage)', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
      registerMigration('50.0', '51.0', (data: any) => ({ ...data, upgraded: true }));
      registerMigration('51.0', '52.0', (data: any) => ({
        ...data,
        upgradedTwice: true,
      }));
    });

    it('upgrades an array of loaded records to the target version', () => {
      const loaded = [
        { id: 'a', schemaVersion: '1.0', value: 1 },
        { id: 'b', schemaVersion: '2.0', value: 2 },
      ];

      const result = upgradeLoadedRecords(loaded, '2.0');

      expect(result.total).toBe(2);
      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.records.map(r => r.schemaVersion)).toEqual(['2.0', '2.0']);
      expect(result.records[0].migratedAt).toBeDefined();
    });

    it('treats unversioned records as v1.0 and migrates them', () => {
      const result = upgradeLoadedRecords([{ id: 'legacy' }], '2.0');

      expect(result.migrated).toBe(1);
      expect(result.records[0].schemaVersion).toBe('2.0');
      expect(result.records[0].previousVersion).toBe('1.0');
    });

    it('runs composed steps for a multi-version jump', () => {
      const result = upgradeLoadedRecords([{ id: 'combo', schemaVersion: '50.0' }], '52.0');

      expect(result.migrated).toBe(1);
      expect(result.records[0].upgraded).toBe(true);
      expect(result.records[0].upgradedTwice).toBe(true);
      expect(result.records[0].schemaVersion).toBe('52.0');
    });

    it('reports failures and drops invalid entries without throwing', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = upgradeLoadedRecords(
        [{ id: 'future', schemaVersion: '99.0' }, null],
        '2.0'
      );

      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.records).toHaveLength(1);
      jest.restoreAllMocks();
    });

    it('upgrades and persists LocalStorage records', () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      };
      store.set(
        'trellis:saved-agents',
        JSON.stringify([
          { id: 'a', schemaVersion: '1.0' },
          { id: 'b', schemaVersion: '2.0' },
        ])
      );

      const results = upgradeLocalStorageRecords(storage, 'trellis:saved-agents', '2.0');

      expect(results['trellis:saved-agents'].migrated).toBe(1);
      const persisted = JSON.parse(store.get('trellis:saved-agents')!);
      expect(persisted).toHaveLength(2);
      expect(persisted.every((r: any) => r.schemaVersion === '2.0')).toBe(true);
    });

    it('ignores missing LocalStorage keys and invalid JSON', () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      };
      store.set('bad', '{not json');

      const results = upgradeLocalStorageRecords(storage, ['missing', 'bad'], '2.0');

      expect(Object.keys(results)).toHaveLength(0);
    });
  });

  describe('Multi-version upgrades (v1 -> v3)', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
      registerMigration(
        '2.0',
        '3.0',
        (data: any) => ({ ...data, agentTier: 'standard' }),
        'add agent tier'
      );
    });

    it('upgrades v1.0 -> v3.0 directly using catalog + registered steps', () => {
      const result = migrateRecord(
        { id: 'agent-v1', schemaVersion: '1.0', name: 'Old Agent' },
        '3.0'
      );

      expect(result?.schemaVersion).toBe('3.0');
      expect(result?.agentTier).toBe('standard');
      expect(result?.previousVersion).toBe('2.0');
      expect(result?.name).toBe('Old Agent');
    });

    it('produces the same result step-wise (v1.0 -> v2.0 -> v3.0)', () => {
      const direct = migrateRecord({ id: 'agent-v1b', schemaVersion: '1.0' }, '3.0');
      const atV2 = migrateRecord({ id: 'agent-v1b', schemaVersion: '1.0' }, '2.0');
      const stepWise = migrateRecord(atV2!, '3.0');

      expect(stepWise?.schemaVersion).toBe('3.0');
      expect(stepWise?.agentTier).toBe(direct?.agentTier);
      expect(stepWise?.previousVersion).toBe(direct?.previousVersion);
      expect(stepWise?.migratedAt).toBeDefined();
    });
  });

  describe('Schema Evolution Guardrails', () => {
    beforeEach(() => {
      initializeDefaultSchemas();
      resetDeprecationWarnings();
      defineSchema({
        version: '10.0',
        description: 'Test schema for guardrails',
        fields: {
          id: { type: 'string', required: true },
          schemaVersion: { type: 'string', required: true },
          name: { type: 'string', required: true },
          legacyTag: {
            type: 'string',
            deprecated: true,
            replacement: 'tags',
            removedIn: '11.0',
          },
          tags: { type: 'array' },
        },
      });
    });

    describe('Unknown Field Policies', () => {
      const recordWithUnknown: Record = {
        id: 'rec-1',
        schemaVersion: '10.0',
        name: 'Record 1',
        unknownProperty: 'unexpected',
        extraMetadata: { foo: 'bar' },
      };

      it('preserves unknown fields when unknownFieldPolicy is "preserve"', () => {
        const result = validateRecordWithGuardrails(recordWithUnknown, {
          unknownFieldPolicy: 'preserve',
        });

        expect(result.valid).toBe(true);
        expect(result.unknownFields).toEqual(['unknownProperty', 'extraMetadata']);
        expect(result.sanitized.unknownProperty).toBe('unexpected');
        expect(result.sanitized.extraMetadata).toEqual({ foo: 'bar' });
      });

      it('strips unknown fields when unknownFieldPolicy is "strip"', () => {
        const result = validateRecordWithGuardrails(recordWithUnknown, {
          unknownFieldPolicy: 'strip',
        });

        expect(result.valid).toBe(true);
        expect(result.unknownFields).toEqual(['unknownProperty', 'extraMetadata']);
        expect(result.sanitized.id).toBe('rec-1');
        expect(result.sanitized.name).toBe('Record 1');
        expect(result.sanitized.unknownProperty).toBeUndefined();
        expect(result.sanitized.extraMetadata).toBeUndefined();
      });

      it('rejects record when unknownFieldPolicy is "reject"', () => {
        const result = validateRecordWithGuardrails(recordWithUnknown, {
          unknownFieldPolicy: 'reject',
        });

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Unknown fields rejected: unknownProperty, extraMetadata');
      });

      it('quarantines unknown fields when unknownFieldPolicy is "quarantine"', () => {
        const result = validateRecordWithGuardrails(recordWithUnknown, {
          unknownFieldPolicy: 'quarantine',
          quarantineKey: '_quarantined',
        });

        expect(result.valid).toBe(true);
        expect(result.sanitized.unknownProperty).toBeUndefined();
        expect(result.sanitized._quarantined).toEqual({
          unknownProperty: 'unexpected',
          extraMetadata: { foo: 'bar' },
        });
      });
    });

    describe('Deprecated Field Policies', () => {
      const recordWithDeprecated: Record = {
        id: 'rec-dep',
        schemaVersion: '10.0',
        name: 'Record with deprecated field',
        legacyTag: 'old-tag',
      };

      it('allows deprecated fields without warnings when deprecatedFieldPolicy is "allow"', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = validateRecordWithGuardrails(recordWithDeprecated, {
          deprecatedFieldPolicy: 'allow',
          emitWarnings: false,
        });

        expect(result.valid).toBe(true);
        expect(result.deprecatedFields).toContain('legacyTag');
        expect(result.warnings).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.restoreAllMocks();
      });

      it('warns when deprecatedFieldPolicy is "warn"', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = validateRecordWithGuardrails(recordWithDeprecated, {
          deprecatedFieldPolicy: 'warn',
          emitWarnings: true,
        });

        expect(result.valid).toBe(true);
        expect(result.deprecatedFields).toContain('legacyTag');
        expect(result.warnings.some(w => w.includes('legacyTag'))).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.restoreAllMocks();
      });

      it('rejects when deprecatedFieldPolicy is "reject"', () => {
        const result = validateRecordWithGuardrails(recordWithDeprecated, {
          deprecatedFieldPolicy: 'reject',
        });

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('Field "legacyTag" is deprecated') && e.includes('rejected'))).toBe(true);
      });
    });

    describe('guardRecordWrite', () => {
      it('successfully prepares and writes clean record', () => {
        const clean = guardRecordWrite(
          { id: 'write-1', name: 'Valid Write' },
          '10.0',
          { unknownFieldPolicy: 'strip' }
        );

        expect(clean.id).toBe('write-1');
        expect(clean.schemaVersion).toBe('10.0');
        expect(clean.name).toBe('Valid Write');
      });

      it('throws an error when record violates guardrail policy', () => {
        expect(() => {
          guardRecordWrite(
            { id: 'write-fail', name: 'Has Unknown', badField: 123 },
            '10.0',
            { unknownFieldPolicy: 'reject' }
          );
        }).toThrow(/Record failed schema guardrails/);
      });
    });

    describe('guardAPIResponse', () => {
      it('strips unknown fields and passes valid API response records by default', () => {
        const rawApiResponse = [
          {
            id: 'api-1',
            schemaVersion: '10.0',
            name: 'API Record',
            internalServerField: 'do_not_leak',
          },
          {
            id: 'api-2',
            schemaVersion: '1.0',
            createdAt: 12345678,
          },
        ];

        const guarded = guardAPIResponse(rawApiResponse);

        expect(guarded.validCount).toBe(2);
        expect(guarded.rejectedCount).toBe(0);
        expect(guarded.data).toHaveLength(2);
        expect((guarded.data[0] as any).internalServerField).toBeUndefined();
        expect(guarded.data[0].id).toBe('api-1');
      });

      it('rejects malformed records or invalid schema versions gracefully without crashing', () => {
        const dirtyResponse = [
          null,
          'not an object',
          { schemaVersion: '999.0' }, // non-existent schema version
        ];

        const guarded = guardAPIResponse(dirtyResponse);

        expect(guarded.validCount).toBe(0);
        expect(guarded.rejectedCount).toBe(3);
        expect(guarded.errors).toHaveLength(3);
        expect(guarded.data).toHaveLength(0);
      });
    });
  });
});
