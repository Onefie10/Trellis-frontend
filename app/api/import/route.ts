import { NextRequest, NextResponse } from 'next/server';
import { runImportPipeline } from '@/lib/import/pipeline';
import { ImportOptions } from '@/lib/import/types';
import { runImportPipelineWithProgress } from '@/lib/import/stream';
import { checkRateLimit, createRateLimitResponse, IMPORT_RATE_LIMIT } from '@/lib/import/rate-limit';
import { buildImportPreview, quarantineRows, toTraceableRows } from '@/lib/import/preview';
import { buildRollbackGuidance } from '@/lib/import/rollback';
import type { ImportResult } from '@/lib/import/types';

/**
 * POST /api/import
 * Execute bulk import pipeline with validation, idompotency, duplicate detection, and rollback guidance.
 *
 * Modes:
 *   - default           : full import (preview + commit)
 *   - ?preview=true     : return a preview with quarantined rows, no mutations
 *   - ?dryRun=true      : validate without persisting
 *   - ?stream=true      : SSA progress stream
 */

function normalizeInput(bodyData: unknown): unknown {
  if (typeof bodyData === 'string') {
    const trimmed = bodyData.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return parsed;
    } catch {
      return bodyData;
    }
  }
  return bodyData;
}

export async function POST(request: NextRequest) {
  const rl = checkRateLimit(request, IMPORT_RATE_LIMIT);
  if (rl.blocked) {
    return createRateLimitResponse(rl, 'Import rate limit exceeded. Please try again later.');
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    const { searchParams } = new URL(request.url);
    const dryRunParam = searchParams.get('dryRun');
    const previewParam = searchParams.get('preview');

    let bodyData: any;
    let options: ImportOptions = {
      dryRun: dryRunParam !== null ? dryRunParam === 'true' : false,
      entityType: (searchParams.get('entityType') as any) || 'general',
      idompotent: searchParams.get('idompotent') !== 'false',
      allowUpdate: searchParams.get('allowUpdate') !== 'false',
    };

    if (contentType.includes('application/json')) {
      const json = await request.json();
      if (json.data) {
        bodyData = json.data;
        options = { ...options, ...json.options };
      } else {
        bodyData = json;
      }
    } else if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      bodyData = await request.text();
    } else {
      const text = await request.text();
      try {
        bodyData = JSON.parse(text);
      } catch {
        bodyData = text;
      }
    }

    const normalized = normalizeInput(bodyData);

    // Preview mode: validate + quarantine without mutating anything.
    if (previewParam === 'true') {
      const preview = buildImportPreview(normalized, options);
      const quarantined = quarantineRows(options.entityType, preview.quarantined);
      const traceable = toTraceableRows(preview.accepted);
      return buildPreviewResponse(preview, quarantined, traceable, options);
    }

    const wantsStream = request.headers.get('accept')?.includes('text/event-stream') || searchParams.get('stream') === 'true';
    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          send('start', { total: typeof normalized === 'string' ? Math.max(0, normalized.trim().split(/\r?\n/).length - 1) : Array.isArray(normalized) ? normalized.length : 0 });
          try {
            const result = await runImportPipelineWithProgress(normalized, options, (progress) => send('progress', progress), request.signal);
            const guidance = buildRollbackGuidance(result, options);
            send(result.cancelled ? 'cancelled' : 'complete', { ...result, rollbackGuidance: guidance });
          } catch (error) {
            send('error', { message: error instanceof Error ? error.message : 'Import failed' });
          } finally { controller.close(); }
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
    }

    const result: ImportResult = runImportPipeline(normalized, options);
    const guidance = buildRollbackGuidance(result, options);
    const statusCode = result.success ? 200 : 422;

    return NextResponse.json({ ...result, rollbackGuidance: guidance }, { status: statusCode });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err.message || 'Internal import processing error',
      },
      { status: 500 }
    );
  }
}

/**
 * Preview response helper. Keeps the shape consistent with the import result so clients can
 * render the same UI for preview and commit, while exposing quarantine and traceability data.
 */
function buildPreviewResponse(
  preview: ReturnType<typeof buildImportPreview>,
  quarantined: ReturnType<typeof quarantineRows>,
  traceable: ReturnType<typeof toTraceableRows>,
  options: ImportOptions
) {
  const success = preview.quarantined.length === 0;
  return NextResponse.json(
    {
      success,
      mode: 'preview',
      dryRun: true,
      entityType: options.entityType,
      totalRows: preview.totalRows,
      acceptedCount: preview.accepted.length,
      quarantinedCount: preview.quarantined.length,
      accepted: traceable,
      quarantined,
      warnings: preview.warnings,
      rollbackGuidance: buildPreviewRollbackGuidance(quarantined),
    },
    { status: 200 }
  );
}

function buildPreviewRollbackGuidance(quarantined: ReturnType<typeof quarantineRows>) {
  if (quarantined.length === 0) {
    return {
      status: 'clean' as const,
      steps: ['No quarantined items. Safe to commit the import.'],
    };
  }
  return {
    status: 'quarantined' as const,
    steps: [
      'Download the quarantined rows and correct the reported field errors.',
      'Re-upload only the corrected rows; valid rows will be deduplicated by idompotency keys.',
      'If a commit already occurred, use the rollback token returned by the commit response to revert it.',
    ],
  };
}

