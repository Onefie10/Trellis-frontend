import type { ProbeOutcome } from "./operational-health";
import { DEFAULT_NETWORK, STELLAR_NETWORKS } from "./stellar-constants";

/**
 * Live probes behind the operational health score.
 *
 * Everything here is I/O, so it is kept out of `operational-health.ts` (pure
 * scoring, trivially testable) and every dependency — `fetch`, the WebSocket
 * constructor, the clock — is injectable. Nothing in this module reads the
 * network at import time, and no probe can run longer than its timeout.
 */

export interface HttpProbeOptions {
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** A response is "reachable" by default when it is not a server error. */
  isHealthy?: (response: Response) => boolean;
}

export interface HttpProbeResult {
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
}

/** Minimal structural WebSocket so both `ws` and the DOM class fit. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
}

export type WebSocketFactory = new (url: string) => WebSocketLike;

export interface WebSocketProbeOptions {
  timeoutMs: number;
  WebSocketImpl?: WebSocketFactory | null;
}

export interface ProbeTarget {
  key: "stellar-rpc" | "ipfs-gateway" | "telemetry-websocket";
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
}

export interface ProbeEnvironment {
  OPERATIONAL_HEALTH_RPC_URL?: string;
  OPERATIONAL_HEALTH_IPFS_GATEWAY_URL?: string;
  OPERATIONAL_HEALTH_WS_URL?: string;
  OPERATIONAL_HEALTH_PROBE_TIMEOUT_MS?: string;
  OPERATIONAL_HEALTH_PROBES?: string;
  NEXT_PUBLIC_TELEMETRY_WS_URL?: string;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 2500;
export const DEFAULT_IPFS_GATEWAY_URL = "https://ipfs.io/ipfs/";

export function resolveProbeTimeoutMs(env: ProbeEnvironment = {}): number {
  const configured = Number(env.OPERATIONAL_HEALTH_PROBE_TIMEOUT_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PROBE_TIMEOUT_MS;
}

/** Probes run unless explicitly switched off. */
export function healthProbesEnabled(env: ProbeEnvironment = {}): boolean {
  const flag = (env.OPERATIONAL_HEALTH_PROBES ?? "").trim().toLowerCase();

  return !["0", "false", "off", "no"].includes(flag);
}

/**
 * Stellar endpoint to measure. Soroban RPC when the selected network defines
 * one, otherwise the network's Horizon URL — a configured endpoint is always
 * preferred over an invented one, so the probe never reports on a host this app
 * does not actually use.
 */
export function resolveStellarEndpoint(env: ProbeEnvironment = {}): string {
  const network = STELLAR_NETWORKS[DEFAULT_NETWORK];

  return (
    env.OPERATIONAL_HEALTH_RPC_URL ||
    network?.rpcUrl ||
    network?.horizonUrl ||
    ""
  );
}

export function resolveProbeTargets(
  env: ProbeEnvironment = {},
): ProbeTarget[] {
  const timeoutMs = resolveProbeTimeoutMs(env);
  const targets: ProbeTarget[] = [];
  const stellar = resolveStellarEndpoint(env);
  const ipfs = env.OPERATIONAL_HEALTH_IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY_URL;
  const websocket =
    env.OPERATIONAL_HEALTH_WS_URL || env.NEXT_PUBLIC_TELEMETRY_WS_URL || "";

  if (stellar) {
    targets.push({ key: "stellar-rpc", url: stellar, method: "GET", timeoutMs });
  }

  targets.push({ key: "ipfs-gateway", url: ipfs, method: "HEAD", timeoutMs });

  if (websocket) {
    targets.push({
      key: "telemetry-websocket",
      url: websocket,
      method: "GET",
      timeoutMs,
    });
  }

  return targets;
}

function defaultIsHealthy(response: Response): boolean {
  // 4xx means "the endpoint answered" (auth, route); 5xx and 429 mean the
  // service itself is unhealthy, which is what this score is about.
  return response.status < 500 && response.status !== 429;
}

export async function probeHttpEndpoint(
  url: string,
  {
    timeoutMs,
    method = "GET",
    headers,
    fetchImpl,
    isHealthy = defaultIsHealthy,
  }: HttpProbeOptions,
): Promise<HttpProbeResult> {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);

  if (!doFetch) {
    return {
      ok: false,
      latencyMs: null,
      statusCode: null,
      error: "No fetch implementation available in this runtime",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await doFetch(url, {
      method,
      headers,
      signal: controller.signal,
      // A cached answer measures the cache, not the service.
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;

    return {
      ok: isHealthy(response),
      latencyMs,
      statusCode: response.status,
      error: isHealthy(response) ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      statusCode: null,
      error:
        error instanceof Error && error.name === "AbortError"
          ? `Timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Probe failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loadWebSocketImpl(): Promise<WebSocketFactory | null> {
  const globalImpl = (globalThis as { WebSocket?: unknown }).WebSocket;

  if (typeof globalImpl === "function") {
    return globalImpl as WebSocketFactory;
  }

  try {
    const wsModule = (await import("ws")) as unknown as {
      default?: unknown;
      WebSocket?: unknown;
    };
    const implementation = wsModule.default ?? wsModule.WebSocket;

    return typeof implementation === "function"
      ? (implementation as WebSocketFactory)
      : null;
  } catch {
    // `ws` is not installed or not resolvable in this runtime.
    return null;
  }
}

export interface WebSocketProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  /** True when no WebSocket implementation exists, which is not a failure. */
  unavailable?: boolean;
}

/**
 * Opens the socket, measures the handshake, and closes it again. Only
 * reachability is asserted — the probe does not send or expect application
 * messages.
 */
export async function probeWebSocketEndpoint(
  url: string,
  { timeoutMs, WebSocketImpl }: WebSocketProbeOptions,
): Promise<WebSocketProbeResult> {
  const Implementation = WebSocketImpl ?? (await loadWebSocketImpl());

  if (!Implementation) {
    return {
      ok: false,
      latencyMs: null,
      error: "No WebSocket implementation available in this runtime",
      unavailable: true,
    };
  }

  return new Promise<WebSocketProbeResult>((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket: WebSocketLike | null = null;

    const finish = (result: WebSocketProbeResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Closing a socket that never opened is not worth reporting.
      }
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          latencyMs: null,
          error: `Timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    );

    try {
      socket = new Implementation(url);
    } catch (error) {
      finish({
        ok: false,
        latencyMs: null,
        error: error instanceof Error ? error.message : "Could not open socket",
      });
      return;
    }

    socket.onopen = () =>
      finish({ ok: true, latencyMs: Date.now() - started, error: null });
    socket.onerror = () =>
      finish({ ok: false, latencyMs: null, error: "Connection error" });
  });
}

export interface RunHealthProbesOptions {
  env?: ProbeEnvironment;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: WebSocketFactory | null;
}

/**
 * Runs every configured probe in parallel. Unconfigured components come back
 * `skipped` so the caller can exclude them from the score instead of counting
 * them as outages.
 */
export async function runOperationalHealthProbes({
  env = {},
  fetchImpl,
  WebSocketImpl,
}: RunHealthProbesOptions = {}): Promise<ProbeOutcome[]> {
  const targets = resolveProbeTargets(env);
  const hasWebSocketTarget = targets.some(
    (target) => target.key === "telemetry-websocket",
  );

  const outcomes = await Promise.all(
    targets.map(async (target): Promise<ProbeOutcome> => {
      if (target.key === "telemetry-websocket") {
        const result = await probeWebSocketEndpoint(target.url, {
          timeoutMs: target.timeoutMs,
          WebSocketImpl,
        });

        return {
          key: target.key,
          ok: result.ok,
          latencyMs: result.latencyMs,
          error: result.error,
          skipped: result.unavailable === true,
        };
      }

      const result = await probeHttpEndpoint(target.url, {
        timeoutMs: target.timeoutMs,
        method: target.method,
        fetchImpl,
      });

      return {
        key: target.key,
        ok: result.ok,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        error: result.error,
      };
    }),
  );

  if (!hasWebSocketTarget) {
    outcomes.push({
      key: "telemetry-websocket",
      ok: false,
      latencyMs: null,
      skipped: true,
      error: "No telemetry WebSocket URL configured",
    });
  }

  return outcomes;
}
