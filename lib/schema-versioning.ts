/**
 * Schema Versioning and Compatibility Layer
 *
 * Enables version-aware handling so older clients, migrated records,
 * and new schema fields can coexist safely during rollout.
 *
 * Supports:
 * - Schema version metadata
 * - Compatibility transforms for read and write paths
 * - Deprecation and migration strategies
 * - Backward and forward compatibility
 */

export type SchemaVersion = string;

export interface VersionMetadata {
  /** Schema version (e.g., "1.0", "2.0", "2.1") */
  schemaVersion: SchemaVersion;
  /** Timestamp when record was migrated to this schema */
  migratedAt?: number;
  /** Previous schema version if migrated */
  previousVersion?: SchemaVersion;
}

export interface Record<T = any> extends VersionMetadata {
  id: string;
  [key: string]: any;
}

/**
 * Semantic version comparison
 */
export function compareVersions(v1: SchemaVersion, v2: SchemaVersion): -1 | 0 | 1 {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }

  return 0;
}

/**
 * Check if version is valid (X.Y or X.Y.Z format)
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+(\.\d+)?$/.test(version);
}

/**
 * Transform function type: (data) => transformed data
 */
export type TransformFn = (data: any) => any;

/**
 * Field definition within a schema
 */
export interface FieldDefinition {
  type: string;
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  replacement?: string;
  removedIn?: SchemaVersion;
}

/**
 * Policy for handling unknown/unrecognized fields
 * - 'strip': removes unknown fields from the sanitized output (safe for forwarding)
 * - 'reject': marks validation as failed and records an error
 * - 'preserve': retains unknown fields as-is
 * - 'quarantine': separates unknown fields into an `_unknown` or quarantine bag
 */
export type UnknownFieldPolicy = 'strip' | 'reject' | 'preserve' | 'quarantine';

/**
 * Policy for handling deprecated fields
 * - 'allow': accepts deprecated fields without warnings or errors
 * - 'warn': emits deprecation warning / records warning, but keeps valid
 * - 'reject': marks validation as failed if deprecated fields are present
 */
export type DeprecatedFieldPolicy = 'allow' | 'warn' | 'reject';

/**
 * Options for schema evolution guardrails
 */
export interface GuardrailOptions {
  unknownFieldPolicy?: UnknownFieldPolicy;
  deprecatedFieldPolicy?: DeprecatedFieldPolicy;
  /** Custom quarantine key when policy is 'quarantine'. Defaults to '_quarantined' */
  quarantineKey?: string;
  /** Whether to log warnings via console.warn. Defaults to true */
  emitWarnings?: boolean;
}

/**
 * Schema definition with transforms
 */
export interface SchemaDefinition {
  version: SchemaVersion;
  description: string;
  fields: Record<string, FieldDefinition | { type: string; required?: boolean; description?: string }>;
  /** Transform to convert from previous version */
  transformFrom?: (previousVersion: SchemaVersion, data: any) => any;
  /** Transform before writing to this version */
  transformTo?: (data: any) => any;
}

/**
 * Version compatibility catalog
 */
class SchemaVersionCatalog {
  private schemas: Map<SchemaVersion, SchemaDefinition> = new Map();
  private currentVersion: SchemaVersion = '1.0';

  /**
   * Register a schema version
   */
  registerSchema(definition: SchemaDefinition): void {
    if (!isValidVersion(definition.version)) {
      throw new Error(`Invalid schema version: ${definition.version}`);
    }

    this.schemas.set(definition.version, definition);

    // Track current version (highest)
    if (compareVersions(definition.version, this.currentVersion) > 0) {
      this.currentVersion = definition.version;
    }
  }

  /**
   * Get schema definition for version
   */
  getSchema(version: SchemaVersion): SchemaDefinition | null {
    return this.schemas.get(version) || null;
  }

  /**
   * Get current/latest schema version
   */
  getCurrentVersion(): SchemaVersion {
    return this.currentVersion;
  }

  /**
   * List all registered versions
   */
  getVersions(): SchemaVersion[] {
    return Array.from(this.schemas.keys()).sort(
      (a, b) => compareVersions(a, b) as any
    );
  }

  /**
   * Check if version is supported
   */
  isVersionSupported(version: SchemaVersion): boolean {
    return this.schemas.has(version);
  }

  /**
   * Get deprecation status for a version
   */
  getDeprecationInfo(version: SchemaVersion): {
    deprecated: boolean;
    deprecatedSince?: SchemaVersion;
    sunsetDate?: number;
  } {
    const schema = this.getSchema(version);
    if (!schema) {
      return { deprecated: true };
    }

    const current = this.getCurrentVersion();
    const isOld = compareVersions(version, current) < 0;

    return {
      deprecated: isOld,
      deprecatedSince: isOld ? current : undefined,
    };
  }
}

// Global catalog instance
const catalog = new SchemaVersionCatalog();

/**
 * Migration step: a pure function that upgrades record data one version hop.
 */
export type MigrationStep = (data: any) => any;

/**
 * A single registered migration step between two schema versions.
 */
export interface MigrationStepDefinition {
  from: SchemaVersion;
  to: SchemaVersion;
  migrate: MigrationStep;
  description?: string;
}

/**
 * Modular registry of step-by-step migration transforms.
 *
 * Each entry moves record data from `from` to `to`. Single-version steps are
 * composed automatically (v1 -> v2 -> v3), and an explicit shortcut edge
 * (v1 -> v3) is used directly when one is registered.
 */
class MigrationStepRegistry {
  private steps: Map<string, MigrationStepDefinition> = new Map();

  private key(from: SchemaVersion, to: SchemaVersion): string {
    return `${from}=>${to}`;
  }

  register(step: MigrationStepDefinition): void {
    // Re-registering the same edge replaces it, keeping the registry idempotent.
    this.steps.set(this.key(step.from, step.to), step);
  }

  get(from: SchemaVersion, to: SchemaVersion): MigrationStepDefinition | null {
    return this.steps.get(this.key(from, to)) || null;
  }

  all(): MigrationStepDefinition[] {
    return Array.from(this.steps.values());
  }

  /** Candidate next versions reachable from `node`, explicit steps first. */
  neighbors(node: SchemaVersion, catalogVersions: SchemaVersion[]): SchemaVersion[] {
    const next: SchemaVersion[] = [];
    const seen = new Set<SchemaVersion>();

    for (const step of this.steps.values()) {
      if (step.from === node && !seen.has(step.to)) {
        next.push(step.to);
        seen.add(step.to);
      }
    }

    // Implicit edge: the next version in the sorted schema catalog.
    const index = catalogVersions.indexOf(node);
    if (index >= 0 && index + 1 < catalogVersions.length) {
      const successor = catalogVersions[index + 1];
      if (!seen.has(successor)) {
        next.push(successor);
      }
    }

    return next;
  }
}

// Global migration registry instance
const migrationRegistry = new MigrationStepRegistry();

/**
 * Register a modular migration step from one schema version to another.
 */
export function registerMigration(
  from: SchemaVersion,
  to: SchemaVersion,
  migrate: MigrationStep,
  description?: string
): void {
  if (!isValidVersion(from) || !isValidVersion(to)) {
    throw new Error(`Invalid migration version(s): ${from} -> ${to}`);
  }
  if (compareVersions(from, to) >= 0) {
    throw new Error(`Migration steps must move forward: ${from} -> ${to}`);
  }
  migrationRegistry.register({ from, to, migrate, description });
}

/**
 * Look up a single registered migration step.
 */
export function getMigrationStep(
  from: SchemaVersion,
  to: SchemaVersion
): MigrationStepDefinition | null {
  return migrationRegistry.get(from, to);
}

/**
 * List every registered migration step in registration order.
 */
export function getRegisteredMigrations(): MigrationStepDefinition[] {
  return migrationRegistry.all();
}

/**
 * Resolve the ordered chain of versions to walk from `from` to `to`.
 *
 * Prefers the shortest route (a direct step when one is registered), otherwise
 * composes consecutive registered steps and catalog-adjacent versions.
 */
export function getMigrationPath(
  from: SchemaVersion,
  to: SchemaVersion
): SchemaVersion[] | null {
  if (from === to) {
    return [from];
  }
  if (compareVersions(from, to) >= 0) {
    return null;
  }

  const catalogVersions = catalog.getVersions();
  const queue: SchemaVersion[][] = [[from]];
  const visited = new Set<SchemaVersion>([from]);

  while (queue.length > 0) {
    const path = queue.shift() as SchemaVersion[];
    const node = path[path.length - 1];

    for (const next of migrationRegistry.neighbors(node, catalogVersions)) {
      if (visited.has(next)) {
        continue;
      }
      const nextPath = [...path, next];
      if (next === to) {
        return nextPath;
      }
      visited.add(next);
      queue.push(nextPath);
    }
  }

  return null;
}

/**
 * Apply one migration hop: a registered step, else the target schema's
 * `transformFrom`, else a pass-through that only advances the version.
 */
export function applyMigrationStep(
  from: SchemaVersion,
  to: SchemaVersion,
  data: any
): any {
  const step = migrationRegistry.get(from, to);
  if (step) {
    return step.migrate(data);
  }

  const schema = catalog.getSchema(to);
  if (schema?.transformFrom) {
    return schema.transformFrom(from, data);
  }

  return data;
}

/* --------------------------------------------------------------------------
 * Deprecated field descriptors + developer warnings
 * ----------------------------------------------------------------------- */

/**
 * Describes a legacy schema field that callers should stop using.
 */
export interface DeprecatedFieldDescriptor {
  /** Field name that is deprecated. */
  field: string;
  /** Schema version in which the field became deprecated. */
  since: SchemaVersion;
  /** Preferred replacement field, if any. */
  replacement?: string;
  /** Extra developer guidance. */
  message?: string;
  /** Schema version scheduled to remove the field. */
  removedIn?: SchemaVersion;
}

const deprecatedFields: Map<string, DeprecatedFieldDescriptor> = new Map();
const warnedDeprecatedFields: Set<string> = new Set();

/**
 * Register a deprecated schema field descriptor.
 */
export function defineDeprecatedField(descriptor: DeprecatedFieldDescriptor): void {
  deprecatedFields.set(descriptor.field, descriptor);
}

/**
 * Get the descriptor for a deprecated field, or null.
 */
export function getDeprecatedField(field: string): DeprecatedFieldDescriptor | null {
  return deprecatedFields.get(field) || null;
}

/**
 * List deprecated fields, optionally filtered to those deprecated as of a
 * given schema version.
 */
export function getDeprecatedFields(
  version?: SchemaVersion
): DeprecatedFieldDescriptor[] {
  const all = Array.from(deprecatedFields.values());
  if (!version) {
    return all;
  }
  return all.filter(descriptor => compareVersions(descriptor.since, version) <= 0);
}

/**
 * Build the human-readable deprecation guidance shown to developers.
 */
export function formatDeprecationWarning(
  descriptor: DeprecatedFieldDescriptor
): string {
  const parts = [
    `[schema-versioning] Deprecated field "${descriptor.field}"`,
    `(since schema ${descriptor.since}).`,
  ];
  if (descriptor.replacement) {
    parts.push(`Use "${descriptor.replacement}" instead.`);
  }
  if (descriptor.message) {
    parts.push(descriptor.message);
  }
  if (descriptor.removedIn) {
    parts.push(`Scheduled for removal in schema ${descriptor.removedIn}.`);
  }
  return parts.join(' ');
}

/**
 * Warn about a deprecated field at most once per field per session.
 * Returns true when this call emitted the warning.
 */
export function warnDeprecatedField(field: string): boolean {
  const descriptor = deprecatedFields.get(field);
  if (!descriptor || warnedDeprecatedFields.has(field)) {
    return false;
  }
  warnedDeprecatedFields.add(field);
  console.warn(formatDeprecationWarning(descriptor));
  return true;
}

/**
 * Clear warn-once bookkeeping (useful in tests).
 */
export function resetDeprecationWarnings(): void {
  warnedDeprecatedFields.clear();
}

/**
 * Read a field, emitting deprecation guidance when the field is deprecated.
 */
export function getRecordField<T = any>(
  record: Record,
  field: string,
  fallback?: T
): any {
  warnDeprecatedField(field);
  if (!record || typeof record !== 'object') {
    return fallback;
  }
  return field in record ? (record as any)[field] : fallback;
}

/**
 * Wrap a record so reading a deprecated property warns once.
 */
export function withDeprecationWarnings<T extends Record>(record: T): T {
  return new Proxy(record, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        warnDeprecatedField(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/* --------------------------------------------------------------------------
 * Loaded-record upgrade helpers (IndexedDB / LocalStorage)
 * ----------------------------------------------------------------------- */

/**
 * Minimal synchronous storage surface (matches window.localStorage).
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Result of upgrading a batch of loaded records.
 */
export interface BatchMigrationResult {
  records: Record[];
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Upgrade an array of already-loaded records (e.g. read from IndexedDB) to the
 * target schema version. Records already at the target version are skipped,
 * unversioned records are treated as v1.0, and failures are reported instead
 * of throwing. Invalid (non-object) entries are dropped.
 */
export function upgradeLoadedRecords(
  records: any[],
  targetVersion: SchemaVersion = getCurrentSchemaVersion()
): BatchMigrationResult {
  const upgraded: Record[] = [];
  const errors: string[] = [];
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of records) {
    if (!raw || typeof raw !== 'object') {
      skipped++;
      continue;
    }

    const version: SchemaVersion = (raw as any).schemaVersion || '1.0';

    if (version === targetVersion) {
      upgraded.push(raw as Record);
      skipped++;
      continue;
    }

    const result = migrateRecord(raw as Record, targetVersion);
    if (result) {
      upgraded.push(result);
      migrated++;
    } else {
      failed++;
      const id = (raw as any).id ? ` ${(raw as any).id}` : '';
      errors.push(`Failed to migrate record${id} from ${version} to ${targetVersion}`);
      upgraded.push(raw as Record);
    }
  }

  return {
    records: upgraded,
    total: records.length,
    migrated,
    skipped,
    failed,
    errors,
  };
}

/**
 * Read JSON records from LocalStorage keys, upgrade them to the target
 * version, and write the migrated payloads back. Accepts a single key or a
 * list of keys; missing keys and malformed JSON are ignored.
 */
export function upgradeLocalStorageRecords(
  storage: StorageLike,
  keys: string | string[],
  targetVersion: SchemaVersion = getCurrentSchemaVersion()
): { [key: string]: BatchMigrationResult } {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const results: { [key: string]: BatchMigrationResult } = {};

  for (const key of keyList) {
    const rawValue = storage.getItem(key);
    if (rawValue === null) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      continue;
    }

    const isArray = Array.isArray(parsed);
    const result = upgradeLoadedRecords(isArray ? parsed : [parsed], targetVersion);
    storage.setItem(
      key,
      JSON.stringify(isArray ? result.records : result.records[0] ?? null)
    );
    results[key] = result;
  }

  return results;
}


/**
 * Create and register a schema version
 */
export function defineSchema(definition: SchemaDefinition): void {
  catalog.registerSchema(definition);
}

/**
 * Get current schema version
 */
export function getCurrentSchemaVersion(): SchemaVersion {
  return catalog.getCurrentVersion();
}

/**
 * Get all supported schema versions
 */
export function getSupportedSchemaVersions(): SchemaVersion[] {
  return catalog.getVersions();
}

/**
 * Check if a schema version is supported
 */
export function isSchemaVersionSupported(version: SchemaVersion): boolean {
  return catalog.isVersionSupported(version);
}

/**
 * Migrate a record from one schema version to another
 *
 * Automatically applies transforms in sequence.
 * Returns null if version is unsupported.
 */
export function migrateRecord(
  record: Record,
  targetVersion: SchemaVersion
): Record | null {
  const currentVersion = record.schemaVersion || '1.0';

  // No migration needed
  if (currentVersion === targetVersion) {
    return record;
  }

  const isUpgrade = compareVersions(currentVersion, targetVersion) < 0;

  if (!isUpgrade) {
    // Downgrades are not recommended and not implemented in this version
    console.warn(`Schema downgrade requested from ${currentVersion} to ${targetVersion}`);
    return null;
  }

  // Resolve the ordered chain of versions to walk, composing steps if needed.
  const path = getMigrationPath(currentVersion, targetVersion);

  if (!path) {
    if (!isSchemaVersionSupported(targetVersion)) {
      console.warn(`Target schema version not supported: ${targetVersion}`);
    } else {
      console.warn(`No migration path from ${currentVersion} to ${targetVersion}`);
    }
    return null;
  }

  let result = { ...record };
  let previousVersion = currentVersion;

  // Apply each step in order (direct v1 -> v3, or v1 -> v2 -> v3).
  for (let i = 1; i < path.length; i++) {
    const stepFrom = path[i - 1];
    const stepTo = path[i];

    try {
      result = applyMigrationStep(stepFrom, stepTo, result) || result;
    } catch (error) {
      console.error(`Failed to migrate from ${stepFrom} to ${stepTo}:`, error);
      return null;
    }

    result.schemaVersion = stepTo;
    result.migratedAt = Date.now();
    result.previousVersion = previousVersion;
    previousVersion = stepTo;
  }

  return result;
}


/**
 * Normalize a record to current schema version
 *
 * Automatically migrates to latest version if needed.
 */
export function normalizeRecord(record: Record): Record {
  const currentVersion = record.schemaVersion || '1.0';
  const targetVersion = getCurrentSchemaVersion();

  if (currentVersion === targetVersion) {
    return record;
  }

  const migrated = migrateRecord(record, targetVersion);
  return migrated || record;
}

/**
 * Result of schema guardrail validation
 */
export interface GuardrailValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  unknownFields: string[];
  deprecatedFields: string[];
  sanitized: Record;
}

/**
 * Known system metadata fields that are always allowed on records
 */
export const SYSTEM_METADATA_FIELDS = new Set<string>([
  'id',
  'schemaVersion',
  'migratedAt',
  'previousVersion',
]);

/**
 * Validate record against its schema version with configurable evolution guardrails
 */
export function validateRecordWithGuardrails(
  record: Record,
  options: GuardrailOptions = {}
): GuardrailValidationResult {
  const {
    unknownFieldPolicy = 'preserve',
    deprecatedFieldPolicy = 'warn',
    quarantineKey = '_quarantined',
    emitWarnings = true,
  } = options;

  const version = record.schemaVersion || '1.0';
  const schema = catalog.getSchema(version);

  if (!schema) {
    return {
      valid: false,
      errors: [`Schema version ${version} not found`],
      warnings: [],
      unknownFields: [],
      deprecatedFields: [],
      sanitized: { ...record },
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const unknownFields: string[] = [];
  const deprecatedFieldsFound: string[] = [];

  // Check required fields
  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    if (fieldDef.required && !(fieldName in record)) {
      errors.push(`Missing required field: ${fieldName}`);
    }
  }

  // Detect unknown and deprecated fields
  const definedFields = new Set<string>(Object.keys(schema.fields));

  for (const key of Object.keys(record)) {
    if (SYSTEM_METADATA_FIELDS.has(key)) {
      continue;
    }

    const isDefined = definedFields.has(key);
    const fieldDef = isDefined ? (schema.fields[key] as FieldDefinition) : null;
    const globalDeprecation = getDeprecatedField(key);
    const isDeprecated = (fieldDef && fieldDef.deprecated) || !!globalDeprecation;

    if (!isDefined) {
      unknownFields.push(key);
    }

    if (isDeprecated) {
      deprecatedFieldsFound.push(key);
    }
  }

  // Handle unknown fields policy
  if (unknownFields.length > 0) {
    if (unknownFieldPolicy === 'reject') {
      errors.push(`Unknown fields rejected: ${unknownFields.join(', ')}`);
    } else if (unknownFieldPolicy === 'strip') {
      warnings.push(`Stripped unknown fields: ${unknownFields.join(', ')}`);
    } else if (unknownFieldPolicy === 'quarantine') {
      warnings.push(`Quarantined unknown fields under "${quarantineKey}": ${unknownFields.join(', ')}`);
    }
  }

  // Handle deprecated fields policy
  if (deprecatedFieldsFound.length > 0) {
    for (const depField of deprecatedFieldsFound) {
      const def = (schema.fields[depField] as FieldDefinition) || undefined;
      const globalDesc = getDeprecatedField(depField);
      const replacement = def?.replacement || globalDesc?.replacement;
      const removedIn = def?.removedIn || globalDesc?.removedIn;

      let msg = `Field "${depField}" is deprecated`;
      if (replacement) {
        msg += ` (replacement: "${replacement}")`;
      }
      if (removedIn) {
        msg += ` and scheduled for removal in schema ${removedIn}`;
      }

      if (deprecatedFieldPolicy === 'reject') {
        errors.push(`${msg} and rejected by guardrail policy`);
      } else if (deprecatedFieldPolicy === 'warn') {
        warnings.push(msg);
        if (emitWarnings) {
          console.warn(`[schema-guardrails] ${msg}`);
        }
      }
    }
  }

  // Build sanitized object based on unknownFieldPolicy
  let sanitized: Record = { ...record };

  if (unknownFieldPolicy === 'strip') {
    sanitized = {} as Record;
    for (const key of Object.keys(record)) {
      if (SYSTEM_METADATA_FIELDS.has(key) || definedFields.has(key)) {
        sanitized[key] = record[key];
      }
    }
  } else if (unknownFieldPolicy === 'quarantine') {
    sanitized = {} as Record;
    const quarantined: Record<string, any> = {};
    for (const key of Object.keys(record)) {
      if (SYSTEM_METADATA_FIELDS.has(key) || definedFields.has(key)) {
        sanitized[key] = record[key];
      } else {
        quarantined[key] = record[key];
      }
    }
    sanitized[quarantineKey] = quarantined;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    unknownFields,
    deprecatedFields: deprecatedFieldsFound,
    sanitized,
  };
}

/**
 * Validate record matches schema for its version (backward compatible)
 */
export function validateRecord(record: Record): {
  valid: boolean;
  errors: string[];
} {
  const result = validateRecordWithGuardrails(record, {
    unknownFieldPolicy: 'preserve',
    deprecatedFieldPolicy: 'allow',
    emitWarnings: false,
  });

  return {
    valid: result.valid,
    errors: result.errors,
  };
}

/**
 * Guardrail-enforced record write: prepares, applies guardrails, and returns sanitized record.
 * Throws an Error if validation fails.
 */
export function guardRecordWrite(
  data: any,
  version?: SchemaVersion,
  options: GuardrailOptions = {}
): Record {
  const prepared = prepareRecordForWrite(data, version);
  const guardResult = validateRecordWithGuardrails(prepared, options);

  if (!guardResult.valid) {
    throw new Error(`Record failed schema guardrails: ${guardResult.errors.join('; ')}`);
  }

  return guardResult.sanitized;
}

/**
 * Guardrail-enforced API response processor.
 * Validates, normalizes, and applies guardrails to public API responses.
 */
export function guardAPIResponse<T extends Record>(
  responses: any | any[],
  options: GuardrailOptions = { unknownFieldPolicy: 'strip', deprecatedFieldPolicy: 'warn' }
): {
  data: T[];
  validCount: number;
  rejectedCount: number;
  errors: string[];
  warnings: string[];
} {
  const list = Array.isArray(responses) ? responses : [responses];
  const data: T[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let validCount = 0;
  let rejectedCount = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      rejectedCount++;
      errors.push('Invalid response record: must be a non-null object');
      continue;
    }

    const normalized = readRecord(raw, true);
    if (!normalized) {
      rejectedCount++;
      errors.push(`Failed to read/normalize record with version ${raw.schemaVersion || 'unspecified'}`);
      continue;
    }

    const guardResult = validateRecordWithGuardrails(normalized, options);
    if (!guardResult.valid) {
      rejectedCount++;
      errors.push(...guardResult.errors);
      continue;
    }

    validCount++;
    warnings.push(...guardResult.warnings);
    data.push(guardResult.sanitized as T);
  }

  return {
    data,
    validCount,
    rejectedCount,
    errors,
    warnings,
  };
}

/**
 * Prepare record for writing to storage
 *
 * Applies write transforms and ensures version metadata.
 */
export function prepareRecordForWrite(data: any, version?: SchemaVersion): Record {
  const targetVersion = version || getCurrentSchemaVersion();
  const schema = catalog.getSchema(targetVersion);

  if (!schema) {
    throw new Error(`Schema version not found: ${targetVersion}`);
  }

  let prepared = {
    ...data,
    schemaVersion: targetVersion,
  };

  // Apply write transform
  if (schema.transformTo) {
    try {
      prepared = schema.transformTo(prepared);
    } catch (error) {
      console.error(`Failed to prepare record for version ${targetVersion}:`, error);
      throw error;
    }
  }

  return prepared;
}

/**
 * Read and normalize record from storage
 *
 * Applies read transforms and ensures version is current.
 */
export function readRecord(
  data: any,
  autoMigrate: boolean = true
): Record | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const version = data.schemaVersion || '1.0';

  if (!isSchemaVersionSupported(version)) {
    console.warn(`Unsupported schema version when reading: ${version}`);
    if (!autoMigrate) {
      return null;
    }
  }

  if (autoMigrate) {
    return normalizeRecord(data);
  }

  return data;
}

/**
 * Handle API response that might have different schema versions
 *
 * Automatically detects and normalizes version differences.
 */
export function normalizeAPIResponse<T extends Record>(
  responses: any[]
): T[] {
  return responses
    .map(response => {
      const record = readRecord(response, true);
      return record as T;
    })
    .filter((record): record is T => record !== null);
}

/**
 * Migration strategy documentation helper
 */
export interface MigrationStrategy {
  fromVersion: SchemaVersion;
  toVersion: SchemaVersion;
  description: string;
  deprecatedFeatures?: string[];
  newFeatures?: string[];
  sunsetDate?: number;
}

const migrationStrategies: MigrationStrategy[] = [];

/**
 * Document a migration strategy
 */
export function defineMigrationStrategy(strategy: MigrationStrategy): void {
  migrationStrategies.push(strategy);
}

/**
 * Get migration path documentation
 */
export function getMigrationStrategy(
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion
): MigrationStrategy | null {
  return (
    migrationStrategies.find(
      s => s.fromVersion === fromVersion && s.toVersion === toVersion
    ) || null
  );
}

/**
 * Get all active migration strategies
 */
export function getActiveMigrationStrategies(): MigrationStrategy[] {
  return migrationStrategies.filter(s => {
    if (!s.sunsetDate) return true;
    return s.sunsetDate > Date.now();
  });
}

/**
 * Check if client version is compatible with current API
 */
export function isClientVersionCompatible(clientVersion: SchemaVersion): boolean {
  if (!isValidVersion(clientVersion)) {
    return false;
  }

  if (!isSchemaVersionSupported(clientVersion)) {
    return false;
  }

  const current = getCurrentSchemaVersion();
  const versionDiff = compareVersions(clientVersion, current);

  // Allow clients up to 2 major versions behind
  const clientMajor = parseInt(clientVersion.split('.')[0]);
  const currentMajor = parseInt(current.split('.')[0]);

  return currentMajor - clientMajor <= 2;
}

/**
 * Get compatibility warnings for client
 */
export function getClientCompatibilityWarnings(
  clientVersion: SchemaVersion
): string[] {
  const warnings: string[] = [];

  if (!isValidVersion(clientVersion)) {
    warnings.push(`Invalid version format: ${clientVersion}`);
    return warnings;
  }

  if (!isSchemaVersionSupported(clientVersion)) {
    warnings.push(`Version ${clientVersion} is not supported`);
  }

  const current = getCurrentSchemaVersion();
  if (compareVersions(clientVersion, current) < 0) {
    warnings.push(
      `Client version ${clientVersion} is outdated. Current version: ${current}`
    );
  }

  if (compareVersions(clientVersion, current) > 0) {
    warnings.push(`Client version ${clientVersion} exceeds server version ${current}`);
  }

  return warnings;
}

/**
 * Initialize schema versioning with common schemas
 */
export function initializeDefaultSchemas(): void {
  // Schema 1.0 - Base schema
  defineSchema({
    version: '1.0',
    description: 'Base schema version',
    fields: {
      id: { type: 'string', required: true },
      schemaVersion: { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
    },
  });

  // Schema 2.0 - Added migrations metadata
  defineSchema({
    version: '2.0',
    description: 'Enhanced schema with migration tracking',
    fields: {
      id: { type: 'string', required: true },
      schemaVersion: { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
      migratedAt: { type: 'number' },
      previousVersion: { type: 'string' },
    },
    transformFrom: (previousVersion: string, data: any) => {
      return {
        ...data,
        migratedAt: Date.now(),
        previousVersion,
      };
    },
  });

  // Define migration strategy documentation
  defineMigrationStrategy({
    fromVersion: '1.0',
    toVersion: '2.0',
    description: 'Add migration tracking metadata',
    newFeatures: ['migratedAt', 'previousVersion'],
    sunsetDate: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

// Auto-initialize default schemas on module load
initializeDefaultSchemas();
