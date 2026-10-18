import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth/guard';
import { streamingExport, type ExportRequest as StreamingExportRequest, type RecordFetcher, type PermissionRecord } from '@/lib/export/streaming-export';

/**
 * #36 — Data export endpoint.
 *
 * Generates a scoped, privacy-safe export of operational records.
 * Only the wallet that owns the data (or a verified admin) may request it.
 *
 * Supported export types:
 *   - `simulations` — simulation runs authored by the wallet
 *   - `analytics`   — aggregated analytics snapshots
 *   - `telemetry`   — telemetry events (anonymised — no raw wallet addresses)
 *   - `affiliates`  — affiliate program performance for the requesting wallet
 *
 * Schema versioning: every export response includes a `schemaVersion` field
 * so downstream consumers can handle future field additions gracefully.
 *
 * #251 — Permission-aware streaming export pipeline:
 * - Enforces caller permissions using the centralized permission matrix
 * - Streams data in batches to bound memory usage
 * - Supports cancellation via AbortController
 * - Performs field-level permission checks and redaction
 */

// ── Schema ────────────────────────────────────────────────────────────────────

const ExportRequestSchema = z.object({
  /** Wallet address of the requester — used for authorization scope. */
  wallet: z.string().min(56).max(56),
  /** Export type to generate. */
  type: z.enum(['simulations', 'analytics', 'telemetry', 'affiliates']),
  /**
   * ISO date range for the export. Both dates are inclusive.
   * Defaults to the last 90 days if omitted.
   */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** Format requested. Defaults to `json`. */
  format: z.enum(['json', 'csv']).optional().default('json'),
});

type ExportRequest = z.infer<typeof ExportRequestSchema>;

// ── Retention gate ─────────────────────────────────────────────────────────────

/**
 * Retention limits per data type (days).
 * Exports may not span more than the retention window.
 */
const RETENTION_DAYS: Record<ExportRequest['type'], number> = {
  simulations: 365,   // 1 year
  analytics: 730,     // 2 years
  telemetry: 90,      // 90 days (minimal, anonymised)
  affiliates: 365,    // 1 year
};

function enforceDateRange(
  type: ExportRequest['type'],
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } | { error: string } {
  const maxDays = RETENTION_DAYS[type];
  const now = new Date();
  const toDate = to ? new Date(to) : now;
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - maxDays);
  const fromDate = from ? new Date(from) : defaultFrom;

  if (fromDate > toDate) {
    return { error: '`from` must be before `to`.' };
  }

  const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > maxDays) {
    return {
      error: `Export window for '${type}' may not exceed ${maxDays} days. Requested: ${Math.ceil(diffDays)} days.`,
    };
  }

  return { from: fromDate, to: toDate };
}

// ── Data fetchers (stubs — replace with real DB calls) ────────────────────────

/**
 * Fetch simulation records in batches.
 *
 * TODO: Replace with real DB query:
 * SELECT * FROM simulations
 * WHERE wallet = $1 AND created_at BETWEEN $2 AND $3
 * ORDER BY created_at
 * LIMIT $4 OFFSET $5
 */
async function fetchSimulations(
  wallet: string,
  from: Date,
  to: Date,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<PermissionRecord[]> {
  // Check for cancellation
  if (signal.aborted) {
    return [];
  }

  // TODO: query DB — filter by wallet, created_at BETWEEN from AND to
  // For now, return empty array as stub
  return [];
}

/**
 * Fetch analytics records in batches.
 *
 * TODO: Replace with real DB query:
 * SELECT * FROM analytics
 * WHERE date BETWEEN $1 AND $2
 * ORDER BY date
 * LIMIT $3 OFFSET $4
 */
async function fetchAnalytics(
  from: Date,
  to: Date,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<PermissionRecord[]> {
  // Check for cancellation
  if (signal.aborted) {
    return [];
  }

  // Aggregate-only export; no wallet PII in output.
  // TODO: query DB
  return [];
}

/**
 * Fetch telemetry records in batches.
 *
 * TODO: Replace with real DB query:
 * SELECT * FROM telemetry
 * WHERE timestamp BETWEEN $1 AND $2
 * ORDER BY timestamp
 * LIMIT $3 OFFSET $4
 */
async function fetchTelemetry(
  from: Date,
  to: Date,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<PermissionRecord[]> {
  // Check for cancellation
  if (signal.aborted) {
    return [];
  }

  // Anonymised events only — wallet column is intentionally excluded.
  // TODO: query DB
  return [];
}

/**
 * Fetch affiliate records in batches.
 *
 * TODO: Replace with real DB query:
 * SELECT * FROM affiliates
 * WHERE wallet = $1 AND created_at BETWEEN $2 AND $3
 * ORDER BY created_at
 * LIMIT $4 OFFSET $5
 */
async function fetchAffiliates(
  wallet: string,
  from: Date,
  to: Date,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<PermissionRecord[]> {
  // Check for cancellation
  if (signal.aborted) {
    return [];
  }

  // Scoped to the requesting wallet's affiliate program.
  // TODO: query DB
  return [];
}

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/export
 *
 * Body: { wallet, type, from?, to?, format? }
 *
 * This endpoint now uses the permission-aware streaming export pipeline:
 * - Validates permissions using requirePermission
 * - Streams data in batches to bound memory
 * - Supports cancellation via AbortController
 * - Performs field-level redaction based on caller's role
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = ExportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { wallet, type, from, to, format } = parsed.data;

  const dateRange = enforceDateRange(type, from, to);
  if ('error' in dateRange) {
    return NextResponse.json({ error: dateRange.error }, { status: 422 });
  }

  // Check export_data permission
  const authResult = await requirePermission(request, {
    action: 'export_data',
    resourceOwnerId: wallet,
    resourceScope: 'own',
  });

  if (!authResult.ok) {
    return authResult.response;
  }

  // Create AbortController for cancellation support
  const controller = new AbortController();
  const signal = controller.signal;

  // Set up timeout to cancel if client disconnects
  request.signal.addEventListener('abort', () => {
    controller.abort();
  });

  // Build the streaming export request
  const streamingRequest: StreamingExportRequest = {
    wallet,
    type,
    from: dateRange.from.toISOString(),
    to: dateRange.to.toISOString(),
    format,
    role: authResult.actor.role,
    actorId: authResult.actor.id,
  };

  // Create a record fetcher for this export type
  const fetcher: RecordFetcher = async (offset, limit, signal) => {
    let records: PermissionRecord[];
    switch (type) {
      case 'simulations':
        records = await fetchSimulations(wallet, dateRange.from, dateRange.to, offset, limit, signal);
        break;
      case 'analytics':
        records = await fetchAnalytics(dateRange.from, dateRange.to, offset, limit, signal);
        break;
      case 'telemetry':
        records = await fetchTelemetry(dateRange.from, dateRange.to, offset, limit, signal);
        break;
      case 'affiliates':
        records = await fetchAffiliates(wallet, dateRange.from, dateRange.to, offset, limit, signal);
        break;
    }
    return records;
  };

  // Create a ReadableStream for the response
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const streamWriter = async (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };

      try {
        await streamingExport(
          streamingRequest,
          fetcher,
          streamWriter,
          signal,
          { batchSize: 1000, debug: false },
        );
        controller.close();
      } catch (error) {
        console.error('Export error:', error);
        controller.error(error);
      }
    },
  });

  // Return the streaming response
  return new NextResponse(readable, {
    status: 200,
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv' : 'application/json',
      'Content-Disposition': `attachment; filename="${type}-export.${format}"`,
    },
  });
}
