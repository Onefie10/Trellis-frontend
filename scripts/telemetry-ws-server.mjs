/**
 * Local telemetry gateway for development.
 *
 * Two transports share one port:
 *
 * 1. **WebRTC signalling relay** — a consumer sends an offer, the gateway pairs
 *    it with a producer peer for the same role and relays SDP/ICE. Telemetry
 *    then flows directly over an unordered/unreliable data channel, so a stale
 *    metric tick never blocks the ones behind it.
 * 2. **WebSocket telemetry stream** — the original behaviour, used as the
 *    fallback when WebRTC is unavailable, ICE fails, or no producer is
 *    connected (the gateway answers `telemetry.no-producer`).
 *
 * Role is taken from the query string: `ws://127.0.0.1:3456?role=operator`.
 * Producers (agent runtimes that emit metrics) connect with
 * `ws://127.0.0.1:3456?role=operator&mode=producer`.
 *
 * Clients that send no control frame still receive the legacy stream after a
 * short grace period, so existing dashboards keep working unchanged.
 *
 * Run: npm run telemetry:ws
 */
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.TELEMETRY_WS_PORT || '3456', 10);
/** How long a consumer waits for a producer peer before being told to fall back. */
const PRODUCER_WAIT_MS = parseInt(process.env.TELEMETRY_PRODUCER_WAIT_MS || '2500', 10);
/** Legacy clients that never negotiate get the WebSocket stream after this delay. */
const LEGACY_GRACE_MS = parseInt(process.env.TELEMETRY_LEGACY_GRACE_MS || '1500', 10);
const STREAM_INTERVAL_MS = parseInt(process.env.TELEMETRY_STREAM_INTERVAL_MS || '2000', 10);
const RPC_URL = process.env.OPERATIONAL_HEALTH_RPC_URL || '';

const EVENT_TYPES = ['heartbeat', 'status', 'error', 'task_started', 'task_completed'];
const SEVERITIES = ['debug', 'info', 'warn', 'error', 'critical'];
const AGENTS = ['agent_a7f3', 'agent_b2c9', 'agent_m1k4'];

let seq = 0;
let latestRpcLatencyMs = null;
let rpcProbeInFlight = false;

async function refreshRpcLatency() {
  if (!RPC_URL || rpcProbeInFlight) return;
  rpcProbeInFlight = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(STREAM_INTERVAL_MS, 2500));
  const started = performance.now();

  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'operations-health', method: 'getHealth' }),
      signal: controller.signal,
    });
    latestRpcLatencyMs = response.ok ? Math.round(performance.now() - started) : null;
  } catch {
    latestRpcLatencyMs = null;
  } finally {
    clearTimeout(timeout);
    rpcProbeInFlight = false;
  }
}

function buildOperationalMetricSample() {
  void refreshRpcLatency();
  const memory = process.memoryUsage();
  return {
    type: 'operational.metrics',
    ts: Date.now(),
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    activeConnections: wss.clients.size,
    rpcLatencyMs: latestRpcLatencyMs,
  };
}

function buildEvent() {
  seq += 1;
  const type = EVENT_TYPES[seq % EVENT_TYPES.length];
  const severity = SEVERITIES[seq % SEVERITIES.length];
  const agentRef = AGENTS[seq % AGENTS.length];
  return {
    id: `srv-${Date.now()}-${seq}`,
    ts: Date.now(),
    agentRef,
    type,
    severity,
    payload: {
      correlationId: `corr_${(seq % 4096).toString(16)}`,
      taskKind: 'embedding_batch',
      state: type === 'status' ? 'running' : 'idle',
      code: type === 'error' ? 'E_TIMEOUT' : undefined,
      message:
        type === 'error'
          ? 'Dependency timeout — retry scheduled'
          : type === 'heartbeat'
            ? 'alive'
            : 'ok',
    },
  };
}

function forRole(event, role) {
  if (
    role === 'viewer' &&
    (event.type === 'error' || event.severity === 'error' || event.severity === 'critical')
  ) {
    return {
      ...event,
      payload: {
        code: event.payload?.code,
        message: '[details restricted for your role]',
      },
    };
  }
  return event;
}

function parseRole(value) {
  return value === 'operator' || value === 'admin' ? value : 'viewer';
}

function sendJson(ws, payload) {
  if (ws.readyState !== 1) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

/** role -> Set<ws> of producers (emitters) and subscribers (WebSocket fallback). */
const producers = new Map();
const subscribers = new Map();
/** Consumers that sent an offer but have no producer yet: role -> Set<ws>. */
const pendingOffers = new Map();

function addTo(map, role, ws) {
  let set = map.get(role);
  if (!set) {
    set = new Set();
    map.set(role, set);
  }
  set.add(ws);
}

function removeFrom(map, role, ws) {
  const set = map.get(role);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) map.delete(role);
}

function broadcast(role, payload, except) {
  const set = subscribers.get(role);
  if (!set) return;
  for (const ws of set) {
    if (ws !== except) sendJson(ws, payload);
  }
}

function pickProducer(role) {
  const set = producers.get(role);
  if (!set) return null;
  for (const producer of set) {
    if (producer.readyState === 1 && !producer.consumer) return producer;
  }
  return null;
}

function pair(consumer, producer) {
  consumer.producer = producer;
  producer.consumer = consumer;
  removeFrom(pendingOffers, consumer.telemetryRole, consumer);
  if (consumer.pendingOffer) {
    sendJson(producer, consumer.pendingOffer);
    consumer.pendingOffer = null;
  }
}

function registerProducer(ws, role) {
  ws.isProducer = true;
  ws.telemetryRole = role;
  addTo(producers, role, ws);

  // A producer may join after consumers are already waiting — flush their offers.
  const waiting = pendingOffers.get(role);
  if (!waiting) return;
  for (const consumer of [...waiting]) {
    if (ws.consumer) break;
    if (consumer.readyState !== 1 || consumer.producer) {
      waiting.delete(consumer);
      continue;
    }
    if (consumer.pendingOffer) pair(consumer, ws);
  }
  if (waiting.size === 0) pendingOffers.delete(role);
}

function handleOffer(ws, message) {
  const role = parseRole(message.role) || ws.telemetryRole;
  ws.telemetryRole = role;
  const producer = pickProducer(role);
  if (producer) {
    ws.pendingOffer = message;
    pair(ws, producer);
    return;
  }

  ws.pendingOffer = message;
  addTo(pendingOffers, role, ws);
  const timer = setTimeout(() => {
    const set = pendingOffers.get(role);
    if (set) {
      set.delete(ws);
      if (set.size === 0) pendingOffers.delete(role);
    }
    if (ws.readyState !== 1 || ws.producer) return;
    ws.pendingOffer = null;
    sendJson(ws, { type: 'telemetry.no-producer', role, ts: Date.now() });
  }, PRODUCER_WAIT_MS);
  timer.unref?.();
}

function relaySignaling(ws, message) {
  if (message.action === 'offer') {
    handleOffer(ws, message);
    return;
  }
  if (message.action === 'answer') {
    // Producer -> consumer.
    if (ws.consumer) sendJson(ws.consumer, message);
    return;
  }
  if (message.action === 'candidate') {
    // Either direction: route to whichever peer this socket is paired with.
    if (ws.consumer) sendJson(ws.consumer, message);
    else if (ws.producer) sendJson(ws.producer, message);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
  let role = 'viewer';
  let mode = 'auto';
  let streamTimer = null;
  let legacyTimer = null;

  ws.telemetryRole = role;
  ws.producer = null;
  ws.consumer = null;
  ws.pendingOffer = null;
  ws.isProducer = false;

  try {
    const u = new URL(req.url || '/', 'http://localhost');
    role = parseRole(u.searchParams.get('role'));
    ws.telemetryRole = role;
    if (u.searchParams.get('mode') === 'producer') mode = 'producer';
  } catch {
    /* default viewer / auto */
  }

  sendJson(ws, {
    type: 'telemetry_welcome',
    role,
    ts: Date.now(),
    transports: ['webrtc', 'websocket'],
  });

  function startStream() {
    if (streamTimer || ws.readyState !== 1) return;
    mode = 'subscribed';
    addTo(subscribers, role, ws);
    streamTimer = setInterval(() => {
      if (ws.readyState !== 1) return;
      sendJson(ws, forRole(buildEvent(), role));
      sendJson(ws, buildOperationalMetricSample());
    }, STREAM_INTERVAL_MS);
    streamTimer.unref?.();
  }

  if (mode === 'producer') {
    registerProducer(ws, role);
  } else {
    legacyTimer = setTimeout(() => {
      legacyTimer = null;
      if (mode === 'auto') startStream();
    }, LEGACY_GRACE_MS);
    legacyTimer.unref?.();
  }

  ws.on('message', (raw) => {
    let message = null;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'telemetry.signaling') {
      if (legacyTimer) {
        clearTimeout(legacyTimer);
        legacyTimer = null;
      }
      if (mode === 'auto') mode = 'signaling';
      relaySignaling(ws, message);
      return;
    }

    if (message.type === 'telemetry.subscribe') {
      if (legacyTimer) {
        clearTimeout(legacyTimer);
        legacyTimer = null;
      }
      ws.telemetryRole = parseRole(message.role) || role;
      role = ws.telemetryRole;
      startStream();
      return;
    }

    if (message.type === 'telemetry.producer') {
      registerProducer(ws, parseRole(message.role) || role);
      return;
    }

    if (message.type === 'telemetry.publish') {
      broadcast(ws.telemetryRole, forRole(message.event, ws.telemetryRole), ws);
    }
  });

  ws.on('close', () => {
    if (streamTimer) clearInterval(streamTimer);
    if (legacyTimer) clearTimeout(legacyTimer);
    streamTimer = null;
    legacyTimer = null;

    removeFrom(subscribers, ws.telemetryRole, ws);
    removeFrom(producers, ws.telemetryRole, ws);
    for (const [pendingRole, set] of pendingOffers) {
      set.delete(ws);
      if (set.size === 0) pendingOffers.delete(pendingRole);
    }

    // Let the paired peer know the session ended so it can renegotiate.
    if (ws.producer) {
      ws.producer.consumer = null;
      sendJson(ws.producer, { type: 'telemetry.peer-left', role: ws.telemetryRole });
    }
    if (ws.consumer) {
      ws.consumer.producer = null;
      sendJson(ws.consumer, { type: 'telemetry.peer-left', role: ws.telemetryRole });
    }
  });
});

// eslint-disable-next-line no-console
console.log(`Telemetry gateway listening on ws://127.0.0.1:${PORT}`);
// eslint-disable-next-line no-console
console.log(
  `  WebRTC signalling relay + WebSocket fallback (producer wait ${PRODUCER_WAIT_MS}ms, legacy grace ${LEGACY_GRACE_MS}ms)`
);
