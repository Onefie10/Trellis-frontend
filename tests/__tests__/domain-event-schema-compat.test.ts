import { z } from 'zod';

import {
  DOMAIN_EVENTS,
  buildSnapshot,
  checkSchemaEvolution,
  checkVersionChain,
  describeSchema,
  diffSchemas,
  type AnyDomainEventDefinition,
  type CatalogLike,
} from '../../lib/domain-events';

import snapshot from '../../lib/domain-events/schema-snapshot.json';

const diff = (prev: z.ZodTypeAny, next: z.ZodTypeAny) => diffSchemas(describeSchema(prev), describeSchema(next));

describe('domain event schema evolution', () => {
  const base = z.object({ id: z.string(), count: z.number().optional() });

  it('allows adding an optional field', () => {
    expect(diff(base, base.extend({ note: z.string().optional() }))).toEqual([]);
  });

  it('allows adding a required field that has a default', () => {
    expect(diff(base, base.extend({ flag: z.boolean().default(false) }))).toEqual([]);
  });

  it('allows adding enum values', () => {
    expect(diff(z.object({ m: z.enum(['a']) }), z.object({ m: z.enum(['a', 'b']) }))).toEqual([]);
  });

  it('rejects removing a required field', () => {
    const problems = diff(base, z.object({ count: z.number().optional() }));
    expect(problems.join(' ')).toMatch(/\$\.id: required field removed/);
  });

  it('rejects changing a field type', () => {
    expect(diff(base, z.object({ id: z.number(), count: z.number().optional() })).join(' ')).toMatch(
      /type changed from ZodString to ZodNumber/,
    );
  });

  it('rejects a new required field without a default', () => {
    expect(diff(base, base.extend({ extra: z.string() })).join(' ')).toMatch(/new required field has no default/);
  });

  it('rejects required <-> optional flips', () => {
    expect(diff(base, z.object({ id: z.string().optional(), count: z.number().optional() })).join(' ')).toMatch(
      /became optional/,
    );
    expect(diff(base, z.object({ id: z.string(), count: z.number() })).join(' ')).toMatch(/became required/);
  });

  it('rejects removed enum values and changed literals', () => {
    expect(diff(z.object({ m: z.enum(['a', 'b']) }), z.object({ m: z.enum(['a']) })).join(' ')).toMatch(/removed: b/);
    expect(diff(z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false) })).join(' ')).toMatch(
      /literal changed/,
    );
  });

  it('detects breaking changes in nested objects and arrays', () => {
    const prev = z.object({ items: z.array(z.object({ id: z.string() })) });
    const next = z.object({ items: z.array(z.object({ id: z.number() })) });
    expect(diff(prev, next).join(' ')).toMatch(/\$\.items\[\]\.id: type changed/);
  });

  describe('version chains', () => {
    const make = (versions: Record<string, z.ZodTypeAny>) =>
      ({ name: 'TEST_EVENT', versions }) as unknown as AnyDomainEventDefinition;

    it('fails a breaking minor bump', () => {
      const problems = checkVersionChain(make({ '1.0.0': base, '1.1.0': z.object({ count: z.number().optional() }) }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ event: 'TEST_EVENT', from: '1.0.0', to: '1.1.0' });
    });

    it('allows a breaking change across a major bump', () => {
      expect(checkVersionChain(make({ '1.0.0': base, '2.0.0': z.object({ other: z.string() }) }))).toEqual([]);
    });

    it('allows a compatible minor bump', () => {
      expect(
        checkVersionChain(make({ '1.0.0': base, '1.1.0': base.extend({ n: z.string().optional() }) })),
      ).toEqual([]);
    });
  });

  describe('against the committed snapshot', () => {
    const catalog = (versions: Record<string, z.ZodTypeAny>) =>
      ({ E: { name: 'E', versions } }) as unknown as CatalogLike;
    const snap = buildSnapshot(catalog({ '1.0.0': base }));

    it('passes for the real catalog', () => {
      expect(checkSchemaEvolution(DOMAIN_EVENTS as unknown as CatalogLike, snapshot as never)).toEqual([]);
    });

    it('fails when a published version is edited in place', () => {
      const problems = checkSchemaEvolution(catalog({ '1.0.0': z.object({ id: z.string() }) }), snap);
      expect(problems.map((p) => p.message).join(' ')).toMatch(/modified in place/);
    });

    it('fails when a published version is removed', () => {
      const problems = checkSchemaEvolution(catalog({ '2.0.0': base }), snap);
      expect(problems.map((p) => p.message).join(' ')).toMatch(/removed/);
    });

    it('requires new versions to be snapshotted', () => {
      const problems = checkSchemaEvolution(catalog({ '1.0.0': base, '1.1.0': base }), snap);
      expect(problems.map((p) => p.message).join(' ')).toMatch(/not in the schema snapshot/);
    });
  });
});
