import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import {
  DOMAIN_EVENTS,
  DomainEventValidationError,
  EventEnvelopeSchema,
  UnknownDomainEventError,
  assertCatalogValid,
  collectCatalogProblems,
  compareSemver,
  composeParseSchema,
  composePublishSchema,
  createBroadcastDelivery,
  createWindowDelivery,
  describeCatalog,
  getDomainEventDefinition,
  getDomainEventSchema,
  listDomainEventDefinitions,
  parseDomainEvent,
  publishDomainEvent,
  subscribeDomainChannel,
  subscribeDomainEvent,
  tryPublishDomainEvent,
  type AnyDomainEventDefinition,
  type CatalogLike,
  type DomainEventEnvelope,
  type DomainEventFallbackContext,
  type LegacyDomainEventContext,
  type RegisteredEventName,
} from '../../lib/domain-events';
import { DeadLetterQueue, computeBackoffMs } from '../../lib/domain-events';
import {
  OFFLINE_QUEUE_CHANGE_EVENT,
  OFFLINE_QUEUE_SYNCED_EVENT,
} from '../../lib/pwa-utils';
import type { StellarNetwork } from '../../lib/types';

const FIXTURE_DIR = resolve(__dirname, '../fixtures/domain-events');

/**
 * One recorded case from a fixture file. Fixtures are plain JSON so the same
 * files can be replayed by `npm run validate:events` outside Jest.
 */
interface FixtureCase {
  name: string;
  expect: 'accepted' | 'rejected';
  reason?: string;
  event: unknown;
}

interface FixtureFile {
  description: string;
  expectAll: 'accepted' | 'rejected';
  cases: FixtureCase[];
  nonObjectCases?: FixtureCase[];
}

function loadFixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf-8')) as FixtureFile;
}

const validEvents = loadFixture('valid-events.json');
const invalidEnvelopes = loadFixture('invalid-envelope.json');
const invalidMissingField = loadFixture('invalid-missing-field.json');
const invalidUnknownVersion = loadFixture('invalid-unknown-version.json');

/** A fresh copy of a fixture case, safe to mutate per test. */
function envelopeOf(testCase: FixtureCase): Record<string, unknown> {
  return JSON.parse(JSON.stringify(testCase.event)) as Record<string, unknown>;
}

const FIXED_TIME = new Date('2026-02-11T09:00:00.000Z');

/**
 * An in-memory transport. Lets the suite assert on the exact envelope a
 * producer delivered without needing a real `window` or a real channel, and
 * without letting one test leak a listener into the next.
 */
function recordingDelivery(): {
  delivery: ReturnType<typeof createWindowDelivery>;
  sent: DomainEventEnvelope<unknown>[];
} {
  const sent: DomainEventEnvelope<unknown>[] = [];

  return {
    sent,
    delivery: {
      transport: 'window',
      dispatch(envelope) {
        sent.push(envelope);
      },
    },
  };
}

/** Options for {@link recordingDelivery} that pin the volatile envelope fields. */
const DETERMINISTIC = { id: 'evt-fixed', now: () => FIXED_TIME } as const;

describe('Trellis domain event contract', () => {
  describe('Catalog integrity', () => {
    it('registers every event with a description, transport, and version', () => {
      const problems = collectCatalogProblems(DOMAIN_EVENTS as unknown as CatalogLike);

      expect(problems).toEqual([]);
    });

    it('does not throw for the real catalog, because the import guard already passed', () => {
      expect(() => assertCatalogValid(DOMAIN_EVENTS as unknown as CatalogLike)).not.toThrow();
    });

    it('keys every catalog entry by its own name', () => {
      for (const definition of listDomainEventDefinitions()) {
        expect(DOMAIN_EVENTS[definition.name as RegisteredEventName]).toBeDefined();
      }
    });

    it('gives every event at least one readable version and a current one', () => {
      for (const definition of listDomainEventDefinitions()) {
        expect(Object.keys(definition.versions).length).toBeGreaterThan(0);
        expect(definition.versions[definition.currentVersion]).toBeDefined();
        expect(definition.currentVersion).toMatch(/^\d+\.\d+\.\d+$/);
      }
    });

    it('keeps pwa-utils event-name constants in step with the catalog', () => {
      // Guards against a constant being renamed in one place only.
      expect(getDomainEventDefinition(OFFLINE_QUEUE_CHANGE_EVENT)).toBeDefined();
      expect(getDomainEventDefinition(OFFLINE_QUEUE_SYNCED_EVENT)).toBeDefined();
      expect(OFFLINE_QUEUE_CHANGE_EVENT).toBe('offline-queue-change');
      expect(OFFLINE_QUEUE_SYNCED_EVENT).toBe('offline-queue-synced');
    });

    it('describes every event for the docs and the validation CLI', () => {
      const described = describeCatalog();

      expect(described).toHaveLength(listDomainEventDefinitions().length);

      for (const entry of described) {
        expect(entry.title).not.toHaveLength(0);
        expect(entry.description).not.toHaveLength(0);
        expect(entry.readableVersions).toContain(entry.version);
      }
    });
  });

  describe('Catalog guard rejects a broken contract', () => {
    /**
     * The import-time guard only ever runs against the real catalog, which is
     * what you want in production and useless for proving the guard works. These
     * cases feed `collectCatalogProblems` a deliberately broken catalog.
     *
     * Overrides are *merged* into an otherwise well-formed definition. Replacing
     * the whole entry would leave every field missing, so the guard would pass
     * for reasons that have nothing to do with the defect under test.
     */
    const WELL_FORMED = {
      name: 'a-perfectly-fine-event',
      title: 'Fine',
      description: 'A well-formed definition.',
      transport: 'window',
      stability: 'stable',
      currentVersion: '1.0.0',
      introducedIn: 'Test',
      versions: { '1.0.0': EventEnvelopeSchema },
    };

    function brokenCatalog(overrides: Record<string, unknown> = {}): CatalogLike {
      return {
        [WELL_FORMED.name]: { ...WELL_FORMED, ...overrides },
      } as unknown as CatalogLike;
    }

    it('accepts a well-formed catalog', () => {
      expect(collectCatalogProblems(brokenCatalog())).toEqual([]);
    });

    it.each([
      ['a key that disagrees with the name', { name: 'renamed' }, 'does not match definition.name'],
      ['a missing title', { title: '  ' }, 'title is required'],
      ['a missing description', { description: '' }, 'description is required'],
      ['a missing introducedIn', { introducedIn: '' }, 'introducedIn is required'],
      ['an unknown transport', { transport: 'carrier-pigeon' }, 'transport must be'],
      ['an unknown stability', { stability: 'sort-of-stable' }, 'stability must be'],
      ['a non-semver currentVersion', { currentVersion: '1.0' }, 'is not semantic'],
      ['a non-semver version key', { versions: { '1': EventEnvelopeSchema } }, 'version key "1" is not semantic'],
      ['a version that is not a zod schema', { versions: { '1.0.0': { safeParse: true } } }, 'does not map to a zod schema'],
      ['a null version schema', { versions: { '1.0.0': null } }, 'does not map to a zod schema'],
      ['no versions at all', { versions: {} }, 'at least one versioned schema'],
      ['a name with characters outside the pattern', { name: 'not a valid name!' }, 'does not match the required pattern'],
    ])('rejects %s', (_label, overrides, expectedFragment) => {
      // Match the specific defect rather than a problem count: some defects
      // legitimately raise two problems, and a count would let a guard that
      // rejected the entry for an unrelated reason still pass.
      const problems = collectCatalogProblems(brokenCatalog(overrides));

      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join('\n')).toContain(expectedFragment);
    });

    it('rejects a currentVersion that has no registered schema', () => {
      const catalog = brokenCatalog({ currentVersion: '2.0.0' });

      const problems = collectCatalogProblems(catalog);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('2.0.0');
      expect(() => assertCatalogValid(catalog)).toThrow(/catalog is invalid/i);
    });

    it('rejects a deprecation that names no replacement', () => {
      const problems = collectCatalogProblems(brokenCatalog({ stability: 'deprecated' }));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('upgradeNotes');
    });

    it('accepts a deprecation that does name a replacement', () => {
      const catalog = brokenCatalog({
        stability: 'deprecated',
        upgradeNotes: 'Use replacement-event instead.',
      });

      expect(collectCatalogProblems(catalog)).toEqual([]);
    });

    it('reports a definition that is not an object at all', () => {
      expect(collectCatalogProblems({ 'a-perfectly-fine-event': null } as unknown as CatalogLike).join('\n')).toContain(
        'not an object',
      );
    });
  });

  describe('Producer validation', () => {
    it('stamps an explicit version, id, timestamp, and source onto every envelope', () => {
      const { delivery, sent } = recordingDelivery();

      const envelope = publishDomainEvent('offline-queue-change', { pending: 4 }, {
        ...DETERMINISTIC,
        delivery,
        source: 'pwa-utils',
      });

      expect(envelope).toEqual({
        name: 'offline-queue-change',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'pwa-utils',
        payload: { pending: 4 },
      });
      expect(sent).toEqual([envelope]);
    });

    it('delivers only after the payload has validated', () => {
      const { delivery, sent } = recordingDelivery();

      expect(() =>
        publishDomainEvent(
          'offline-queue-change',
          { pending: 'four' } as unknown as { pending: number },
          { ...DETERMINISTIC, delivery, source: 'pwa-utils' },
        ),
      ).toThrow(DomainEventValidationError);

      expect(sent).toEqual([]);
    });

    it('refuses an unregistered event name rather than guessing a shape', () => {
      const { delivery, sent } = recordingDelivery();

      expect(() =>
        publishDomainEvent(
          'trellis-internal-debug' as RegisteredEventName,
          { anything: true } as never,
          { ...DETERMINISTIC, delivery, source: 'test' },
        ),
      ).toThrow(UnknownDomainEventError);

      expect(sent).toEqual([]);
    });

    it('explains every validation failure in the thrown error', () => {
      try {
        publishDomainEvent(
          'offline-queue-synced',
          { synced: 'sub-1', dropped: [], remaining: '0' } as unknown as {
            synced: string[];
            dropped: string[];
            remaining: number;
          },
          { ...DETERMINISTIC, delivery: recordingDelivery().delivery, source: 'pwa-utils' },
        );
        throw new Error('expected the publication to be refused');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainEventValidationError);
        const validationError = error as DomainEventValidationError;
        expect(validationError.eventName).toBe('offline-queue-synced');
        expect(validationError.issues.length).toBeGreaterThan(0);
        expect(validationError.message).toContain('offline-queue-synced');
        expect(validationError.message).toContain('1.0.0');
      }
    });

    it('strips undeclared payload keys so consumers get exactly the declared fields', () => {
      const { delivery, sent } = recordingDelivery();

      publishDomainEvent(
        'offline-queue-change',
        { pending: 1, urgent: true } as unknown as { pending: number },
        { ...DETERMINISTIC, delivery, source: 'pwa-utils' },
      );

      expect(sent[0].payload).toEqual({ pending: 1 });
    });

    it('still refuses an undeclared top-level envelope field', () => {
      const { delivery, sent } = recordingDelivery();
      const definition = getDomainEventDefinition('offline-queue-change') as AnyDomainEventDefinition;
      const candidate = {
        name: 'offline-queue-change',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'pwa-utils',
        payload: { pending: 1 },
        internalOnly: 'should never cross the boundary',
      };

      // The composed publish schema is strict even though the payload is not.
      expect(composePublishSchema(definition).safeParse(candidate).success).toBe(false);
      expect(sent).toEqual([]);
    });

    it('generates a unique id when none is supplied', () => {
      const { delivery } = recordingDelivery();

      const first = publishDomainEvent('connection-change', { online: true }, { delivery, source: 'pwa-utils' });
      const second = publishDomainEvent('connection-change', { online: true }, { delivery, source: 'pwa-utils' });

      expect(first.id).not.toBe(second.id);
      expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('tryPublishDomainEvent', () => {
    it('re-raises by default, so switching to it is opt-in', () => {
      const { delivery } = recordingDelivery();

      expect(() =>
        tryPublishDomainEvent(
          'offline-queue-change',
          { pending: -1 } as unknown as { pending: number },
          { ...DETERMINISTIC, delivery, source: 'pwa-utils' },
        ),
      ).toThrow(DomainEventValidationError);
    });

    it('discards and reports when asked to drop, without interrupting the caller', () => {
      const { delivery, sent } = recordingDelivery();

      const result = tryPublishDomainEvent(
        'offline-queue-change',
        { pending: -1 } as unknown as { pending: number },
        { ...DETERMINISTIC, delivery, source: 'pwa-utils', onInvalid: 'drop' },
      );

      expect(result.ok).toBe(false);
      expect(sent).toEqual([]);
    });

    it('returns the envelope when the payload is valid', () => {
      const { delivery } = recordingDelivery();

      const result = tryPublishDomainEvent('connection-change', { online: false }, {
        ...DETERMINISTIC,
        delivery,
        source: 'pwa-utils',
        onInvalid: 'drop',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.payload).toEqual({ online: false });
      }
    });

    it('does not swallow an unrelated programming error', () => {
      const exploding = {
        transport: 'window' as const,
        dispatch() {
          throw new TypeError('transport is broken');
        },
      };

      expect(() =>
        tryPublishDomainEvent('connection-change', { online: true }, {
          ...DETERMINISTIC,
          delivery: exploding,
          source: 'pwa-utils',
          onInvalid: 'drop',
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Valid events (fixture)', () => {
    it('declares every case as accepted', () => {
      expect(validEvents.expectAll).toBe('accepted');
    });

    it.each(validEvents.cases.map((testCase) => [testCase.name, testCase] as const))(
      'accepts %s',
      (_label, testCase) => {
        const result = parseDomainEvent(testCase.event);
        const event = testCase.event as { name: string; version: string };
        const currentVersion = getDomainEventDefinition(event.name)?.currentVersion;

        expect(result.status).toBe('accepted');

        if (result.status === 'accepted') {
          expect(result.version).toBe(event.version);
          // A fixture may deliberately record a legacy version; anything else
          // must be the version the catalog publishes today.
          expect(result.isLegacy).toBe(event.version !== currentVersion);
          // The accepted payload must equal what the fixture recorded.
          expect(result.payload).toEqual((testCase.event as { payload: unknown }).payload);
        }
      },
    );

    it('exercises every registered event at least once', () => {
      const covered = new Set(validEvents.cases.map((testCase) => (testCase.event as { name: string }).name));

      for (const definition of listDomainEventDefinitions()) {
        expect(covered).toContain(definition.name);
      }
    });
  });

  describe('Missing or mistyped payload fields (fixture)', () => {
    it('declares every case as rejected', () => {
      expect(invalidMissingField.expectAll).toBe('rejected');
    });

    it.each(invalidMissingField.cases.map((testCase) => [testCase.name, testCase] as const))(
      'rejects %s',
      (_label, testCase) => {
        const result = parseDomainEvent(testCase.event);

        expect(result.status).toBe('rejected');
        expect(result.reason).toBe(testCase.reason);
        expect(result.issues.length).toBeGreaterThan(0);
      },
    );

    it('reports the offending field path, not just a generic failure', () => {
      const testCase = invalidMissingField.cases.find(
        (entry) => entry.name === 'offline-queue-change with no pending field',
      );
      const result = parseDomainEvent(testCase?.event);

      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.issues.join('\n')).toContain('pending');
      }
    });
  });

  describe('Unknown and malformed versions (fixture)', () => {
    it('declares every case as rejected', () => {
      expect(invalidUnknownVersion.expectAll).toBe('rejected');
    });

    it.each(invalidUnknownVersion.cases.map((testCase) => [testCase.name, testCase] as const))(
      'rejects %s',
      (_label, testCase) => {
        const result = parseDomainEvent(testCase.event);

        expect(result.status).toBe('rejected');
        expect(result.reason).toBe(testCase.reason);
      },
    );

    it('refuses a version newer than this build even when the payload is valid', () => {
      const testCase = invalidUnknownVersion.cases.find(
        (entry) => entry.name === 'future major version from a newer producer',
      );
      const result = parseDomainEvent(testCase?.event);

      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBe('unknown-version');
        expect(result.version).toBe('2.0.0');
        expect(result.issues.join('\n')).toContain('1.0.0');
      }
    });
  });

  describe('Malformed envelopes (fixture)', () => {
    it('declares every case as rejected', () => {
      expect(invalidEnvelopes.expectAll).toBe('rejected');
    });

    it.each(invalidEnvelopes.cases.map((testCase) => [testCase.name, testCase] as const))(
      'rejects %s',
      (_label, testCase) => {
        const result = parseDomainEvent(testCase.event);

        expect(result.status).toBe('rejected');
        expect(result.reason).toBe(testCase.reason);
      },
    );

    it.each((invalidEnvelopes.nonObjectCases ?? []).map((testCase) => [testCase.name, testCase] as const))(
      'rejects %s',
      (_label, testCase) => {
        const result = parseDomainEvent(testCase.event);

        expect(result.status).toBe('rejected');
        expect(result.reason).toBe('not-an-object');
      },
    );
  });

  describe('Consumer fallback', () => {
    /**
     * A stand-in for a real `window` event. Deliver the recorded detail exactly
     * as a transport would, so the suite exercises the same listener path the
     * app uses.
     */
    function dispatchToWindow(name: string, detail: unknown): void {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    it('never calls the typed handler for an unreadable event', () => {
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainEvent(
        'offline-queue-change',
        handler,
        { target: window, fallback },
      );

      dispatchToWindow('offline-queue-change', { pending: 'three' });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('hands the fallback enough context to explain itself', () => {
      const handler = jest.fn();
      let context: DomainEventFallbackContext | undefined;

      subscribeDomainEvent('offline-queue-change', handler, {
        target: window,
        fallback: (received) => {
          context = received;
        },
      });

      const drifted = envelopeOf(
        invalidMissingField.cases.find(
          (entry) => entry.name === 'offline-queue-change with no pending field',
        ) as FixtureCase,
      );
      dispatchToWindow('offline-queue-change', drifted);

      expect(context).toEqual(
        expect.objectContaining({
          name: 'offline-queue-change',
          receivedVersion: '1.0.0',
          currentVersion: '1.0.0',
          reason: 'invalid-payload',
        }),
      );
      expect(context?.issues.length).toBeGreaterThan(0);
    });

    it('routes an unknown version to the fallback with both versions named', () => {
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainEvent('offline-queue-change', handler, { target: window, fallback });

      dispatchToWindow('offline-queue-change', {
        name: 'offline-queue-change',
        version: '9.9.9',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'newer-tab',
        payload: { pending: 2 },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unknown-version', receivedVersion: '9.9.9', currentVersion: '1.0.0' }),
      );
    });

    it('routes a malformed version to the fallback', () => {
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainEvent('offline-queue-change', handler, { target: window, fallback });

      dispatchToWindow('offline-queue-change', {
        name: 'offline-queue-change',
        version: 1,
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'newer-tab',
        payload: { pending: 2 },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'malformed-version', receivedVersion: null }),
      );
    });

    it('discards quietly when no fallback is registered', () => {
      const handler = jest.fn();

      subscribeDomainEvent('offline-queue-change', handler, { target: window });

      const drifted = envelopeOf(
        invalidMissingField.cases.find(
          (entry) => entry.name === 'offline-queue-change with a stringified pending count',
        ) as FixtureCase,
      );

      expect(() => dispatchToWindow('offline-queue-change', drifted)).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', () => {
      const handler = jest.fn();
      const unsubscribe = subscribeDomainEvent('connection-change', handler, { target: window });

      // Dispatch through the real producer so the detail is a valid envelope
      // rather than a bare payload.
      const { delivery } = recordingDelivery();
      const publish = () =>
        publishDomainEvent('connection-change', { online: true }, {
          ...DETERMINISTIC,
          delivery,
          source: 'pwa-utils',
        });

      dispatchToWindow('connection-change', publish());
      unsubscribe();
      dispatchToWindow('connection-change', publish());

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('delivers the validated payload to the handler on the happy path', () => {
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainEvent('connection-change', handler, { target: window, fallback });

      const { delivery } = recordingDelivery();
      const envelope = publishDomainEvent('connection-change', { online: true }, {
        ...DETERMINISTIC,
        delivery,
        source: 'pwa-utils',
      });

      dispatchToWindow('connection-change', envelope);

      expect(fallback).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith({ online: true }, expect.objectContaining({ id: 'evt-fixed' }));
    });

    it('honours an acceptVersions allow-list', () => {
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainEvent('offline-queue-change', handler, {
        target: window,
        fallback,
        acceptVersions: ['2.0.0'],
      });

      dispatchToWindow('offline-queue-change', {
        name: 'offline-queue-change',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'pwa-utils',
        payload: { pending: 1 },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unknown-version' }),
      );
    });
  });

  describe('Legacy version handling', () => {
    /**
     * A synthetic definition carrying two versions, so the rolling-deploy path
     * is provable without mutating the real catalog's contracts. Both versions
     * deliberately share a schema: the point under test is version *routing*,
     * not payload difference.
     */
    const versionedCatalog: CatalogLike = {
      'rolling-example': {
        name: 'rolling-example',
        title: 'Rolling deploy example',
        description: 'Carries a superseded and a current payload schema.',
        transport: 'window',
        stability: 'stable',
        currentVersion: '2.0.0',
        introducedIn: 'Test',
        versions: {
          '1.0.0': z.object({ pending: z.number() }),
          '2.0.0': z.object({ pending: z.number() }),
        },
      } as unknown as CatalogLike,
    };

    /** The real catalog, snapshotted so a synthetic entry cannot leak out. */
    const realCatalog = { ...(DOMAIN_EVENTS as unknown as Record<string, unknown>) };
    const mutableCatalog = DOMAIN_EVENTS as unknown as Record<string, unknown>;

    afterEach(() => {
      for (const key of Object.keys(mutableCatalog)) {
        if (!(key in realCatalog)) delete mutableCatalog[key];
      }
      Object.assign(mutableCatalog, realCatalog);
    });

    function withSyntheticEvent<T>(run: () => T): T {
      Object.assign(mutableCatalog, versionedCatalog);
      return run();
    }

    it('reports a readable non-current version as legacy rather than rejecting it', () => {
      const result = withSyntheticEvent(() =>
        parseDomainEvent({
          name: 'rolling-example',
          version: '1.0.0',
          id: 'evt-fixed',
          timestamp: '2026-02-11T09:00:00.000Z',
          source: 'old-tab',
          payload: { pending: 1 },
        }),
      );

      expect(result.status).toBe('accepted');
      if (result.status === 'accepted') {
        expect(result.isLegacy).toBe(true);
        expect(result.version).toBe('1.0.0');
      }
    });

    it('does not hand a legacy payload to the typed handler', () => {
      const handler = jest.fn();
      const onLegacy = jest.fn();

      withSyntheticEvent(() => {
        subscribeDomainEvent('rolling-example' as RegisteredEventName, handler, {
          target: window,
          onLegacy,
        });

        window.dispatchEvent(
          new CustomEvent('rolling-example', {
            detail: {
              name: 'rolling-example',
              version: '1.0.0',
              id: 'evt-fixed',
              timestamp: '2026-02-11T09:00:00.000Z',
              source: 'old-tab',
              payload: { pending: 1 },
            },
          }),
        );
      });

      expect(handler).not.toHaveBeenCalled();
      expect(onLegacy).toHaveBeenCalledWith(
        { pending: 1 },
        expect.objectContaining({ receivedVersion: '1.0.0', currentVersion: '2.0.0', isFuture: false }),
      );
    });

    it('sends a legacy version to the fallback when onLegacy is absent', () => {
      const handler = jest.fn();
      const fallback = jest.fn();

      withSyntheticEvent(() => {
        subscribeDomainEvent('rolling-example' as RegisteredEventName, handler, {
          target: window,
          fallback,
        });

        window.dispatchEvent(
          new CustomEvent('rolling-example', {
            detail: {
              name: 'rolling-example',
              version: '1.0.0',
              id: 'evt-fixed',
              timestamp: '2026-02-11T09:00:00.000Z',
              source: 'old-tab',
              payload: { pending: 1 },
            },
          }),
        );
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'legacy-version' }),
      );
    });

    it('flags a registered version that is newer than current as future', () => {
      // The catalog only guards that `currentVersion` has a schema, not that it
      // is the highest. A version registered ahead of `currentVersion` is how a
      // producer that is ahead of this build still gets its event read.
      const aheadCatalog: CatalogLike = {
        'rolling-example': {
          name: 'rolling-example',
          title: 'Producer ahead of consumer',
          description: 'Registers a version beyond currentVersion.',
          transport: 'window',
          stability: 'stable',
          currentVersion: '2.0.0',
          introducedIn: 'Test',
          versions: {
            '1.0.0': z.object({ pending: z.number() }),
            '2.0.0': z.object({ pending: z.number() }),
            '3.0.0': z.object({ pending: z.number() }),
          },
        } as unknown as CatalogLike,
      };

      let context: LegacyDomainEventContext | undefined;
      const handler = jest.fn();

      Object.assign(mutableCatalog, aheadCatalog);

      subscribeDomainEvent('rolling-example' as RegisteredEventName, handler, {
        target: window,
        onLegacy: (_payload, received) => {
          context = received;
        },
      });

      window.dispatchEvent(
        new CustomEvent('rolling-example', {
          detail: {
            name: 'rolling-example',
            version: '3.0.0',
            id: 'evt-fixed',
            timestamp: '2026-02-11T09:00:00.000Z',
            source: 'new-tab',
            payload: { pending: 1 },
          },
        }),
      );

      expect(handler).not.toHaveBeenCalled();
      expect(context).toEqual(
        expect.objectContaining({ receivedVersion: '3.0.0', currentVersion: '2.0.0', isFuture: true }),
      );
    });

    it('dispatches a current version straight to the handler, not to onLegacy', () => {
      const handler = jest.fn();
      const onLegacy = jest.fn();

      withSyntheticEvent(() => {
        subscribeDomainEvent('rolling-example' as RegisteredEventName, handler, {
          target: window,
          onLegacy,
        });

        window.dispatchEvent(
          new CustomEvent('rolling-example', {
            detail: {
              name: 'rolling-example',
              version: '2.0.0',
              id: 'evt-fixed',
              timestamp: '2026-02-11T09:00:00.000Z',
              source: 'new-tab',
              payload: { pending: 1 },
            },
          }),
        );
      });

      expect(onLegacy).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith({ pending: 1 }, expect.anything());
    });
  });

  describe('Cross-tab broadcast consumer', () => {
    /** Minimal stand-in for a BroadcastChannel; jsdom does not ship one. */
    function fakeChannel() {
      const listeners = new Set<(event: MessageEvent) => void>();

      return {
        posted: [] as unknown[],
        addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
          listeners.add(listener);
        },
        removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
          listeners.delete(listener);
        },
        postMessage(data: unknown) {
          this.posted.push(data);
        },
        emit(data: unknown) {
          listeners.forEach((listener) => listener({ data } as MessageEvent));
        },
      } as unknown as BroadcastChannel & { emit(data: unknown): void; posted: unknown[] };
    }

    it('delivers a broadcast event to the typed handler', () => {
      const channel = fakeChannel();
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainChannel('NETWORK_CHANGED', channel, handler, { fallback });

      const { delivery } = recordingDelivery();
      const envelope = publishDomainEvent('NETWORK_CHANGED', { network: 'testnet' }, {
        ...DETERMINISTIC,
        delivery,
        source: 'tab-a',
      });

      channel.emit(envelope);

      expect(fallback).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith({ network: 'testnet' }, expect.anything());
    });

    it('rejects an envelope whose name disagrees with the transport it arrived on', () => {
      const channel = fakeChannel();
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainChannel('NETWORK_CHANGED', channel, handler, { fallback });

      channel.emit({
        name: 'THEME_MUTATED',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'tab-a',
        payload: { mode: 'dark' },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'invalid-envelope' }),
      );
    });

    it('routes a drifted cross-tab payload to the fallback instead of the handler', () => {
      const channel = fakeChannel();
      const handler = jest.fn();
      const fallback = jest.fn();

      subscribeDomainChannel('NETWORK_CHANGED', channel, handler, { fallback });

      channel.emit({
        name: 'NETWORK_CHANGED',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'tab-a',
              payload: { pending: 1 },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'NETWORK_CHANGED', reason: 'invalid-payload' }),
      );
    });

    it('is a no-op subscription when the channel is unavailable', () => {
      const handler = jest.fn();
      const unsubscribe = subscribeDomainChannel('NETWORK_CHANGED', null, handler);

      expect(() => unsubscribe()).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('detaches from the channel on unsubscribe', () => {
      const channel = fakeChannel();
      const handler = jest.fn();
      const unsubscribe = subscribeDomainChannel('NETWORK_CHANGED', channel, handler);

      const { delivery } = recordingDelivery();
      const publish = () =>
        publishDomainEvent('NETWORK_CHANGED', { network: 'mainnet' }, {
          ...DETERMINISTIC,
          delivery,
          source: 'tab-a',
        });

      channel.emit(publish());
      unsubscribe();
      channel.emit(publish());

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('broadcasts the validated envelope, not the raw candidate', () => {
      const channel = fakeChannel();

      const { delivery } = recordingDelivery();
      publishDomainEvent('THEME_MUTATED', { mode: 'dark' }, {
        ...DETERMINISTIC,
        delivery: createBroadcastDelivery(channel),
        source: 'tab-a',
      });

      expect(channel.posted).toEqual([
        {
          name: 'THEME_MUTATED',
          version: '1.0.0',
          id: 'evt-fixed',
          timestamp: '2026-02-11T09:00:00.000Z',
          source: 'tab-a',
          payload: { mode: 'dark' },
        },
      ]);
    });

    it('tolerates a null channel as a no-op delivery', () => {
      const { delivery } = recordingDelivery();

      expect(() =>
        createBroadcastDelivery(null).dispatch({
          name: 'THEME_MUTATED',
          version: '1.0.0',
          id: 'evt-fixed',
          timestamp: '2026-02-11T09:00:00.000Z',
          source: 'tab-a',
          payload: { mode: 'dark' },
        }),
      ).not.toThrow();
      expect(delivery.transport).toBe('window');
    });
  });

  describe('Window delivery', () => {
    /**
     * Remove `window` for one call so the SSR guard can be observed. Restored in
     * a `finally` because a throw mid-test would otherwise poison every later
     * test in the file.
     */
    function withoutDom<T>(run: () => T): T {
      const globals = globalThis as { window?: unknown };
      const hadWindow = 'window' in globals;
      const original = globals.window;

      delete globals.window;

      try {
        return run();
      } finally {
        if (hadWindow) {
          globals.window = original;
        }
      }
    }

    it('falls back to the ambient window when no target is passed', () => {
      expect(createWindowDelivery().transport).toBe('window');
    });

    it('throws rather than silently dropping an event during a server render', () => {
      withoutDom(() => {
        expect(() => createWindowDelivery()).toThrow(/browser-only/i);
      });
    });

    it('returns an inert subscription during a server render', () => {
      withoutDom(() => {
        const handler = jest.fn();
        const unsubscribe = subscribeDomainEvent('connection-change', handler);

        expect(() => unsubscribe()).not.toThrow();
        expect(handler).not.toHaveBeenCalled();
      });
    });

    it('uses the registry key as the CustomEvent name', () => {
      const seen: string[] = [];
      const listener = (event: Event) => seen.push(event.type);
      window.addEventListener('offline-queue-change', listener);

      createWindowDelivery().dispatch({
        name: 'offline-queue-change',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'pwa-utils',
        payload: { pending: 1 },
      });

      window.removeEventListener('offline-queue-change', listener);
      expect(seen).toEqual(['offline-queue-change']);
    });

    it('prefers an explicit target over the ambient window', () => {
      const other = new EventTarget();
      const seen: string[] = [];
      const listener = (event: Event) => seen.push(event.type);
      other.addEventListener('sw-update', listener);

      createWindowDelivery(other).dispatch({
        name: 'sw-update',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'pwa-utils',
        payload: { available: true },
      });

      other.removeEventListener('sw-update', listener);
      expect(seen).toEqual(['sw-update']);
    });
  });

  describe('Correlation id generation', () => {
    it('uses crypto.randomUUID when the platform provides it', () => {
      const cryptoRef = globalThis.crypto as Crypto | undefined;

      if (!cryptoRef || typeof cryptoRef.randomUUID !== 'function') {
        // Nothing to assert on this platform; the fallback test below still runs.
        return;
      }

      const { delivery } = recordingDelivery();
      const envelope = publishDomainEvent('connection-change', { online: true }, {
        delivery,
        source: 'pwa-utils',
      });

      expect(envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('falls back to a timestamp+counter id when randomUUID is unavailable', () => {
      const globals = globalThis as { crypto?: unknown };
      const original = globals.crypto;

      globals.crypto = {};

      try {
        const { delivery } = recordingDelivery();
        const first = publishDomainEvent('connection-change', { online: true }, { delivery, source: 'pwa-utils' });
        const second = publishDomainEvent('connection-change', { online: true }, { delivery, source: 'pwa-utils' });

        expect(first.id).toMatch(/^evt-/);
        expect(first.id).not.toBe(second.id);
      } finally {
        globals.crypto = original;
      }
    });
  });

  describe('Network vocabulary alignment', () => {
    /**
     * `NETWORK_CHANGED` originally registered `public | testnet | sandbox |
     * futurenet` while the app models mainnet as `mainnet` and has no `sandbox`
     * network, so publishing with real app data threw. These cases pin the two
     * vocabularies together.
     */
    const STELLAR_NETWORK_IDS = ['mainnet', 'testnet', 'futurenet'] as const;

    function envelope(version: string, network: string): unknown {
      return {
        name: 'NETWORK_CHANGED',
        version,
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'tab-a',
        payload: { network },
      };
    }

    it('publishes NETWORK_CHANGED at 2.0.0, since the accepted values changed', () => {
      const definition = getDomainEventDefinition('NETWORK_CHANGED');

      expect(definition?.currentVersion).toBe('2.0.0');
    });

    it.each(STELLAR_NETWORK_IDS)('accepts "%s", every network the app can produce', (network) => {
      const result = parseDomainEvent(envelope('2.0.0', network));

      expect(result.status).toBe('accepted');
      if (result.status === 'accepted') {
        expect(result.isLegacy).toBe(false);
      }
    });

    it.each(['public', 'sandbox', 'mainnet ', 'MAINNET'])(
      'rejects "%s", which the app never produces',
      (network) => {
        const result = parseDomainEvent(envelope('2.0.0', network));

        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toBe('invalid-payload');
        }
      },
    );

    it('accepts a payload the producer actually types, with no cast', () => {
      // The whole point of the fix: this compiles without `as unknown as`.
      const { delivery } = recordingDelivery();

      const result = publishDomainEvent('NETWORK_CHANGED', { network: 'mainnet' }, {
        ...DETERMINISTIC,
        delivery,
        source: 'tab-a',
      });

      expect(result.payload).toEqual({ network: 'mainnet' });
      expect(result.version).toBe('2.0.0');
    });

    it('keeps 1.0.0 readable so a tab on the old catalog still interoperates', () => {
      const result = parseDomainEvent(envelope('1.0.0', 'public'));

      expect(result.status).toBe('accepted');
      if (result.status === 'accepted') {
        expect(result.isLegacy).toBe(true);
        expect(result.version).toBe('1.0.0');
      }
    });

    it('refuses mainnet on 1.0.0, which is why the bump is major', () => {
      const result = parseDomainEvent(envelope('1.0.0', 'mainnet'));

      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBe('invalid-payload');
      }
    });

    it('routes a 1.0.0 event to onLegacy rather than the typed handler', () => {
      const handler = jest.fn();
      const onLegacy = jest.fn();
      const fallback = jest.fn();

      subscribeDomainEvent('NETWORK_CHANGED', handler, { target: window, onLegacy, fallback });

      window.dispatchEvent(new CustomEvent('NETWORK_CHANGED', { detail: envelope('1.0.0', 'public') }));

      expect(handler).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
      expect(onLegacy).toHaveBeenCalledWith(
        { network: 'public' },
        expect.objectContaining({ receivedVersion: '1.0.0', currentVersion: '2.0.0', isFuture: false }),
      );
    });

    it('agrees with the StellarNetwork type exported by lib/types', () => {
      // Guards the wiring: the schema and the app's type must not drift again.
      const appNetworks: StellarNetwork[] = ['mainnet', 'testnet', 'futurenet'];

      for (const network of appNetworks) {
        expect(parseDomainEvent(envelope('2.0.0', network)).status).toBe('accepted');
      }
    });
  });

  describe('Semver comparison', () => {
    it.each([
      ['1.0.0', '1.0.0', 0],
      ['1.0.1', '1.0.0', 1],
      ['1.0.0', '1.0.1', -1],
      ['1.1.0', '1.0.9', 1],
      ['2.0.0', '1.99.99', 1],
      ['1.10.0', '1.9.0', 1],
    ])('compares %s to %s as %s', (left, right, expected) => {
      expect(compareSemver(left, right)).toBe(expected);
    });
  });

  describe('Schema composition and lookup', () => {
    it('resolves a registered version to a schema', () => {
      expect(getDomainEventSchema('offline-queue-change', '1.0.0')).toBeDefined();
    });

    it('returns undefined for an unregistered version', () => {
      expect(getDomainEventSchema('offline-queue-change', '9.9.9')).toBeUndefined();
    });

    it('returns undefined for an unregistered event', () => {
      expect(getDomainEventDefinition('nope')).toBeUndefined();
      expect(getDomainEventSchema('nope', '1.0.0')).toBeUndefined();
    });

    it('pins the name and version when composing a parse schema', () => {
      const definition = getDomainEventDefinition('offline-queue-change') as AnyDomainEventDefinition;
      const schema = composeParseSchema(definition, '1.0.0');

      expect(schema.safeParse({
        name: 'connection-change',
        version: '1.0.0',
        id: 'evt-fixed',
        timestamp: '2026-02-11T09:00:00.000Z',
        source: 'pwa-utils',
        payload: { pending: 1 },
      }).success).toBe(false);
    });

    it('throws a useful error when asked to compose an unregistered version', () => {
      const definition = getDomainEventDefinition('offline-queue-change') as AnyDomainEventDefinition;

      expect(() => composeParseSchema(definition, '4.0.0')).toThrow(/no schema registered/i);
    });
  });

  describe('parseDomainEvent is total', () => {
    it.each([[null], [undefined], [42], ['a string'], [[1, 2, 3]]])(
      'never throws for %s',
      (raw) => {
        expect(() => parseDomainEvent(raw)).not.toThrow();
        expect(parseDomainEvent(raw).status).toBe('rejected');
      },
    );

    it('reports unknown-event when neither the envelope nor the transport names the event', () => {
      const result = parseDomainEvent({ version: '1.0.0' });

      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBe('unknown-event');
      }
    });
  });
});

describe('consumer retry and dead letter queue', () => {
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  const NAME = 'THEME_MUTATED' as RegisteredEventName;

  function setup(handler: jest.Mock, extra: Record<string, unknown> = {}) {
    const target = new EventTarget();
    const dlq = new DeadLetterQueue(null);
    const timers: Array<{ run: () => void; delay: number }> = [];
    const unsubscribe = subscribeDomainEvent(NAME, handler, {
      target,
      deadLetterQueue: dlq,
      scheduler: (run, delay) => timers.push({ run, delay }),
      ...extra,
    });
    const validEvent = () => {
      const def = getDomainEventDefinition(NAME) as AnyDomainEventDefinition;
      return def;
    };
    return { target, dlq, timers, unsubscribe, validEvent };
  }

  function dispatchFixture(target: EventTarget, name: RegisteredEventName) {
    publishDomainEvent(name, { mode: 'dark' } as never, {
      delivery: createWindowDelivery(target),
      source: 'dlq-test',
    });
  }

  it('computes 2s, 4s, 8s backoff', () => {
    expect([1, 2, 3].map((n) => computeBackoffMs(n))).toEqual([2000, 4000, 8000]);
  });

  it('retries with exponential backoff then captures in the DLQ', async () => {
    const handler = jest.fn(() => {
      throw new Error('service down');
    });
    const { target, dlq, timers } = setup(handler);
    dispatchFixture(target, NAME);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(timers.map((t) => t.delay)).toEqual([2000]);

    for (const expected of [4000, 8000]) {
      await Promise.resolve();
      timers[timers.length - 1].run();
      await flush();
      expect(timers[timers.length - 1].delay).toBe(expected);
    }
    timers[timers.length - 1].run();
    await flush();

    expect(handler).toHaveBeenCalledTimes(4);
    expect(timers.map((t) => t.delay)).toEqual([2000, 4000, 8000]);
    const [entry] = dlq.list();
    expect(dlq.list()).toHaveLength(1);
    expect(entry.error).toBe('service down');
    expect(entry.attempts).toBe(4);
    expect(entry.eventName).toBe(NAME);
  });

  it('does not touch the DLQ when a retry succeeds', async () => {
    const handler = jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);
    const { target, dlq, timers } = setup(handler);
    dispatchFixture(target, NAME);
    await flush();
    timers[0].run();
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(dlq.list()).toHaveLength(0);
  });

  it('honours a custom retry policy', async () => {
    const handler = jest.fn(() => {
      throw new Error('x');
    });
    const { target, dlq, timers } = setup(handler, { retry: { maxRetries: 0 } });
    dispatchFixture(target, NAME);
    await flush();

    expect(timers).toHaveLength(0);
    expect(dlq.list()).toHaveLength(1);
  });

  it('replays a DLQ entry through the live subscriber and removes it', async () => {
    const handler = jest.fn(() => {
      throw new Error('x');
    });
    const { target, dlq } = setup(handler, { retry: { maxRetries: 0 } });
    dispatchFixture(target, NAME);
    await flush();
    const [entry] = dlq.list();

    handler.mockImplementation(() => undefined);
    const result = await dlq.replay(entry.id);

    expect(result.ok).toBe(true);
    expect(dlq.list()).toHaveLength(0);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('keeps the entry when replay has no subscriber', async () => {
    const dlq = new DeadLetterQueue(null);
    const entry = dlq.capture({
      subscriber: 'gone',
      eventName: NAME,
      version: '1.0.0',
      envelope: {},
      error: 'x',
      attempts: 4,
    });
    const result = await dlq.replay(entry.id);

    expect(result.ok).toBe(false);
    expect(dlq.list()).toHaveLength(1);
  });
});
