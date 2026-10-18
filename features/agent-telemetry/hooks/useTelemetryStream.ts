'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TelemetryEvent, TelemetryEventType, TelemetrySeverity } from '@/lib/telemetry/types';
import { sanitizeTelemetryEvent } from '@/lib/telemetry/sanitize';
import { TelemetryEventSampler } from '@/lib/telemetry/sampler';
import type { TelemetryRole } from '@/lib/telemetry/roles';
import {
  buildTelemetryIceServers,
  TelemetryTransport,
  type TelemetryIceServer,
} from '../services/telemetryTransport';
import {
  initialTelemetryConnectionState,
  toLegacyTelemetryStatus,
  type LegacyTelemetryStatus,
  type TelemetryConnectionState,
  type TelemetryFallbackReason,
  type TelemetryTransportKind,
} from '../services/telemetry-connection-machine';

const MAX_BUFFER = 500;
const MAX_TELEMETRY_EVENTS_PER_SECOND = 30;

function isTelemetryEvent(raw: unknown): raw is TelemetryEvent {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.ts === 'number' &&
    typeof o.agentRef === 'string' &&
    typeof o.type === 'string' &&
    typeof o.severity === 'string'
  );
}

function getWsBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_TELEMETRY_WS_URL?.trim();
  return base || null;
}

function buildWsUrl(role: TelemetryRole): string | null {
  const base = getWsBaseUrl();
  if (!base) return null;
  try {
    const u = new URL(base);
    u.searchParams.set('role', role);
    return u.toString();
  } catch {
    return null;
  }
}

/** WebRTC is preferred unless explicitly disabled with `NEXT_PUBLIC_TELEMETRY_WEBRTC=0`. */
function resolvePreferWebRtc(): boolean {
  const raw = process.env.NEXT_PUBLIC_TELEMETRY_WEBRTC;
  if (raw === undefined || raw === '') return true;
  const value = String(raw).trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

function resolveIceServers(): TelemetryIceServer[] {
  return buildTelemetryIceServers({
    NEXT_PUBLIC_TELEMETRY_STUN_URLS: process.env.NEXT_PUBLIC_TELEMETRY_STUN_URLS,
    NEXT_PUBLIC_TELEMETRY_TURN_URL: process.env.NEXT_PUBLIC_TELEMETRY_TURN_URL,
    NEXT_PUBLIC_TELEMETRY_TURN_USERNAME: process.env.NEXT_PUBLIC_TELEMETRY_TURN_USERNAME,
    NEXT_PUBLIC_TELEMETRY_TURN_CREDENTIAL: process.env.NEXT_PUBLIC_TELEMETRY_TURN_CREDENTIAL,
    NEXT_PUBLIC_TELEMETRY_ICE_SERVERS: process.env.NEXT_PUBLIC_TELEMETRY_ICE_SERVERS,
  });
}

export interface UseTelemetryStreamResult {
  events: TelemetryEvent[];
  status: LegacyTelemetryStatus;
  /** Active transport once connected (`webrtc` preferred, `websocket` fallback). */
  transport: TelemetryTransportKind | null;
  /** How many times WebRTC negotiation fell back to the WebSocket transport. */
  fallbacks: number;
  fallbackReason: TelemetryFallbackReason | null;
  lastError: string | null;
  reconnect: () => void;
  clearEvents: () => void;
  usingMock: boolean;
  enforceRetention: () => { purgedCount: number; remainingCount: number };
  deleteEvent: (id: string) => boolean;
}

/**
 * Streams agent telemetry preferring an unordered/unreliable WebRTC
 * DataChannel and transparently falling back to the existing WebSocket.
 * Falls back to the in-browser mock stream when no URL is configured.
 */
export function useTelemetryStream(role: TelemetryRole): UseTelemetryStreamResult {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [connection, setConnection] = useState<TelemetryConnectionState>(() =>
    initialTelemetryConnectionState()
  );
  const [lastError, setLastError] = useState<string | null>(null);
  const transportRef = useRef<TelemetryTransport | null>(null);
  const mockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqRef = useRef(0);
  const samplerRef = useRef<TelemetryEventSampler | null>(null);
  if (!samplerRef.current) samplerRef.current = new TelemetryEventSampler(MAX_TELEMETRY_EVENTS_PER_SECOND);
  const roleRef = useRef(role);
  roleRef.current = role;
  const usingMock = !getWsBaseUrl();

  const pushEvent = useCallback((ev: TelemetryEvent) => {
    if (!samplerRef.current?.shouldAccept()) return;
    setEvents((prev) => {
      const next = [sanitizeTelemetryEvent(ev), ...prev];
      return next.slice(0, MAX_BUFFER);
    });
  }, []);

  const stopMock = useCallback(() => {
    if (mockRef.current) {
      clearInterval(mockRef.current);
      mockRef.current = null;
    }
  }, []);

  const stopTransport = useCallback(() => {
    if (transportRef.current) {
      transportRef.current.dispose();
      transportRef.current = null;
    }
  }, []);

  const startMock = useCallback(() => {
    stopTransport();
    stopMock();
    setConnection((prev) => ({
      ...prev,
      status: 'open',
      transport: 'websocket',
      fallbackReason: null,
      lastError: null,
    }));
    setLastError(null);

    const types: TelemetryEventType[] = [
      'heartbeat',
      'status',
      'error',
      'task_started',
      'task_completed',
    ];
    const severities: TelemetrySeverity[] = ['debug', 'info', 'warn', 'error', 'critical'];
    const agents = ['agent_a7f3', 'agent_b2c9', 'agent_m1k4'];

    mockRef.current = setInterval(() => {
      seqRef.current += 1;
      const r = roleRef.current;
      const type = types[seqRef.current % types.length];
      const severity = severities[seqRef.current % severities.length];
      const agentRef = agents[seqRef.current % agents.length];

      const base: TelemetryEvent = {
        id: `mock-${Date.now()}-${seqRef.current}`,
        ts: Date.now(),
        agentRef,
        type,
        severity,
        payload: {
          correlationId: `corr_${(seqRef.current % 1000).toString(36)}`,
          taskKind: 'embedding_batch',
          state: type === 'status' ? 'running' : 'ok',
          code: type === 'error' ? 'E_RATE_LIMIT' : undefined,
          message:
            type === 'error' && r === 'viewer'
              ? undefined
              : type === 'error'
                ? 'Upstream provider throttled (retry scheduled)'
                : 'tick',
        },
      };

      pushEvent(base);
    }, 1800);
  }, [pushEvent, stopMock, stopTransport]);

  const connect = useCallback(() => {
    const url = buildWsUrl(roleRef.current);

    stopMock();
    stopTransport();

    if (!url) {
      startMock();
      return;
    }

    setConnection(initialTelemetryConnectionState());
    setLastError(null);

    const transport = new TelemetryTransport({
      url,
      role: roleRef.current,
      preferWebRtc: resolvePreferWebRtc(),
      iceServers: resolveIceServers(),
      onMessage: (raw) => {
        if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'telemetry_welcome') {
          return;
        }
        if (!isTelemetryEvent(raw)) return;
        pushEvent(raw);
      },
      onState: (snapshot) => setConnection(snapshot),
      onError: (message) => setLastError(message),
    });
    transportRef.current = transport;
    transport.start();
  }, [pushEvent, startMock, stopMock, stopTransport]);

  useEffect(() => {
    roleRef.current = role;
    connect();
    return () => {
      stopTransport();
      stopMock();
    };
  }, [connect, role, stopMock, stopTransport]);

  const clearEvents = useCallback(() => setEvents([]), []);

  const enforceRetention = useCallback(() => {
    const now = Date.now();
    let purgedCount = 0;
    setEvents((prev) => {
      const retained = prev.filter((e) => {
        if (e.expiresAt && e.expiresAt <= now) {
          purgedCount++;
          return false;
        }
        return true;
      });
      return retained;
    });
    return { purgedCount, remainingCount: events.length - purgedCount };
  }, [events.length]);

  const deleteEvent = useCallback((id: string) => {
    let existed = false;
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx !== -1) {
        existed = true;
        return prev.filter((e) => e.id !== id);
      }
      return prev;
    });
    return existed;
  }, []);

  const status = useMemo(() => toLegacyTelemetryStatus(connection), [connection]);

  return {
    events,
    status,
    transport: connection.transport,
    fallbacks: connection.fallbacks,
    fallbackReason: connection.fallbackReason,
    lastError,
    reconnect: connect,
    clearEvents,
    usingMock,
    enforceRetention,
    deleteEvent,
  };
}
