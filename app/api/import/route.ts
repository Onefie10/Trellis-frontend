import { NextRequest, NextResponse } from 'next/server';
import { runImportPipeline } from '@/lib/import/pipeline';
import { ImportOptions } from '@/lib/import/types';
import { runImportPipelineWithProgress } from '@/lib/import/stream';
import { checkRateLimit, createRateLimitResponse } from '@/lib/security/rate-limit';
import { csrfMiddleware } from '@/lib/security/csrf';

const IMPORT_RATE_LIMIT = { maxRequests: 10, windowMs: 15 * 60 * 1000, scope: 'import' };

/**
 * POST /api/import
 * Execute bulk import pipeline with validation, idempotency, duplicate detection, and rollback guidance.
 */
export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  const rl = checkRateLimit(request, IMPORT_RATE_LIMIT);
  if (rl.blocked) {
    return createRateLimitResponse(rl, 'Import rate limit exceeded. Please try again later.');
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    const { searchParams } = new URL(request.url);
    const dryRunParam = searchParams.get('dryRun');

    let bodyData: any;
    let options: ImportOptions = {
      dryRun: dryRunParam !== null ? dryRunParam === 'true' : false,
      entityType: (searchParams.get('entityType') as any) || 'general',
      idempotent: searchParams.get('idempotent') !== 'false',
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

    const wantsStream = request.headers.get('accept')?.includes('text/event-stream') || searchParams.get('stream') === 'true';
    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          send('start', { total: typeof bodyData === 'string' ? Math.max(0, bodyData.trim().split(/\r?\n/).length - 1) : bodyData.length });
          try {
            const result = await runImportPipelineWithProgress(bodyData, options, (progress) => send('progress', progress), request.signal);
            send(result.cancelled ? 'cancelled' : 'complete', result);
          } catch (error) {
            send('error', { message: error instanceof Error ? error.message : 'Import failed' });
          } finally { controller.close(); }
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
    }

    const result = runImportPipeline(bodyData, options);
    const statusCode = result.success ? 200 : 422;

    return NextResponse.json(result, { status: statusCode });
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
