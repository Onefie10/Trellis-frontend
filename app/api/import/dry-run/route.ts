import { NextRequest, NextResponse } from 'next/server';
import { runImportPipeline } from '@/lib/import/pipeline';
import { ImportOptions, ImportResult } from '@/lib/import/types';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB upper bound for dry-run payloads

const ALLOWED_ENTITY_TYPES = new Set([
  'general',
  'transactions',
  'accounts',
  'contacts',
]);

function normalizeEntityType(raw: string | null): ImportOptions['entityType'] {
  if (!raw) return 'general';
  const value = raw.trim().toLowerCase();
  if (ALLOWED_ENTITY_TYPES.has(value)) {
    return value as ImportOptions['entityType'];
  }
  return 'general';
}

function coerceBoolean(raw: string | null, defaultValue: boolean): boolean {
  if (raw === null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  return defaultValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null && !Array.isArray(value));
}

function buildErrorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      dryRun: true,
      error: message,
      code,
      ...(extra ?? {}),
    },
    { status }
  );
}

/**
 * POST /api/import/dry-run
 * Explicit dry-run validation endpoint. Guarantees 0 persistent writes.
 *
 * Response shape (additive over existing ImportResult):
 *  - preview: accepted rows with trace ids (rowIndex, fingerprint)
 *  - quarantine: rows rejected by validation with reasons
 *  - rollbackGuidance: operational recovery steps for the caller
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    const contentLength = Number(request.headers.get('content-length') || '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return buildErrorResponse(
        413,
        'PAYLOAD_TOO_LARGE',
        `Dry-run payload exceeds ${MAX_BODY_BYTES} bytes`,
        { maxBytes: MAX_BODY_BYTES }
      );
    }

    const { searchParams } = new URL(request.url);

    let bodyData: unknown;
    let options: ImportOptions = {
      dryRun: true, // Always true for dry-run route
      entityType: normalizeEntityType(searchParams.get('entityType')),
      idompotent: coerceBoolean(searchParams.get('idompotent'), true),
      allowUpdate: coerceBoolean(searchParams.get('allowUpdate'), true),
    };

    if (contentType.includes('application/json')) {
      let json: unknown;
      try {
        json = await request.json();
      } catch {
        return buildErrorResponse(400, 'INVALID_JSON', 'Request body is not valid JSON');
      }

      if (isPlainObject(json) && 'data' in json) {
        bodyData = (json as Record<string, unknown>).data;
        const incomingOptions = (json as Record<string, unknown>).options;
        if (isPlainObject(incomingOptions)) {
          options = {
            ...options,
            ...incomingOptions,
            // Prevent callers from flipping dry-run off via body options.
            dryRun: true,
          } as ImportOptions;
        }
      } else {
        bodyData = json;
      }
    } else if (contentType.includes('text/csv') || contentType.includes('text/plain') || contentType === '') {
      bodyData = await request.text();
    } else {
      return buildErrorResponse(
        415,
        'UNSUPPORTED_CONTENT_TYPE',
        `Unsupported content-type: ${contentType || '(none)'}`,
        { supported: ['application/json', 'text/csv', 'text/plain'] }
      );
    }

    if (bodyData === undefined || bodyData === null) {
      return buildErrorResponse(400, 'EMPTY_BODY', 'Request body is empty');
    }

    const result: ImportResult = runImportPipeline(bodyData, options);

    // Dry-run is always safe: we return a preview of accepted rows,
    // the quarantined rows, and explicit rollback/retry guidance.
    const responseBody = {
      ...result,
      dryRun: true,
      preview: result.preview ?? [],
      quarantine: result.quarantine ?? [],
      rollbackGuidance: result.rollbackGuidance ?? {
        applies: false,
        steps: [],
        retry: {
          safe: true,
          note: 'Dry-run performs no writes; re-submit the same payload to retry.',
        },
      },
    };

    return NextResponse.json(responseBody, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        dryRun: true,
        error: err.message || 'Dry-run validation error',
        code: 'DRY_RUN_FAILED',
      },
      { status: 500 }
    );
  }
}
