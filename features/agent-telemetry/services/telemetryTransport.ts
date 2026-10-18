/**
 * Telemetry transport with WebRTC DataChannel preference and WebSocket fallback.
 *
 * The dashboard used to stream agent telemetry over a plain WebSocket, which
 * suffers head-of-line blocking and server bandwidth pressure once agents emit
 * high-frequency metrics. This module negotiates a WebRTC peer connection and
 * streams metrics over an **unordered / unreliable** data channel
 * (`ordered: false`, `maxRetransmits: 0`) so a lost metric tick never delays the
 * ones behind it. The existing WebSocket server is reused for signalling and
 * remains the transport whenever WebRTC is unavailable, ICE fails, or no
 * producer peer is reachable.
 *
 * Design notes:
 * - All I/O goes through injectable factories, which keeps the negotiation and
 *   fallback logic unit testable without a browser.
 * - Connection transitions are owned by `telemetry-connection-machine.ts`
 *   (pure reducer) so state can be asserted deterministically.
 */

import {
  createTelemetryConnectionMachine,
  initialTelemetryConnectionState,
} from './telemetry-connection-machine';
import type {
  TelemetryConnectionEvent,
  TelemetryConnectionState,
  TelemetryFallbackReason,
} from './telemetry-connection-machine';
import type { TelemetryRole } from '@/lib/telemetry/roles';

/* -------------------------------------------------------------------------- */
/* Structural I/O types (kept minimal so tests can inject tiny fakes)          */
/* -------------------------------------------------------------------------- */

export interface TelemetryIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TelemetryPeerConfig {
  iceServers: TelemetryIceServer[];
  iceTransportPolicy: 'all' | 'relay';
}

export interface TelemetryDataChannelLike {
  readyState?: string;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface TelemetryPeerLike {
  createDataChannel(
    label: string,
    init?: { ordered?: boolean; maxRetransmits?: number }
  ): TelemetryDataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
  connectionState?: string;
  localDescription?: { type: string; sdp?: string } | null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null;
  onconnectionstatechange: ((ev?: unknown) => void) | null;
}

export interface TelemetrySocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type TelemetrySocketFactory = (url: string) => TelemetrySocketLike | null;
export type TelemetryPeerFactory = (config: TelemetryPeerConfig) => TelemetryPeerLike | null;
type TimerHandle = ReturnType<typeof setTimeout>;

/* -------------------------------------------------------------------------- */
/* ICE / STUN / TURN configuration                                             */
/* -------------------------------------------------------------------------- */

/** Public STUN used when no explicit configuration is supplied. */
export const DEFAULT_TELEMETRY_STUN_URLS = ['stun:stun.l.google.com:19302'];

export interface TelemetryIceEnv {
  NEXT_PUBLIC_TELEMETRY_STUN_URLS?: string;
  NEXT_PUBLIC_TELEMETRY_TURN_URL?: string;
  NEXT_PUBLIC_TELEMETRY_TURN_USERNAME?: string;
  NEXT_PUBLIC_TELEMETRY_TURN_CREDENTIAL?: string;
  /** JSON array of `{ urls, username?, credential? }`, or a comma separated URL list. */
  NEXT_PUBLIC_TELEMETRY_ICE_SERVERS?: string;
}

function splitList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isIceServer(value: unknown): value is TelemetryIceServer {
  if (!value || typeof value !== 'object') return false;
  const urls = (value as { urls?: unknown }).urls;
  return typeof urls === 'string' || Array.isArray(urls);
}

function coerceIceServers(value: unknown): TelemetryIceServer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isIceServer).map((entry) => ({
    urls: entry.urls,
    username: typeof entry.username === 'string' ? entry.username : undefined,
    credential: typeof entry.credential === 'string' ? entry.credential : undefined,
  }));
}

/**
 * Resolve the ICE server list from environment configuration.
 *
 * Order matters: STUN entries are tried first and TURN entries act as the
 * relay fallback for peers behind symmetric NAT / restrictive firewalls. A
 * `NEXT_PUBLIC_TELEMETRY_ICE_SERVERS` JSON array can fully override the list.
 */
export function buildTelemetryIceServers(env: TelemetryIceEnv): TelemetryIceServer[] {
  const explicit = env.NEXT_PUBLIC_TELEMETRY_ICE_SERVERS?.trim();
  if (explicit) {
    if (explicit.startsWith('[')) {
      try {
        const parsed = coerceIceServers(JSON.parse(explicit));
        if (parsed.length > 0) return parsed;
      } catch {
        /* fall through to the individual variables below */
      }
    } else {
      const urls = splitList(explicit);
      if (urls.length > 0) return [{ urls }];
    }
  }

  const servers: TelemetryIceServer[] = [];
  const stunUrls = splitList(env.NEXT_PUBLIC_TELEMETRY_STUN_URLS);
  servers.push({ urls: stunUrls.length > 0 ? stunUrls : DEFAULT_TELEMETRY_STUN_URLS });

  const turnUrls = splitList(env.NEXT_PUBLIC_TELEMETRY_TURN_URL);
  if (turnUrls.length > 0) {
    const username = env.NEXT_PUBLIC_TELEMETRY_TURN_USERNAME?.trim();
    const credential = env.NEXT_PUBLIC_TELEMETRY_TURN_CREDENTIAL?.trim();
    servers.push({
      urls: turnUrls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  return servers;
}

/* -------------------------------------------------------------------------- */
/* Frame parsing                                                               */
/* -------------------------------------------------------------------------- */

const TELEMETRY_EVENT_TYPES = new Set([
  'heartbeat',
  'status',
  'error',
  'task_started',
  'task_completed',
]);

export type ParsedTelemetryFrame =
  | { kind: 'answer'; sdp: { type: string; sdp?: string } }
  | { kind: 'candidate'; candidate: unknown }
  | { kind: 'no-peer' }
  | { kind: 'welcome' }
  | { kind: 'telemetry'; raw: Record<string, unknown> }
  | { kind: 'telemetry-batch'; items: unknown[] }
  | { kind: 'invalid' }
  | { kind: 'unknown' };

/** Classify a frame as telemetry rather than a signalling control message. */
export function isTelemetryEventFrame(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.agentRef === 'string' &&
    typeof o.type === 'string' &&
    TELEMETRY_EVENT_TYPES.has(o.type)
  );
}

function coerceJson(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse a signalling / telemetry frame received from the WebSocket or the data
 * channel. Accepts already-parsed values as well as JSON strings.
 */
export function parseTelemetryFrame(raw: unknown): ParsedTelemetryFrame {
  const coerced = coerceJson(raw);
  if (!coerced.ok) return { kind: 'invalid' };
  const value = coerced.value;

  if (Array.isArray(value)) return { kind: 'telemetry-batch', items: value };
  if (!value || typeof value !== 'object') return { kind: 'unknown' };

  const frame = value as Record<string, unknown>;
  if (frame.type === 'telemetry_welcome') return { kind: 'welcome' };
  if (frame.type === 'telemetry.no-producer') return { kind: 'no-peer' };

  if (frame.type === 'telemetry.signaling') {
    if (frame.action === 'answer' && frame.sdp && typeof frame.sdp === 'object') {
      return { kind: 'answer', sdp: frame.sdp as { type: string; sdp?: string } };
    }
    if (frame.action === 'candidate' && frame.candidate) {
      return { kind: 'candidate', candidate: frame.candidate };
    }
    return { kind: 'unknown' };
  }

  if (isTelemetryEventFrame(frame)) return { kind: 'telemetry', raw: frame };
  return { kind: 'unknown' };
}

/* -------------------------------------------------------------------------- */
/* Default factories                                                           */
/* -------------------------------------------------------------------------- */

function defaultSocketFactory(url: string): TelemetrySocketLike | null {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== 'function') return null;
  const socket = new (ctor as new (target: string) => unknown)(url);
  return socket as TelemetrySocketLike;
}

function defaultPeerFactory(config: TelemetryPeerConfig): TelemetryPeerLike | null {
  const ctor = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  if (typeof ctor !== 'function') return null;
  const peer = new (ctor as new (config: unknown) => unknown)({
    iceServers: config.iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
  });
  return peer as TelemetryPeerLike;
}

const SOCKET_OPEN = 1;
const CHANNEL_OPEN = 'open';
const DATA_CHANNEL_LABEL = 'telemetry';
/** Unordered + no retransmits: late metrics are stale, so never block the stream. */
const DATA_CHANNEL_INIT = { ordered: false, maxRetransmits: 0 } as const;

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export interface TelemetryTransportOptions {
  /** Signalling + fallback WebSocket URL (may already carry `?role=`). */
  url: string;
  role: TelemetryRole;
  /** Set to `false` to skip WebRTC entirely and use WebSocket from the start. */
  preferWebRtc?: boolean;
  iceServers?: TelemetryIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
  /** Give up on the signalling socket if it never opens. */
  connectTimeoutMs?: number;
  /** Give up on the data channel if ICE never completes. */
  iceTimeoutMs?: number;
  /** Base delay for exponential-ish reconnect backoff (attempt * base). */
  reconnectBaseDelayMs?: number;
  maxReconnectAttempts?: number;
  webSocketFactory?: TelemetrySocketFactory;
  peerFactory?: TelemetryPeerFactory;
  setTimeoutFn?: (handler: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  onMessage?: (raw: unknown) => void;
  onState?: (state: TelemetryConnectionState) => void;
  onError?: (message: string) => void;
}

export class TelemetryTransport {
  private readonly options: TelemetryTransportOptions;
  private readonly machine = createTelemetryConnectionMachine(initialTelemetryConnectionState());
  private readonly iceServers: TelemetryIceServer[];

  private socket: TelemetrySocketLike | null = null;
  private peer: TelemetryPeerLike | null = null;
  private channel: TelemetryDataChannelLike | null = null;
  private socketMode: 'signaling' | 'fallback' | null = null;

  private connectTimer: TimerHandle | null = null;
  private iceTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempts = 0;
  private started = false;
  private disposed = false;

  constructor(options: TelemetryTransportOptions) {
    this.options = options;
    this.iceServers =
      options.iceServers && options.iceServers.length > 0
        ? options.iceServers
        : buildTelemetryIceServers({});
  }

  /* ------------------------------ public API ------------------------------ */

  getState(): TelemetryConnectionState {
    return this.machine.getState();
  }

  getIceServers(): TelemetryIceServer[] {
    return this.iceServers;
  }

  /** Begin connecting, preferring WebRTC when it is usable. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.reconnectAttempts = 0;
    this.emit({ type: 'start', now: Date.now() });
    this.openInitialTransport();
  }

  /** Tear down whatever is active and start over (used by the Reconnect button). */
  reconnect(): void {
    if (this.disposed) return;
    this.started = true;
    this.reconnectAttempts = 0;
    this.clearTimers();
    this.teardownWebRtc();
    this.closeSocket();
    this.socketMode = null;
    this.emit({ type: 'reconnect', now: Date.now() });
    this.openInitialTransport();
  }

  /**
   * Publish telemetry from a producer peer. Arrays are sent as a single batch
   * which keeps per-tick overhead low on high-frequency metrics.
   */
  publish(payload: unknown | unknown[]): boolean {
    const encoded = JSON.stringify(payload);
    const channel = this.channel;
    if (channel && channel.readyState === CHANNEL_OPEN) {
      channel.send(encoded);
      return true;
    }
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify({ type: 'telemetry.publish', event: payload }));
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.teardownWebRtc();
    this.closeSocket();
    this.socketMode = null;
    this.emit({ type: 'dispose', now: Date.now() });
  }

  /* --------------------------- connection setup --------------------------- */

  private supportsWebRtc(): boolean {
    if (this.options.peerFactory) return true;
    return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
  }

  private openInitialTransport(): void {
    if (this.options.preferWebRtc === false) {
      this.enterFallback('webrtc-disabled');
      return;
    }
    if (!this.supportsWebRtc()) {
      this.enterFallback('webrtc-unsupported');
      return;
    }
    this.openSignalingSocket();
  }

  private enterFallback(reason: TelemetryFallbackReason): void {
    if (this.disposed) return;
    // Already on the fallback path — a repeated trigger must not inflate counters.
    if (this.socketMode === 'fallback') return;
    if (this.machine.getState().transport === 'websocket') return;
    this.emit({ type: 'fallback', reason, now: Date.now() });
    this.teardownWebRtc();
    this.openFallbackSocket();
  }

  private openSignalingSocket(): void {
    this.socketMode = 'signaling';
    const socket = this.ensureSocket();
    if (!socket) return;
    if (socket.readyState === SOCKET_OPEN) {
      this.beginNegotiation();
      return;
    }
    this.armConnectTimeout();
  }

  private openFallbackSocket(): void {
    this.socketMode = 'fallback';
    const socket = this.ensureSocket();
    if (!socket) return;
    if (socket.readyState === SOCKET_OPEN) {
      this.markWebSocketOpen();
      return;
    }
    this.armConnectTimeout();
  }

  private ensureSocket(): TelemetrySocketLike | null {
    if (this.socket) return this.socket;
    const factory = this.options.webSocketFactory ?? defaultSocketFactory;
    let socket: TelemetrySocketLike | null = null;
    try {
      socket = factory(this.options.url);
    } catch {
      socket = null;
    }
    if (!socket) {
      this.fail('Telemetry WebSocket unavailable');
      return null;
    }
    socket.onopen = () => this.handleSocketOpen();
    socket.onmessage = (ev) => this.handleSocketMessage(ev?.data);
    socket.onerror = () => this.handleSocketError();
    socket.onclose = () => this.handleSocketClose();
    this.socket = socket;
    return socket;
  }

  private beginNegotiation(): void {
    this.emit({ type: 'negotiate', now: Date.now() });

    let peer: TelemetryPeerLike | null = null;
    try {
      const factory = this.options.peerFactory ?? defaultPeerFactory;
      peer = factory({
        iceServers: this.iceServers,
        iceTransportPolicy: this.options.iceTransportPolicy ?? 'all',
      });
    } catch {
      peer = null;
    }
    if (!peer) {
      this.enterFallback('webrtc-unsupported');
      return;
    }

    this.peer = peer;
    peer.onicecandidate = (ev) => {
      if (this.peer !== peer) return;
      if (ev && ev.candidate) {
        this.sendJson({
          type: 'telemetry.signaling',
          action: 'candidate',
          candidate: ev.candidate,
        });
      }
    };
    peer.onconnectionstatechange = () => this.handlePeerStateChange(peer);

    const channel = peer.createDataChannel(DATA_CHANNEL_LABEL, { ...DATA_CHANNEL_INIT });
    this.channel = channel;
    channel.onopen = () => {
      if (this.channel !== channel || this.disposed) return;
      this.clearIceTimeout();
      this.reconnectAttempts = 0;
      this.emit({ type: 'webrtc-open', now: Date.now() });
    };
    channel.onmessage = (ev) => {
      if (this.channel !== channel) return;
      this.deliverFrame(ev?.data);
    };
    channel.onclose = () => {
      if (this.channel !== channel) return;
      this.enterFallback('channel-closed');
    };
    channel.onerror = () => {
      if (this.channel !== channel) return;
      this.notifyError('Telemetry data channel error');
      this.enterFallback('datachannel-error');
    };

    this.armIceTimeout();

    void peer
      .createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .then(() => {
        if (this.peer !== peer) return;
        this.sendJson({
          type: 'telemetry.signaling',
          action: 'offer',
          role: this.options.role,
          sdp: peer.localDescription ?? { type: 'offer' },
        });
      })
      .catch(() => {
        if (this.peer !== peer) return;
        this.enterFallback('signaling-failed');
      });
  }

  private markWebSocketOpen(): void {
    this.sendJson({ type: 'telemetry.subscribe', role: this.options.role });
    this.reconnectAttempts = 0;
    this.emit({ type: 'websocket-open', now: Date.now() });
  }

  /* ---------------------------- socket handlers --------------------------- */

  private handleSocketOpen(): void {
    this.clearConnectTimeout();
    if (this.socketMode === 'fallback') {
      this.markWebSocketOpen();
      return;
    }
    this.beginNegotiation();
  }

  private handleSocketMessage(data: unknown): void {
    const frame = parseTelemetryFrame(data);
    switch (frame.kind) {
      case 'answer': {
        const peer = this.peer;
        if (!peer) break;
        void peer.setRemoteDescription(frame.sdp).catch(() => {
          if (this.peer === peer) this.enterFallback('signaling-failed');
        });
        break;
      }
      case 'candidate': {
        const peer = this.peer;
        if (!peer) break;
        // Stray candidates after ICE completion are expected; ignore failures.
        void peer.addIceCandidate(frame.candidate).catch(() => undefined);
        break;
      }
      case 'no-peer':
        this.enterFallback('no-peer');
        break;
      case 'telemetry':
        this.options.onMessage?.(frame.raw);
        break;
      case 'telemetry-batch':
        for (const item of frame.items) this.options.onMessage?.(item);
        break;
      case 'invalid':
        this.notifyError('Invalid telemetry frame');
        break;
      default:
        break;
    }
  }

  private handleSocketError(): void {
    if (this.disposed) return;
    this.notifyError('Telemetry socket error');
    if (this.socketMode === 'signaling' && this.machine.getState().transport !== 'webrtc') {
      this.enterFallback('signaling-failed');
    }
  }

  private handleSocketClose(): void {
    const wasOpen = this.machine.getState().status === 'open';
    this.socket = null;
    if (this.disposed) return;
    if (!wasOpen) {
      if (this.socketMode === 'signaling') {
        this.enterFallback('signaling-failed');
      } else {
        this.scheduleReconnect('socket closed before open');
      }
      return;
    }
    this.scheduleReconnect('socket closed');
  }

  private handlePeerStateChange(peer: TelemetryPeerLike): void {
    if (this.peer !== peer || this.disposed) return;
    const connectionState = peer.connectionState;
    if (connectionState === 'failed' || connectionState === 'closed') {
      this.enterFallback('ice-failed');
      return;
    }
    if (connectionState === 'disconnected' && this.machine.getState().transport !== 'webrtc') {
      this.enterFallback('ice-failed');
    }
  }

  /* ------------------------------- plumbing ------------------------------- */

  private deliverFrame(raw: unknown): void {
    const frame = parseTelemetryFrame(raw);
    if (frame.kind === 'telemetry') {
      this.options.onMessage?.(frame.raw);
    } else if (frame.kind === 'telemetry-batch') {
      for (const item of frame.items) this.options.onMessage?.(item);
    } else if (frame.kind === 'invalid') {
      this.notifyError('Invalid telemetry frame');
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed) return;
    const maxAttempts = this.options.maxReconnectAttempts ?? 5;
    if (this.reconnectAttempts >= maxAttempts) {
      this.fail(`Telemetry reconnect attempts exhausted (${reason})`);
      return;
    }
    this.reconnectAttempts += 1;
    const delay = (this.options.reconnectBaseDelayMs ?? 1000) * this.reconnectAttempts;
    this.notifyError(`Telemetry transport interrupted: ${reason}`);
    this.emit({ type: 'reconnect', now: Date.now() });
    this.clearReconnectTimer();
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.teardownWebRtc();
      this.closeSocket();
      this.socketMode = null;
      this.openInitialTransport();
    }, delay);
  }

  private sendJson(payload: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      this.notifyError('Telemetry socket send failed');
      return false;
    }
  }

  private emit(event: TelemetryConnectionEvent): void {
    const next = this.machine.send(event);
    this.options.onState?.(next);
  }

  private notifyError(message: string): void {
    this.options.onError?.(message);
  }

  private fail(message: string): void {
    this.notifyError(message);
    this.emit({ type: 'error', message, now: Date.now() });
  }

  private teardownWebRtc(): void {
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      try {
        channel.close();
      } catch {
        /* already closed */
      }
    }
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      try {
        peer.close();
      } catch {
        /* already closed */
      }
    }
    this.clearIceTimeout();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  private setTimer(handler: () => void, ms: number): TimerHandle {
    const fn = this.options.setTimeoutFn ?? ((h: () => void, delay: number) => setTimeout(h, delay));
    return fn(handler, ms);
  }

  private clearTimer(handle: TimerHandle | null): void {
    if (handle === null) return;
    const fn = this.options.clearTimeoutFn ?? ((h: TimerHandle) => clearTimeout(h));
    fn(handle);
  }

  private armConnectTimeout(): void {
    this.clearConnectTimeout();
    this.connectTimer = this.setTimer(() => {
      this.connectTimer = null;
      if (this.disposed || this.machine.getState().status === 'open') return;
      if (this.socketMode === 'signaling') {
        this.enterFallback('signaling-failed');
      } else {
        this.scheduleReconnect('connect timeout');
      }
    }, this.options.connectTimeoutMs ?? 4000);
  }

  private armIceTimeout(): void {
    this.clearIceTimeout();
    this.iceTimer = this.setTimer(() => {
      this.iceTimer = null;
      if (this.disposed || this.machine.getState().transport === 'webrtc') return;
      this.enterFallback('channel-timeout');
    }, this.options.iceTimeoutMs ?? 5000);
  }

  private clearConnectTimeout(): void {
    this.clearTimer(this.connectTimer);
    this.connectTimer = null;
  }

  private clearIceTimeout(): void {
    this.clearTimer(this.iceTimer);
    this.iceTimer = null;
  }

  private clearReconnectTimer(): void {
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectTimeout();
    this.clearIceTimeout();
    this.clearReconnectTimer();
  }
}
