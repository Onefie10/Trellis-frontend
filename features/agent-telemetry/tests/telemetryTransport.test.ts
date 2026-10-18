import {
  TelemetryTransport,
  buildTelemetryIceServers,
  parseTelemetryFrame,
  type TelemetryDataChannelLike,
  type TelemetryPeerConfig,
  type TelemetryPeerLike,
  type TelemetrySocketLike,
} from '../services/telemetryTransport';
import type { TelemetryConnectionState } from '../services/telemetry-connection-machine';

class FakeChannel implements TelemetryDataChannelLike {
  readyState = 'connecting';
  readonly sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 'closed';
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

class FakePeer implements TelemetryPeerLike {
  connectionState = 'new';
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: string; sdp?: string } | null = null;
  candidates: unknown[] = [];
  closed = false;
  init: { ordered?: boolean; maxRetransmits?: number } | undefined;
  readonly channel = new FakeChannel();
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: ((ev?: unknown) => void) | null = null;

  createDataChannel(_label: string, init?: { ordered?: boolean; maxRetransmits?: number }) {
    this.init = init;
    return this.channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0-fake' };
  }

  async setLocalDescription(description: { type: string; sdp?: string }) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: { type: string; sdp?: string }) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
  }

  close() {
    this.closed = true;
  }
}

class FakeSocket implements TelemetrySocketLike {
  readyState = 0;
  closed = false;
  readonly sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(payload: unknown) {
    this.onmessage?.({
      data: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface Harness {
  transport: TelemetryTransport;
  socket: FakeSocket;
  peer: FakePeer;
  states: TelemetryConnectionState[];
  messages: unknown[];
  errors: string[];
  dispose: () => void;
}

function createHarness(options: { peer?: FakePeer | null; preferWebRtc?: boolean; iceTimeoutMs?: number } = {}): Harness {
  const socket = new FakeSocket();
  const peer = options.peer === undefined ? new FakePeer() : options.peer;
  const states: TelemetryConnectionState[] = [];
  const messages: unknown[] = [];
  const errors: string[] = [];

  const transport = new TelemetryTransport({
    url: 'ws://127.0.0.1:3456?role=operator',
    role: 'operator',
    preferWebRtc: options.preferWebRtc,
    iceTimeoutMs: options.iceTimeoutMs ?? 5000,
    webSocketFactory: () => socket,
    peerFactory: () => (peer ? (peer as unknown as TelemetryPeerLike) : null),
    onMessage: (raw) => messages.push(raw),
    onState: (state) => states.push(state),
    onError: (message) => errors.push(message),
  });

  return {
    transport,
    socket,
    peer: peer ?? new FakePeer(),
    states,
    messages,
    errors,
    dispose: () => transport.dispose(),
  };
}

describe('telemetry transport fallback', () => {
  it('uses the WebSocket fallback when WebRTC is unavailable', () => {
    const h = createHarness({ peer: null });
    h.transport.start();
    h.socket.open();

    expect(h.transport.getState().status).toBe('open');
    expect(h.transport.getState().transport).toBe('websocket');
    expect(h.transport.getState().fallbackReason).toBe('webrtc-unsupported');
    expect(h.transport.getState().fallbacks).toBe(1);
    expect(h.socket.frames()).toContainEqual({ type: 'telemetry.subscribe', role: 'operator' });
    h.dispose();
  });

  it('uses WebSocket directly when WebRTC is disabled by configuration', () => {
    const h = createHarness({ preferWebRtc: false });
    h.transport.start();
    h.socket.open();

    expect(h.transport.getState().transport).toBe('websocket');
    expect(h.transport.getState().fallbackReason).toBe('webrtc-disabled');
    h.dispose();
  });

  it('negotiates an unordered, unreliability-tolerant data channel', async () => {
    const h = createHarness();
    h.transport.start();
    h.socket.open();
    await flushMicrotasks();

    expect(h.transport.getState().status).toBe('negotiating');
    expect(h.peer.init).toEqual({ ordered: false, maxRetransmits: 0 });

    const offer = h.socket.frames().find((frame) => frame.action === 'offer');
    expect(offer?.role).toBe('operator');

    h.socket.deliver({
      type: 'telemetry.signaling',
      action: 'answer',
      sdp: { type: 'answer', sdp: 'v=0-answer' },
    });
    await flushMicrotasks();
    expect(h.peer.remoteDescription?.type).toBe('answer');

    h.peer.channel.open();
    expect(h.transport.getState().status).toBe('open');
    expect(h.transport.getState().transport).toBe('webrtc');
    expect(h.transport.getState().fallbacks).toBe(0);
    h.dispose();
  });

  it('relays ICE candidates in both directions', async () => {
    const h = createHarness();
    h.transport.start();
    h.socket.open();
    await flushMicrotasks();

    h.peer.onicecandidate?.({ candidate: { candidate: 'local-candidate' } });
    expect(h.socket.frames()).toContainEqual({
      type: 'telemetry.signaling',
      action: 'candidate',
      candidate: { candidate: 'local-candidate' },
    });

    h.socket.deliver({
      type: 'telemetry.signaling',
      action: 'candidate',
      candidate: { candidate: 'remote-candidate' },
    });
    await flushMicrotasks();
    expect(h.peer.candidates).toEqual([{ candidate: 'remote-candidate' }]);
    h.dispose();
  });

  it('falls back to WebSocket when the peer connection fails', async () => {
    const h = createHarness();
    h.transport.start();
    h.socket.open();
    await flushMicrotasks();

    h.peer.connectionState = 'failed';
    h.peer.onconnectionstatechange?.();

    expect(h.transport.getState().transport).toBe('websocket');
    expect(h.transport.getState().status).toBe('open');
    expect(h.transport.getState().fallbackReason).toBe('ice-failed');
    expect(h.transport.getState().fallbacks).toBe(1);
    expect(h.peer.closed).toBe(true);
    expect(h.socket.frames()).toContainEqual({ type: 'telemetry.subscribe', role: 'operator' });
    h.dispose();
  });

  it('falls back to WebSocket when the gateway reports no producer', async () => {
    const h = createHarness();
    h.transport.start();
    h.socket.open();
    await flushMicrotasks();

    h.socket.deliver({ type: 'telemetry.no-producer' });

    expect(h.transport.getState().transport).toBe('websocket');
    expect(h.transport.getState().fallbackReason).toBe('no-peer');
    h.dispose();
  });

  it('falls back when the data channel never opens in time', async () => {
    const h = createHarness({ iceTimeoutMs: 20 });
    h.transport.start();
    h.socket.open();
    await flushMicrotasks();

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.transport.getState().transport).toBe('websocket');
    expect(h.transport.getState().fallbackReason).toBe('channel-timeout');
    h.dispose();
  });

  it('delivers telemetry from the data channel and from the fallback socket', async () => {
    const h = createHarness();
    h.transport.start();
    h.socket.open();
    await flushMicrotasks();
    h.peer.channel.open();

    h.peer.channel.emit(
      JSON.stringify({ id: 'e1', ts: 1, agentRef: 'agent_a', type: 'heartbeat', severity: 'info' })
    );
    expect(h.messages).toHaveLength(1);

    // A batch keeps per-tick overhead low for high-frequency metrics.
    h.peer.channel.emit(
      JSON.stringify([
        { id: 'e2', agentRef: 'agent_a', type: 'status' },
        { id: 'e3', agentRef: 'agent_a', type: 'status' },
      ])
    );
    expect(h.messages).toHaveLength(3);

    h.dispose();
  });

  it('publishes over the open data channel and reports when nothing is connected', () => {
    const h = createHarness();
    h.transport.start();
    h.socket.open();
    h.peer.channel.open();

    expect(h.transport.publish([{ id: 'p1' }])).toBe(true);
    expect(h.peer.channel.sent).toHaveLength(1);

    const idle = createHarness({ peer: null });
    expect(idle.transport.publish({ id: 'p2' })).toBe(false);
    idle.dispose();
    h.dispose();
  });

  it('reconnects after an unexpected close without inflating fallback counts', () => {
    jest.useFakeTimers();
    try {
      const h = createHarness({ peer: null });
      h.transport.start();
      h.socket.open();
      expect(h.transport.getState().status).toBe('open');

      h.socket.onclose?.();
      expect(h.transport.getState().status).toBe('reconnecting');
      expect(h.transport.getState().fallbacks).toBe(1);
      h.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('is final after dispose', () => {
    const h = createHarness({ peer: null });
    h.transport.start();
    h.socket.open();

    h.transport.dispose();
    expect(h.transport.getState().status).toBe('closed');

    h.transport.reconnect();
    expect(h.transport.getState().status).toBe('closed');
  });
});

describe('telemetry ICE configuration', () => {
  it('defaults to a public STUN server', () => {
    expect(buildTelemetryIceServers({})).toEqual([
      { urls: ['stun:stun.l.google.com:19302'] },
    ]);
  });

  it('adds STUN and TURN fallback entries from environment variables', () => {
    expect(
      buildTelemetryIceServers({
        NEXT_PUBLIC_TELEMETRY_STUN_URLS: 'stun:a.example:3478, stun:b.example:3478',
        NEXT_PUBLIC_TELEMETRY_TURN_URL: 'turn:turn.example:3478?transport=tcp',
        NEXT_PUBLIC_TELEMETRY_TURN_USERNAME: 'user',
        NEXT_PUBLIC_TELEMETRY_TURN_CREDENTIAL: 'secret',
      })
    ).toEqual([
      { urls: ['stun:a.example:3478', 'stun:b.example:3478'] },
      { urls: ['turn:turn.example:3478?transport=tcp'], username: 'user', credential: 'secret' },
    ]);
  });

  it('accepts a JSON ICE server override', () => {
    expect(
      buildTelemetryIceServers({
        NEXT_PUBLIC_TELEMETRY_ICE_SERVERS: '[{"urls":"stun:x:1"},{"urls":["turn:y:2"],"username":"u"}]',
      })
    ).toEqual([{ urls: 'stun:x:1' }, { urls: ['turn:y:2'], username: 'u', credential: undefined }]);
  });

  it('constructs the peer with the configured ICE servers', () => {
    const h = createHarness();
    expect(h.transport.getIceServers()).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    const config: TelemetryPeerConfig = {
      iceServers: h.transport.getIceServers(),
      iceTransportPolicy: 'all',
    };
    expect(config.iceServers).toHaveLength(1);
    h.dispose();
  });
});

describe('telemetry frame parsing', () => {
  it('classifies control, telemetry, batch and invalid frames', () => {
    expect(parseTelemetryFrame('{"type":"telemetry_welcome"}').kind).toBe('welcome');
    expect(parseTelemetryFrame({ type: 'telemetry.no-producer' }).kind).toBe('no-peer');
    expect(parseTelemetryFrame('{oops').kind).toBe('invalid');
    expect(parseTelemetryFrame({ id: '1', agentRef: 'a', type: 'heartbeat' }).kind).toBe('telemetry');
    expect(parseTelemetryFrame([{ id: '1' }, { id: '2' }]).kind).toBe('telemetry-batch');
    expect(parseTelemetryFrame({ id: '1', agentRef: 'a', type: 'nope' }).kind).toBe('unknown');
  });
});
