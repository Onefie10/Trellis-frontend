import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_ALERT_RULES,
  type AlertRule,
  type ExceptionEvent,
} from '@/lib/operational-health';
import {
  subscribeIdempotencyTelemetry,
  type IdempotencyTelemetryCounters,
  type IdempotencyTelemetryEvent,
} from '@/lib/idempotency';
import {
  subscribeAbuseTelemetry,
  type AbuseTelemetryEvent,
} from '@/lib/protocol/abuse-detection';
import { recordMetricPoint } from '@/lib/metric-definitions';
import { createPersistStorage } from './persistence';

/** Bound the in-memory exception buffer so a long session cannot grow unbounded. */
const MAX_EXCEPTION_EVENTS = 500;
/** Bound the idempotency event buffer the same way. */
const MAX_IDEMPOTENCY_EVENTS = 500;
/** Bound the abuse detection event buffer. */
const MAX_ABUSE_EVENTS = 500;

export interface AbuseTelemetryCounters {
  totalEvaluations: number;
  lowRiskAllowed: number;
  stepUpChallenges: number;
  quarantinedReviews: number;
  criticalBlocks: number;
}

interface ApiMetricsState {
  totalRequests: number;
  cacheHits: number;
  networkRequests: number;
  batchedRequests: number;
  lastRequestAt: string | null;
  exceptionEvents: ExceptionEvent[];
  alertRules: AlertRule[];
  /** Running idempotency counters (see `lib/idempotency.ts`). */
  idempotency: IdempotencyTelemetryCounters;
  /** Recent idempotency events, oldest first, for the hit-rate chart. */
  idempotencyEvents: IdempotencyTelemetryEvent[];
  /** Abuse detection telemetry counters */
  abuse: AbuseTelemetryCounters;
  /** Recent abuse detection events */
  abuseEvents: AbuseTelemetryEvent[];
  hasHydrated: boolean;
}

interface ApiMetricsActions {
  recordRequest: (payload: {
    cacheHit: boolean;
    networkRequest: boolean;
    batched: boolean;
  }) => void;
  /** Appends one or more sanitized exceptions, keeping the newest 500. */
  recordException: (event: ExceptionEvent | ExceptionEvent[]) => void;
  /** Replaces the buffer, e.g. after hydrating from `/api/operational-health`. */
  setExceptionEvents: (events: ExceptionEvent[]) => void;
  clearExceptions: () => void;
  /** Upserts a maintainer alert rule by id. */
  addAlertRule: (rule: AlertRule) => void;
  removeAlertRule: (ruleId: string) => void;
  setAlertRules: (rules: AlertRule[]) => void;
  /** Counts one idempotency outcome and keeps the newest 500 events. */
  recordIdempotencyEvent: (event: IdempotencyTelemetryEvent) => void;
  clearIdempotencyTelemetry: () => void;
  /** Counts one abuse detection outcome and keeps the newest 500 events. */
  recordAbuseEvent: (event: AbuseTelemetryEvent) => void;
  clearAbuseTelemetry: () => void;
  setHydrated: (hydrated: boolean) => void;
}

export type ApiMetricsStore = ApiMetricsState & ApiMetricsActions;

const emptyIdempotencyCounters = (): IdempotencyTelemetryCounters => ({
  idempotency_requests: 0,
  idempotency_hits: 0,
  idempotency_collisions: 0,
  idempotency_retries: 0,
  idempotency_expired: 0,
});

const emptyAbuseCounters = (): AbuseTelemetryCounters => ({
  totalEvaluations: 0,
  lowRiskAllowed: 0,
  stepUpChallenges: 0,
  quarantinedReviews: 0,
  criticalBlocks: 0,
});

const COUNTER_FOR_KIND: Partial<Record<IdempotencyTelemetryEvent['kind'], keyof IdempotencyTelemetryCounters>> = {
  hit: 'idempotency_hits',
  collision: 'idempotency_collisions',
  retry: 'idempotency_retries',
  expired: 'idempotency_expired',
};

const initialApiMetricsState: ApiMetricsState = {
  totalRequests: 0,
  cacheHits: 0,
  networkRequests: 0,
  batchedRequests: 0,
  lastRequestAt: null,
  exceptionEvents: [],
  alertRules: [...DEFAULT_ALERT_RULES],
  idempotency: emptyIdempotencyCounters(),
  idempotencyEvents: [],
  abuse: emptyAbuseCounters(),
  abuseEvents: [],
  hasHydrated: false,
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const useApiMetricsStore = create<ApiMetricsStore>()(
  persist(
    (set) => ({
      ...initialApiMetricsState,
      recordRequest: ({ cacheHit, networkRequest, batched }) =>
        set((state) => ({
          totalRequests: state.totalRequests + 1,
          cacheHits: state.cacheHits + (cacheHit ? 1 : 0),
          networkRequests: state.networkRequests + (networkRequest ? 1 : 0),
          batchedRequests: state.batchedRequests + (batched ? 1 : 0),
          lastRequestAt: new Date().toISOString(),
        })),
      recordException: (event) =>
        set((state) => {
          const incoming = Array.isArray(event) ? event : [event];
          const merged = [...state.exceptionEvents, ...incoming]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_EXCEPTION_EVENTS);
          return { exceptionEvents: merged };
        }),
      setExceptionEvents: (events) =>
        set({ exceptionEvents: [...events].sort((a, b) => a.ts - b.ts).slice(-MAX_EXCEPTION_EVENTS) }),
      clearExceptions: () => set({ exceptionEvents: [] }),
      addAlertRule: (rule) =>
        set((state) => ({
          alertRules: state.alertRules.some((existing) => existing.id === rule.id)
            ? state.alertRules.map((existing) => (existing.id === rule.id ? rule : existing))
            : [...state.alertRules, rule],
        })),
      removeAlertRule: (ruleId) =>
        set((state) => ({ alertRules: state.alertRules.filter((rule) => rule.id !== ruleId) })),
      setAlertRules: (rules) => set({ alertRules: [...rules] }),
      recordIdempotencyEvent: (event) =>
        set((state) => {
          const counter = COUNTER_FOR_KIND[event.kind];
          const idempotency = {
            ...state.idempotency,
            idempotency_requests: state.idempotency.idempotency_requests + 1,
          };
          if (counter) idempotency[counter] += 1;
          return {
            idempotency,
            idempotencyEvents: [...state.idempotencyEvents, event].slice(-MAX_IDEMPOTENCY_EVENTS),
          };
        }),
      clearIdempotencyTelemetry: () =>
        set({ idempotency: emptyIdempotencyCounters(), idempotencyEvents: [] }),
      recordAbuseEvent: (event) =>
        set((state) => {
          const abuse = {
            ...state.abuse,
            totalEvaluations: state.abuse.totalEvaluations + 1,
            lowRiskAllowed: state.abuse.lowRiskAllowed + (event.action === 'allow' ? 1 : 0),
            stepUpChallenges: state.abuse.stepUpChallenges + (event.action === 'step_up' ? 1 : 0),
            quarantinedReviews: state.abuse.quarantinedReviews + (event.action === 'review' ? 1 : 0),
            criticalBlocks: state.abuse.criticalBlocks + (event.action === 'block' ? 1 : 0),
          };
          return {
            abuse,
            abuseEvents: [...state.abuseEvents, event].slice(-MAX_ABUSE_EVENTS),
          };
        }),
      clearAbuseTelemetry: () =>
        set({ abuse: emptyAbuseCounters(), abuseEvents: [] }),
      setHydrated: (hydrated) => set({ hasHydrated: hydrated }),
    }),
    {
      name: 'trellis-api-metrics-store',
      version: 2,
      storage: createPersistStorage(),
      partialize: (state) => ({
        totalRequests: state.totalRequests,
        cacheHits: state.cacheHits,
        networkRequests: state.networkRequests,
        batchedRequests: state.batchedRequests,
        lastRequestAt: state.lastRequestAt,
        idempotency: state.idempotency,
        idempotencyEvents: state.idempotencyEvents,
        abuse: state.abuse,
        abuseEvents: state.abuseEvents,
      }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return initialApiMetricsState;
        }

        // v1 had no idempotency fields; every field is validated, so the same
        // path upgrades v1 and repairs a corrupt v2 payload.
        const state = persistedState as Partial<ApiMetricsState>;
        const counters = state.idempotency ?? ({} as Partial<IdempotencyTelemetryCounters>);
        const idempotency = emptyIdempotencyCounters();
        for (const key of Object.keys(idempotency) as Array<keyof IdempotencyTelemetryCounters>) {
          if (isCount(counters[key])) idempotency[key] = counters[key] as number;
        }

        const abuseCounters = state.abuse ?? ({} as Partial<AbuseTelemetryCounters>);
        const abuse = emptyAbuseCounters();
        for (const key of Object.keys(abuse) as Array<keyof AbuseTelemetryCounters>) {
          if (isCount(abuseCounters[key])) abuse[key] = abuseCounters[key] as number;
        }

        return {
          ...initialApiMetricsState,
          totalRequests: isCount(state.totalRequests) ? state.totalRequests : 0,
          cacheHits: isCount(state.cacheHits) ? state.cacheHits : 0,
          networkRequests: isCount(state.networkRequests) ? state.networkRequests : 0,
          batchedRequests: isCount(state.batchedRequests) ? state.batchedRequests : 0,
          lastRequestAt: typeof state.lastRequestAt === 'string' ? state.lastRequestAt : null,
          idempotency,
          idempotencyEvents: Array.isArray(state.idempotencyEvents)
            ? state.idempotencyEvents
                .filter((event) => event && typeof event.ts === 'number' && typeof event.kind === 'string')
                .slice(-MAX_IDEMPOTENCY_EVENTS)
            : [],
          abuse,
          abuseEvents: Array.isArray(state.abuseEvents)
            ? state.abuseEvents
                .filter((event) => event && typeof event.timestamp === 'number' && typeof event.action === 'string')
                .slice(-MAX_ABUSE_EVENTS)
            : [],
        };
      },
      onRehydrateStorage: () => () => {
        useApiMetricsStore.setState({ hasHydrated: true });
      },
    },
  ),
);

/**
 * Bridges idempotency telemetry into the metrics store (dashboard) and the
 * OTLP exporter. Only the operation scope and outcome leave the module — never
 * the key or payload.
 */
subscribeIdempotencyTelemetry((event) => {
  useApiMetricsStore.getState().recordIdempotencyEvent(event);
  recordMetricPoint({
    name: 'idempotency.requests',
    kind: 'counter',
    value: 1,
    timestamp: event.ts,
    attributes: { scope: event.scope, outcome: event.kind },
  });
  const metricName =
    event.kind === 'hit'
      ? 'idempotency.hits'
      : event.kind === 'collision'
      ? 'idempotency.collisions'
      : event.kind === 'retry'
      ? 'idempotency.retries'
      : event.kind === 'expired'
      ? 'idempotency.expired'
      : null;
  if (metricName) {
    recordMetricPoint({
      name: metricName,
      kind: 'counter',
      value: 1,
      timestamp: event.ts,
      attributes: { scope: event.scope, reason: event.reason },
    });
  }
});

/**
 * Bridges abuse detection telemetry into the metrics store and telemetry exporter.
 */
subscribeAbuseTelemetry((event) => {
  useApiMetricsStore.getState().recordAbuseEvent(event);
  recordMetricPoint({
    name: 'abuse.evaluations',
    kind: 'counter',
    value: 1,
    timestamp: event.timestamp,
    attributes: {
      operation: event.operation,
      action: event.action,
      riskScore: event.riskScore,
    },
  });
  if (event.action !== 'allow') {
    recordMetricPoint({
      name: `abuse.${event.action}`,
      kind: 'counter',
      value: 1,
      timestamp: event.timestamp,
      attributes: {
        operation: event.operation,
        riskScore: event.riskScore,
        primarySignal: event.signals[0]?.code ?? 'unknown',
      },
    });
  }
});
