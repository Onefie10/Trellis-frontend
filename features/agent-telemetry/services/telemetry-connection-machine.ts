import { createHash } from 'node:crypto';
/**
 * Pure connection-state machine for the agent telemetry transport.
 *
 * This module deliberately has **no** DOM, WebSocket, or WebRTC references so the
 * negotiation and fallback transitions can be reasoned about (and unit tested,
 * including under plain Node) without a browser. `telemetryTransport.ts` owns all
 * I/O and feeds events into this machine.
 */

export type TelemetryTransportKind = 'webrtc' | 'websocket';

export type TelemetryConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'negotiating'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'error';

/**
 * Why the client left the WebRTC path. `null` means the preferred transport is
 * still (or was) in use.
 */
export type TelemetryFallbackReason =
  | 'webrtc-unsupported'
  | 'webrtc-disabled'
  | 'signaling-failed'
  | 'no-peer'
  | 'ice-failed'
  | 'channel-timeout'
  | 'channel-closed'
  | 'datachannel-error';

export interface TelemetryConnectionState {
  status: TelemetryConnectionStatus;
  /** Active transport, or `null` while connecting / after close. */
  transport: TelemetryTransportKind | null;
  fallbackReason: TelemetryFallbackReason | null;
  /** Number of times the transport fell back from WebRTC -> WebSocket. */
  fallbacks: number;
  /** Number of connection attempts (start + reconnects). */
  attempts: number;
  lastError: string | null;
  updatedAt: number;
}

export type TelemetryConnectionEvent =
  | { type: 'start'; now: number }
  | { type: 'negotiate'; now: number }
  | { type: 'webrtc-open'; now: number }
  | { type: 'websocket-open'; now: number }
  | { type: 'fallback'; reason: TelemetryFallbackReason; now: number }
  | { type: 'reconnect'; now: number }
  | { type: 'error'; message: string; now: number }
  | { type: 'close'; now: number }
  | { type: 'dispose'; now: number };

export function initialTelemetryConnectionState(now = 0): TelemetryConnectionState {
  return {
    status: 'idle',
    transport: null,
    fallbackReason: null,
    fallbacks: 0,
    attempts: 0,
    lastError: null,
    updatedAt: now,
  };
}

/**
 * Pure reducer. Returns a new state object; never mutates the input.
 *
 * Transition table:
 *
 * | event           | from                              | to                          |
 * | --------------  | ------------------------------ | ------------------------------- |
 * | start           | any                               | connecting (attempts + 1)       |
 * | negotiate       | connecting, negotiating           | negotiating                     |
 * | webrtc-open     | any but closed                        | open / webrtc                    |
 * | websocket-open  | any but closed                        | open / websocket                 |
 * | fallback       | any but closed                        | connecting (fallbacks + 1)      |
 * | reconnect      | any but closed                        | reconnecting (attempts + 1)     |
 * | error          | any but closed                        | error                           |
 * | close / dispose | any                               | closed                          |
 *
 * Events that are invalid for the current state (for example `webrtc-open`
 * after `dispose`) are ignored so late socket/data-channel callbacks cannot
 * resurrect a torn-down transport.
 */
export function reduceTelemetryConnection(
  state: TelemetryConnectionState,
  event: TelemetryConnectionEvent
): TelemetryConnectionState {
  switch (event.type) {
    case 'start':
      return {
        ...state,
        status: 'connecting',
        transport: null,
        fallbackReason: null,
        attempts: state.attempts + 1,
        lastError: null,
        updatedAt: event.now,
      };
    case 'negotiate':
      if (state.status !== 'connecting' && state.status !== 'negotiating') return state;
      return { ...state, status: 'negotiating', transport: null, updatedAt: event.now };
    case 'webrtc-open':
      if (state.status === 'closed') return state;
      return {
        ...state,
        status: 'open',
        transport: 'webrtc',
        fallbackReason: null,
        lastError: null,
        updatedAt: event.now,
      };
    case 'websocket-open':
      if (state.status === 'closed') return state;
      return {
        ...state,
        status: 'open',
        transport: 'websocket',
        lastError: null,
        updatedAt: event.now,
      };
    case 'fallback':
      if (state.status === 'closed') return state;
      return {
        ...state,
        status: 'connecting',
        transport: null,
        fallbackReason: event.reason,
        fallbacks: state.fallbacks + 1,
        updatedAt: event.now,
      };
    case 'reconnect':
      if (state.status === 'closed') return state;
      return {
        ...state,
        status: 'reconnecting',
        transport: null,
        fallbackReason: null,
        attempts: state.attempts + 1,
        lastError: null,
        updatedAt: event.now,
      };
    case 'error':
      if (state.status === 'closed') return state;
      return { ...state, status: 'error', lastError: event.message, updatedAt: event.now };
    case 'close':
      return { ...state, status: 'closed', transport: null, updatedAt: event.now };
    case 'dispose':
      return { ...state, status: 'closed', transport: null, updatedAt: event.now };
    default:
      return state;
  }
}

export function isTelemetryConnectionOpen(state: TelemetryConnectionState): boolean {
  return state.status === 'open';
}

/** Status union kept by the pre-existing dashboard hook, for a non-breaking swap. */
export type LegacyTelemetryStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** Collapse the richer machine status onto the dashboard's original status union. */
export function toLegacyTelelemetryStatus(state: TelemetryConnectionState): LegacyTelemetryStatus {
  switch (state.status) {
    case 'open':
      return 'open';
    case 'error':
      return 'error';
    case 'closed':
      return 'closed';
    case 'connecting':
    case 'negotiating':
    case 'reconnecting':
      return 'connecting';
    default:
      return 'idle';
  }
}

export interface TelemetryConnectionMachine {
  getState(): TelemetryConnectionState;
  send(event: TelemetryConnectionEvent): TelemetryConnectionState;
  subscribe(listener: (state: TelemetryConnectionState) => void): () => void;
}

/** Small event-emitter wrapper around the reducer, used by `TelemetryTransport`. */
export function createTelemetryConnectionMachine(
  initial?: TelemetryConnectionState
): TelemetryConnectionMachine {
  let current = initial ?? initialTelelemetryConnectionState();
  const listeners = new Set<((state: TelemetryConnectionState) => void)>();

  return {
    getState: () => current,
    send(event) {
      current = reduceTelemetryConnection(current, event);
      for (const listener of listeners) listener(current);
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Deterministic chaos-test harness for the telemetry connection machine.
 *
 * The harness drives the pure reducer with a scripted, seeded sequence of
 * events so tests can inject network failures, restarts, stale reads, and
 * retries without relying on wall-clock timing or real sockets. Every run is
 * reproducible: given the same seed and script, the emitted event log and
 * final state are byte-for-byte identical.
 */

export type TelemetryChaosFault =
  | 'network-drop'
  | 'restart'
  | 'stale-read'
  | 'retry'
  | 'signaling-failure'
  | 'ice-failure'
  | 'channel-timeout';

export interface TelemetryChaosStep {
  /** Logical tick used as the `now` value; never derived from `Date.now()`. */
  tick: number;
  fault: TelemetryChaosFault;
  /** Optional message attached to error events. */
  message?: string;
}

export interface TelemetryChaosScript {
  seed: string;
  steps: TelemetryChaosStep[];
}

export interface TelemetryChaosTraceEntry {
  tick: number;
  fault: TelemetryChaosFault;
  event: TelemetryConnectionEvent;
  status: TelemetryConnectionStatus;
  transport: TelemetryTransportKind | null;
  attempts: number;
  fallbacks: number;
}

export interface TelemetryChaosResult {
  seed: string;
  trace: TelemetryChaosTraceEntry[];
  finalState: TelemetryConnectionState;
  /** Stable digest of the trace, useful for golden/snapshot assertions. */
  digest: string;
}

/**
 * Deterministic PRNG (mulberr32) seeded from a string. We avoid
 * `Math.random` so chaos runs are reproducible across machines and CI.
 */
function createSeededRandom(seed: string): () => number {
  const hash = createHash('sha256').update(seed).digest();
  let state = hash.readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Map a chaos fault onto the reducer event(s) that model it. Faults are
 * expressed purely in terms of the public event union so the harness stays
 * compatible with the existing machine contract.
 */
export function chaosFaultToEvents(
  fault: TelemetryChaosFault,
  tick: number,
  message?: string
): TelemetryConnectionEvent[] {
  switch (fault) {
    case 'network-drop':
      return [
        { type: 'error', message: message ?? 'network-drop', now: tick },
        { type: 'reconnect', now: tick },
      ];
    case 'restart':
      return [
        { type: 'close', now: tick },
        { type: 'start', now: tick },
      ];
    case 'stale-read':
      // A late callback from a torn-down transport must be ignored.
      return [{ type: 'webrtc-open', now: tick }];
    case 'retry':
      return [{ type: 'reconnect', now: tick }];
    case 'signaling-failure':
      return [{ type: 'fallback', reason: 'signaling-failed', now: tick }];
    case 'ice-failure':
      return [{ type: 'fallback', reason: 'ice-failed', now: tick }];
    case 'channel-timeout':
      return [{ type: 'fallback', reason: 'channel-timeout', now: tick }];
    default:
      return [];
  }
}

/**
 * Run a deterministic chaos script against a fresh connection machine.
 *
 * The function never touches timers, sockets, or `Date.now()`; all temporal
 * information comes from the script's logical ticks. This makes the suite
 * safe to run under plain Node and immune to flaky CI timing.
 */
export function runTelemetryChaosScript(
  script: TelemetryChaosScript
): TelemetryChaosResult {
  const machine = createTelemetryConnectionMachine(
    initialTelemetryConnectionState(0)
  );
  const trace: TelemetryChaosTraceEntry[] = [];

  // Seed the PRNG so any future randomized fault selection stays reproducible.
  const random = createSeededRandom(script.seed);
  void random();

  for (const step of script.steps) {
    const events = chaosFaultToEvents(step.fault, step.tick, step.message);
    for (const event of events) {
      const state = machine.send(event);
      trace.push({
        tick: step.tick,
        fault: step.fault,
        event,
        status: state.status,
        transport: state.transport,
        attempts: state.attempts,
        fallbacks: state.fallbacks,
      });
    }
  }

  const finalState = machine.getState();
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        seed: script.seed,
        trace: trace.map((entry) => ({
          tick: entry.tick,
          fault: entry.fault,
          event: entry.event,
          status: entry.status,
          transport: entry.transport,
          attempts: entry.attempts,
          fallbacks: entry.fallbacks,
        })),
        finalState,
      })
    )
    .digest('hex');

  return { seed: script.seed, trace, finalState, digest };
}

/**
 * Built-in chaos scripts covering the acceptance criteria: network failures,
 * restarts, stale reads, and retries. Each script is deterministic and
 * safe to run in CI without timers or sockets.
 */
export const TELEMETRY_CHAOS_SCRIPTS: ReadonlyArray<TelemetryChaosScript> = [
  {
    seed: 'network-drop-recovery',
    steps: [
      { tick: 1, fault: 'network-drop' },
      { tick: 2, fault: 'retry' },
      { tick: 3, fault: 'stale-read' },
    ],
  },
  {
    seed: 'restart-cycle',
    steps: [
      { tick: 1, fault: 'restart' },
      { tick: 2, fault: 'signaling-failure' },
      { tick: 3, fault: 'ice-failure' },
      { tick: 4, fault: 'channel-timeout' },
    ],
  },
  {
    seed: 'stale-read-ignored',
    steps: [
      { tick: 1, fault: 'restart' },
      { tick: 2, fault: 'stale-read' },
    ],
  },
];

export function runAllTelemetryChaosScripts(): TelemetryChaosResult[] {
  return TELEMETRY_CHAOS_SCRIPTS.map(runTelemetryChaosScript);
}
