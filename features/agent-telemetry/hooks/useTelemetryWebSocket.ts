'use client';

import type { TelemetryEvent } from '@/lib/telemetry/types';
import type { TelemetryRole } from '@/lib/telemetry/roles';
import { useTelemetryStream } from './useTelemetryStream';
import type { LegacyTelemetryStatus } from '../services/telemetry-connection-machine';
import type {
  TelemetryFallbackReason,
  TelemetryTransportKind,
} from '../services/telemetry-connection-machine';

export interface UseTelemetryWebSocketResult {
  events: TelemetryEvent[];
  status: LegacyTelemetryStatus;
  lastError: string | null;
  reconnect: () => void;
  clearEvents: () => void;
  usingMock: boolean;
  /** Transport actually in use: `webrtc` when the data channel is up, else `websocket`. */
  transport: TelemetryTransportKind | null;
  /** Number of WebRTC -> WebSocket fallbacks observed for the current connection. */
  fallbacks: number;
  /** Why the transport fell back, when it did. */
  fallbackReason: TelemetryFallbackReason | null;
}

/**
 * Backwards-compatible dashboard hook.
 *
 * Kept as the public name used by `features/agent-telemetry/page.tsx`; it now
 * delegates to `useTelemetryStream`, which prefers a WebRTC DataChannel and
 * falls back to the original WebSocket stream without changing existing
 * behaviour (`usingMock`, buffer cap, reconnect, clear buffer).
 */
export function useTelemetryWebSocket(role: TelemetryRole): UseTelemetryWebSocketResult {
  return useTelemetryStream(role);
}
