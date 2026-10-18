import { z } from 'zod';

import type { AnyDomainEventDefinition, CatalogLike } from './registry';

/**
 * Schema evolution checking for the domain event catalog.
 *
 * A zod schema is reduced to a plain JSON-serialisable `SchemaDescriptor`, which
 * serves two purposes:
 *
 *  1. Two versions of an event can be diffed structurally (`diffSchemas`).
 *  2. The descriptors of every published version are committed as a snapshot, so
 *     a version that has already shipped can never be silently edited.
 *
 * Rules enforced between two versions of the same major (minor/patch bumps):
 *  - a field may not be removed
 *  - a field's type may not change
 *  - a required field may not become optional, nor an optional one required
 *  - a new field must be optional or carry a default
 *  - enum values / union members / literals may not be removed or changed
 *
 * A major bump is the sanctioned place for breaking changes, so those pairs are
 * not diffed. See docs/DOMAIN_EVENTS.md.
 */

export interface SchemaDescriptor {
  kind: string;
  optional: boolean;
  hasDefault: boolean;
  nullable: boolean;
  values?: string[];
  literal?: string;
  fields?: Record<string, SchemaDescriptor>;
  items?: SchemaDescriptor;
  options?: SchemaDescriptor[];
  /** Validation constraints (min, max, int...). Only used by snapshot equality. */
  constraints?: string;
}

export type SchemaSnapshot = Record<string, Record<string, SchemaDescriptor>>;

export interface CompatProblem {
  event: string;
  from?: string;
  to?: string;
  path: string;
  message: string;
}

/** True when the field must be present in a payload. */
export function isRequired(descriptor: SchemaDescriptor): boolean {
  return !descriptor.optional && !descriptor.hasDefault;
}

export function describeSchema(schema: z.ZodTypeAny): SchemaDescriptor {
  let current: z.ZodTypeAny = schema;
  let optional = false;
  let hasDefault = false;
  let nullable = false;

  // Unwrap modifiers until we reach the structural schema.
  for (;;) {
    const typeName = (current._def as { typeName?: string }).typeName;
    if (typeName === 'ZodOptional') {
      optional = true;
      current = (current._def as { innerType: z.ZodTypeAny }).innerType;
    } else if (typeName === 'ZodDefault') {
      hasDefault = true;
      current = (current._def as { innerType: z.ZodTypeAny }).innerType;
    } else if (typeName === 'ZodNullable') {
      nullable = true;
      current = (current._def as { innerType: z.ZodTypeAny }).innerType;
    } else if (typeName === 'ZodEffects') {
      current = (current._def as { schema: z.ZodTypeAny }).schema;
    } else {
      break;
    }
  }

  const def = current._def as Record<string, unknown> & { typeName: string };
  const descriptor: SchemaDescriptor = { kind: def.typeName, optional, hasDefault, nullable };

  if (current instanceof z.ZodObject) {
    const shape = current.shape as Record<string, z.ZodTypeAny>;
    descriptor.fields = Object.fromEntries(
      Object.keys(shape)
        .sort()
        .map((key) => [key, describeSchema(shape[key])]),
    );
  } else if (current instanceof z.ZodArray) {
    descriptor.items = describeSchema(current.element);
  } else if (current instanceof z.ZodEnum) {
    descriptor.values = [...(current.options as string[])].sort();
  } else if (current instanceof z.ZodLiteral) {
    descriptor.literal = JSON.stringify(current.value);
  } else if (current instanceof z.ZodUnion) {
    descriptor.options = (current.options as z.ZodTypeAny[]).map(describeSchema);
  }

  const checks = def.checks as Array<{ kind: string; value?: unknown; inclusive?: boolean }> | undefined;
  if (checks && checks.length > 0) {
    descriptor.constraints = JSON.stringify(
      checks.map((check) => ({ kind: check.kind, value: check.value, inclusive: check.inclusive })),
    );
  }

  return descriptor;
}

const stable = (descriptor: SchemaDescriptor): string => JSON.stringify(descriptor);

/**
 * Diff two descriptors and return a human-readable list of breaking changes.
 * Empty means `next` is a compatible evolution of `prev`.
 */
export function diffSchemas(prev: SchemaDescriptor, next: SchemaDescriptor, path = '$'): string[] {
  const problems: string[] = [];

  if (prev.kind !== next.kind) {
    problems.push(`${path}: type changed from ${prev.kind} to ${next.kind}.`);
    return problems;
  }

  if (prev.nullable && !next.nullable) {
    problems.push(`${path}: no longer accepts null.`);
  }

  if (prev.literal !== next.literal) {
    problems.push(`${path}: literal changed from ${prev.literal} to ${next.literal}.`);
  }

  if (prev.values) {
    const removed = prev.values.filter((value) => !(next.values ?? []).includes(value));
    if (removed.length > 0) {
      problems.push(`${path}: enum value(s) removed: ${removed.join(', ')}.`);
    }
  }

  if (prev.options) {
    const nextOptions = new Set((next.options ?? []).map(stable));
    const removed = prev.options.filter((option) => !nextOptions.has(stable(option)));
    if (removed.length > 0) {
      problems.push(`${path}: ${removed.length} union member(s) removed or changed.`);
    }
  }

  if (prev.items && next.items) {
    problems.push(...diffSchemas(prev.items, next.items, `${path}[]`));
  }

  if (prev.fields || next.fields) {
    const prevFields = prev.fields ?? {};
    const nextFields = next.fields ?? {};

    for (const [key, prevField] of Object.entries(prevFields)) {
      const nextField = nextFields[key];
      const fieldPath = `${path}.${key}`;

      if (!nextField) {
        problems.push(
          `${fieldPath}: ${isRequired(prevField) ? 'required ' : ''}field removed. Removing a field requires a major version bump.`,
        );
        continue;
      }

      if (isRequired(prevField) && !isRequired(nextField)) {
        problems.push(`${fieldPath}: required field became optional; consumers of the old version rely on it.`);
      } else if (!isRequired(prevField) && isRequired(nextField)) {
        problems.push(`${fieldPath}: optional field became required; older events would be rejected.`);
      }

      problems.push(...diffSchemas(prevField, nextField, fieldPath));
    }

    for (const [key, nextField] of Object.entries(nextFields)) {
      if (!prevFields[key] && isRequired(nextField)) {
        problems.push(
          `${path}.${key}: new required field has no default. Make it optional or give it a default.`,
        );
      }
    }
  }

  return problems;
}

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Check one event's version chain: every consecutive pair that shares a major
 * must be a compatible evolution.
 */
export function checkVersionChain(definition: AnyDomainEventDefinition): CompatProblem[] {
  const versions = Object.keys(definition.versions).sort(compareVersions);
  const problems: CompatProblem[] = [];

  for (let i = 1; i < versions.length; i += 1) {
    const from = versions[i - 1];
    const to = versions[i];
    if (majorOf(from) !== majorOf(to)) continue;

    const diff = diffSchemas(describeSchema(definition.versions[from]), describeSchema(definition.versions[to]));
    for (const message of diff) {
      problems.push({ event: definition.name, from, to, path: message.split(':')[0], message });
    }
  }

  return problems;
}

/** Build the snapshot of every registered version. */
export function buildSnapshot(catalog: CatalogLike): SchemaSnapshot {
  const snapshot: SchemaSnapshot = {};
  for (const definition of Object.values(catalog)) {
    snapshot[definition.name] = {};
    for (const version of Object.keys(definition.versions).sort(compareVersions)) {
      snapshot[definition.name][version] = describeSchema(definition.versions[version]);
    }
  }
  return snapshot;
}

/**
 * Validate the catalog against the committed historic snapshot and the
 * evolution rules. Returns every problem found; empty means safe to merge.
 */
export function checkSchemaEvolution(catalog: CatalogLike, snapshot: SchemaSnapshot): CompatProblem[] {
  const problems: CompatProblem[] = [];

  for (const definition of Object.values(catalog)) {
    problems.push(...checkVersionChain(definition));

    const historic = snapshot[definition.name];
    if (!historic) {
      problems.push({
        event: definition.name,
        path: '$',
        message: 'Event is not in the schema snapshot. Run `npm run validate:events -- --update-snapshot` and commit it.',
      });
      continue;
    }

    for (const version of Object.keys(definition.versions)) {
      if (!historic[version]) {
        problems.push({
          event: definition.name,
          to: version,
          path: '$',
          message: `Version ${version} is not in the schema snapshot. Run \`npm run validate:events -- --update-snapshot\` and commit it.`,
        });
      }
    }
  }

  for (const [name, versions] of Object.entries(snapshot)) {
    const definition = catalog[name];
    if (!definition) {
      problems.push({ event: name, path: '$', message: 'Event was removed from the registry but shipped in an earlier release.' });
      continue;
    }

    for (const [version, descriptor] of Object.entries(versions)) {
      const schema = definition.versions[version];
      if (!schema) {
        problems.push({ event: name, from: version, path: '$', message: `Published version ${version} was removed; older producers can still emit it.` });
        continue;
      }

      const current = describeSchema(schema);
      if (stable(current) !== stable(descriptor)) {
        const detail = diffSchemas(descriptor, current);
        problems.push({
          event: name,
          from: version,
          to: version,
          path: '$',
          message:
            `Published version ${version} was modified in place` +
            (detail.length > 0 ? `: ${detail.join(' ')}` : ' (constraints changed)') +
            ' Add a new version instead of editing a shipped one.',
        });
      }
    }
  }

  return problems;
}
