import { NextRequest, NextResponse } from "next/server";
import { getBugReports } from "@/app/api/bug-reports/route";
import { csrfMiddleware } from "@/lib/security/csrf";
import {
  DEFAULT_ALERT_RULES,
  bugReportToExceptionEvent,
  buildExceptionTrendReport,
  buildOperationalHealth,
  syntheticProbeManager,
  type ExceptionEvent,
  type ExceptionFilters,
  type ExceptionKind,
  type ExceptionSeverity,
} from "@/lib/operational-health";
import { buildDependencyFallbacks } from "@/lib/dependency-degradation";

const MINUTE_MS = 60 * 1000;
const MAX_WINDOW_MINUTES = 24 * 60;
const MAX_INGESTED_EXCEPTIONS = 1000;
const MAX_EVENTS_IN_RESPONSE = 500;

/** In-memory exception buffer for demo purposes, same pattern as the bug-report route. */
const ingestedExceptions: ExceptionEvent[] = [];

const KINDS: readonly ExceptionKind[] = ["rpc", "api", "ui", "render", "wallet", "other"];
const SEVERITIES: readonly ExceptionSeverity[] = ["warning", "error", "critical"];

export function getExceptionEvents(): readonly ExceptionEvent[] {
  return [...ingestedExceptions, ...getBugReports().map(bugReportToExceptionEvent)];
}

export function recordExceptionEvents(events: readonly ExceptionEvent[]): number {
  ingestedExceptions.push(...events);
  if (ingestedExceptions.length > MAX_INGESTED_EXCEPTIONS) {
    ingestedExceptions.splice(0, ingestedExceptions.length - MAX_INGESTED_EXCEPTIONS);
  }
  return ingestedExceptions.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseFilters(searchParams: URLSearchParams): ExceptionFilters {
  const filters: ExceptionFilters = {};
  const component = searchParams.get("component");
  const browserOS = searchParams.get("browserOS");
  const release = searchParams.get("release");
  const kind = searchParams.get("kind");
  if (component) filters.component = component;
  if (browserOS) filters.browserOS = browserOS;
  if (release) filters.release = release;
  if (kind && (KINDS as readonly string[]).includes(kind)) filters.kind = kind as ExceptionKind;
  return filters;
}

function parseExceptionEvent(value: unknown): ExceptionEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const { id, ts, kind, severity, component, browserOS, release, code, route } = candidate;
  if (typeof id !== "string" || !id) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return null;
  if (typeof severity !== "string" || !(SEVERITIES as readonly string[]).includes(severity)) return null;
  if (typeof component !== "string" || !component) return null;
  if (typeof browserOS !== "string" || !browserOS) return null;
  if (typeof release !== "string" || !release) return null;
  return {
    id,
    ts,
    kind: kind as ExceptionKind,
    severity: severity as ExceptionSeverity,
    component,
    browserOS,
    release,
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof route === "string" && route.trim() ? { route: route.trim() } : {}),
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedWindow = Number(searchParams.get("windowMinutes"));
  const windowMinutes = clamp(
    Number.isFinite(requestedWindow) && requestedWindow > 0 ? requestedWindow : 60,
    1,
    MAX_WINDOW_MINUTES,
  );
  const requestedBucket = Number(searchParams.get("bucketMinutes"));
  const defaultBucket = Math.max(1, Math.round(windowMinutes / 12));
  const bucketMinutes = clamp(
    Number.isFinite(requestedBucket) && requestedBucket > 0 ? requestedBucket : defaultBucket,
    1,
    windowMinutes,
  );

  const now = Date.now();
  if (searchParams.get("probe") === "true" || searchParams.get("runProbes") === "true") {
    await syntheticProbeManager.runProbes();
  }
  const externalServices = syntheticProbeManager.getAllServicesHealth();
  const dependencyFallbacks = buildDependencyFallbacks(externalServices);
  const events = getExceptionEvents();
  const exceptionTrend = buildExceptionTrendReport(events, {
    windowMs: windowMinutes * MINUTE_MS,
    bucketMs: bucketMinutes * MINUTE_MS,
    now,
    filters: parseFilters(searchParams),
    rules: DEFAULT_ALERT_RULES,
  });

  return NextResponse.json({
    ...buildOperationalHealth(getBugReports(), now),
    exceptionTrend: { ...exceptionTrend, windowMinutes, bucketMinutes },
    exceptions: events.slice(-MAX_EVENTS_IN_RESPONSE),
    externalServices,
    syntheticProbes: externalServices,
    dependencyFallbacks,
  });
}

export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { events?: unknown }).events)
      ? (payload as { events: unknown[] }).events
      : null;

  if (!raw) {
    return NextResponse.json(
      { error: "Expected an array of exception events or { events: [...] }" },
      { status: 400 },
    );
  }

  const events: ExceptionEvent[] = [];
  for (const item of raw) {
    const parsed = parseExceptionEvent(item);
    if (!parsed) {
      return NextResponse.json(
        { error: "Each exception event requires id, ts, kind, severity, component, browserOS and release" },
        { status: 400 },
      );
    }
    events.push(parsed);
  }

  const total = recordExceptionEvents(events);
  return NextResponse.json({ accepted: events.length, total }, { status: 202 });
}
