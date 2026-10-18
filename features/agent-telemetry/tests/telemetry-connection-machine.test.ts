import {
  createTelemetryConnectionMachine,
  initialTelemetryConnectionState,
  reduceTelemetryConnection,
  toLegacyTelemetryStatus,
  type TelemetryConnectionState,
} from '../services/telemetry-connection-machine';

function start(now = 1): TelemetryConnectionState {
  return reduceTelemetryConnection(initialTelemetryConnectionState(), { type: 'start', now });
}

describe('telemetry connection machine', () => {
  it('starts idle and moves to connecting with an attempt counted', () => {
    expect(initialTelemetryConnectionState(0).status).toBe('idle');
    const state = start();
    expect(state.status).toBe('connecting');
    expect(state.attempts).toBe(1);
    expect(state.transport).toBeNull();
  });

  it('follows the WebRTC happy path: connecting -> negotiating -> open', () => {
    let state = start();
    state = reduceTelemetryConnection(state, { type: 'negotiate', now: 2 });
    expect(state.status).toBe('negotiating');
    state = reduceTelemetryConnection(state, { type: 'webrtc-open', now: 3 });
    expect(state.status).toBe('open');
    expect(state.transport).toBe('webrtc');
    expect(state.fallbacks).toBe(0);
    expect(state.fallbackReason).toBeNull();
  });

  it('records the fallback reason and counter when ICE fails', () => {
    let state = start();
    state = reduceTelemetryConnection(state, { type: 'negotiate', now: 2 });
    state = reduceTelemetryConnection(state, { type: 'fallback', reason: 'ice-failed', now: 3 });
    expect(state.status).toBe('connecting');
    expect(state.transport).toBeNull();
    expect(state.fallbackReason).toBe('ice-failed');
    expect(state.fallbacks).toBe(1);

    state = reduceTelemetryConnection(state, { type: 'websocket-open', now: 4 });
    expect(state.status).toBe('open');
    expect(state.transport).toBe('websocket');
    expect(state.fallbackReason).toBe('ice-failed');
  });

  it('falls back immediately when WebRTC is unsupported', () => {
    let state = start();
    state = reduceTelemetryConnection(state, {
      type: 'fallback',
      reason: 'webrtc-unsupported',
      now: 2,
    });
    state = reduceTelemetryConnection(state, { type: 'websocket-open', now: 3 });
    expect(state.transport).toBe('websocket');
    expect(state.fallbacks).toBe(1);
    expect(state.fallbackReason).toBe('webrtc-unsupported');
  });

  it('counts reconnects as attempts and clears the previous error', () => {
    let state = reduceTelemetryConnection(start(), { type: 'websocket-open', now: 2 });
    state = reduceTelemetryConnection(state, { type: 'error', message: 'socket error', now: 3 });
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('socket error');

    state = reduceTelemetryConnection(state, { type: 'reconnect', now: 4 });
    expect(state.status).toBe('reconnecting');
    expect(state.attempts).toBe(2);
    expect(state.lastError).toBeNull();
  });

  it('ignores late events after close so a torn-down transport cannot revive', () => {
    let state = reduceTelemetryConnection(start(), { type: 'websocket-open', now: 2 });
    state = reduceTelemetryConnection(state, { type: 'close', now: 3 });
    expect(state.status).toBe('closed');
    expect(state.transport).toBeNull();

    expect(reduceTelemetryConnection(state, { type: 'webrtc-open', now: 4 }).status).toBe('closed');
    expect(
      reduceTelemetryConnection(state, { type: 'error', message: 'late', now: 5 }).status
    ).toBe('closed');
    expect(
      reduceTelemetryConnection(state, { type: 'fallback', reason: 'no-peer', now: 6 }).fallbacks
    ).toBe(0);
  });

  it('maps machine states onto the dashboard status union', () => {
    let state = start();
    expect(toLegacyTelemetryStatus(state)).toBe('connecting');
    state = reduceTelemetryConnection(state, { type: 'negotiate', now: 2 });
    expect(toLegacyTelemetryStatus(state)).toBe('connecting');
    state = reduceTelemetryConnection(state, { type: 'webrtc-open', now: 3 });
    expect(toLegacyTelemetryStatus(state)).toBe('open');
    state = reduceTelemetryConnection(state, { type: 'reconnect', now: 4 });
    expect(toLegacyTelemetryStatus(state)).toBe('connecting');
    state = reduceTelemetryConnection(state, { type: 'close', now: 5 });
    expect(toLegacyTelemetryStatus(state)).toBe('closed');
  });

  it('notifies subscribers until they unsubscribe', () => {
    const machine = createTelemetryConnectionMachine();
    const seen: string[] = [];
    const unsubscribe = machine.subscribe((state) => seen.push(state.status));

    machine.send({ type: 'start', now: 1 });
    machine.send({ type: 'negotiate', now: 2 });
    unsubscribe();
    machine.send({ type: 'webrtc-open', now: 3 });

    expect(seen).toEqual(['connecting', 'negotiating']);
    expect(machine.getState().transport).toBe('webrtc');
  });
});
