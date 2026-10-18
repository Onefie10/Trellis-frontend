import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export interface ApiContractDefinition {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description: string;
  authRequired: boolean;
  queryParams?: Record<string, { type: string; required: boolean; description: string }>;
  requestSchema?: z.ZodTypeAny;
  responseSchema: z.ZodTypeAny;
  errorResponses: Record<number, { code: string; message: string }>;
}

export const API_CONTRACTS: Record<string, ApiContractDefinition> = {
  'GET /api/affiliates': {
    path: '/api/affiliates',
    method: 'GET',
    description: 'Lists all available affiliate endpoints and documentation overview',
    authRequired: false,
    responseSchema: z.object({
      message: z.string(),
      endpoints: z.record(z.string(), z.string()),
    }).openapi('AffiliatesResponse'),
    errorResponses: {
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'GET /api/affiliates/program': {
    path: '/api/affiliates/program',
    method: 'GET',
    description: 'Fetches affiliate program tier rules and commission structures',
    authRequired: false,
    responseSchema: z.object({
      tiers: z.array(z.any()),
      cookieDurationDays: z.number(),
    }).openapi('AffiliatesProgramResponse'),
    errorResponses: {
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'GET /api/metrics/panels': {
    path: '/api/metrics/panels',
    method: 'GET',
    description: 'Lists all available metrics monitoring panels',
    authRequired: false,
    responseSchema: z.object({
      source: z.string(),
      panels: z.array(z.any()),
    }).openapi('MetricsPanelsResponse'),
    errorResponses: {
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'POST /api/import/dry-run': {
    path: '/api/import/dry-run',
    method: 'POST',
    description: 'Validates bulk import datasets without persistent writes',
    authRequired: false,
    queryParams: {
      entityType: { type: 'string', required: false, description: 'Target entity type' },
    },
    responseSchema: z.object({
      success: z.boolean(),
      dryRun: z.boolean(),
      entityType: z.string(),
      summary: z.object({
        totalRows: z.number(),
        validRows: z.number(),
        invalidRows: z.number(),
        createCount: z.number(),
        updateCount: z.number(),
        skipCount: z.number(),
        errorCount: z.number(),
        duplicateCount: z.number(),
      }).partial(),
      rows: z.array(z.any()),
    }).openapi('DryRunResponse'),
    errorResponses: {
      422: { code: 'VALIDATION_FAILED', message: 'Input rows failed validation rules' },
      500: { code: 'INTERNAL_ERROR', message: 'Dry run processing error' },
    },
  },
};

/**
 * Validate that an object adheres to a contract schema specification.
 * Returns true if valid, or an array of error messages.
 */
export function validateContractSchema(data: any, schema: z.ZodTypeAny): { valid: boolean; errors: string[] } {
  const result = schema.safeParse(data);
  return {
    valid: result.success,
    errors: result.success ? [] : result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
  };
}
