import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as importPOST } from '../route';
import { POST as dryRunPOST } from '../dry-run/route';
import type { ImportResult } from '@/lib/import/types';

const originalFetch = global.fetch;

function makeRequest(body: unknown, opts: { contentType?: string; url?: string; accept?: string } = {}): NextRequest {
  const url = opts.url ?? 'http://localhost/api/import';
  const contentType = opts.contentType ?? 'application/json';
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': contentType },
  };
  if (opts.accept) {
    (init.headers as Record<string, string>).Accept = opts.accept;
  }
  if (typeof body === 'string') {
    init.body = body;
  } else {
    init.body = JSON.stringify(body);
  }
  return new NextRequest(url, init) as unknown as NextRequest;
}

describe('Import Pipeline API', () => {
  beforeEach(() => {
    vi.stub(global, 'fetch', async () => {
      throw new Error('fetch should not be called in this test');
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('POST /api/import', () => {
    it('returns 200 and an ImportResult for a valid JSON payload', async () => {
      const payload = [
        { id: 'agent-101', name: 'Yield Optimizer', description: 'Automated liquidity and yield management agent.', category: 'trading', price: 50, version: '1.0.0' },
        { id: 'agent-102', name: 'Governance Oracle', description: 'Monitors voting proposals on Soroban', category: 'governance', price: 25, version: '1.1.0' },
      ];
      const req = makeRequest(payload, { url: 'http://localhost/api/import?entityType=agents&dryRun=false' });
      const res = await importPOST(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ImportResult;
      expect(json.success).toBe(true);
      expect(json.summary).defined;
      expect(json.summary.createCount).toBeGreaterThanOrEqual(0);
    });

    it('returns 422 when rows fail validation', async () => {
      const payload = [
        { id: '', name: '', description: 'x', category: 'trading', price: -1, version: 'bad' },
      ];
      const req = makeRequest(payload, { url: 'http://localhost/api/import?entityType=agents&dryRun=false' });
      const res = await importPOST(req);
      expect(res.status).toBe(422);
      const json = (await res.json()) as ImportResult;
      expect(json.success).toBe(false);
      expect(json.summary.errorCount).toBe(1);
    });

    it('quarantines unsafe rows and keeps them out of applied records', async () => {
      const payload = [
        { id: 'agent-200', name: 'Safe', description: 'ok', category: 'trading', price: 10, version: '1.0.0' },
        { id: 'agent-201', name: 'Unsafe', description: 'ok', category: 'trading', price: -1, version: '1.0.0' },
      ];
      const req = makeRequest(payload, { url: 'http://localhost/api/import?entityType=agents&dryRun=false' });
      const res = await importPOST(req);
      const json = (await res.json()) as ImportResult;
      expect(json.quarantined).defined;
      expect(json.quarantined.length).toBeGreaterThan(0);
      expect(json.appliedRecords.every(row => row.id !== 'agent-201')).toBe(true);
    });

    it('returns rollback guidance with compensation steps', async () => {
      const payload = [
        { id: 'agent-300', name: 'Rollback', description: 'ok', category: 'trading', price: 10, version: '1.0.0' },
      ];
      const req = makeRequest(payload, { url: 'http://localhost/api/import?entityType=agents&dryRun=false' });
      const res = await importPOST(req);
      const json = (await res.json()) as ImportResult;
      expect(json.rollbackGuidance).toBeDefined();
      expect(json.rollbackGuidance.compensationSteps.length).toBeGreaterThan(0);
    });

    it('previews imports with dryRun true and does not apply writes', async () => {
      const payload = [
        { id: 'agent-400', name: 'Preview', description: 'ok', category: 'trading', price: 10, version: '1.0.0' },
      ];
      const req = makeRequest(payload, { url: 'http://localhost/api/import?entityType=agents&dryRun=true' });
      const res = await importPOST(req);
      const json = (await res.json()) as ImportResult;
      expect(json.dryRun).toBe(true);
      expect(json.appliedRecords.length).toBe(0);
    });

    it('supports CSV bodies', async () => {
      const csv = 'id,name,description,category,price,version\nagent-500,CSV Agent,okk,trading,10,1.0.0';
      const req = makeRequest(csv, { contentType: 'text/csv', url: 'http://localhost/api/import?entityType=agents&dryRun=true' });
      const res = await importPOST(req);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/import/dry-run', () => {
    it('always forces dryRun to true', async () => {
      const payload = [
        { id: 'agent-600', name: 'Dry', description: 'ok', category: 'trading', price: 10, version: '1.0.0' },
      ];
      const req = makeRequest({ data: payload, options: { dryRun: false } }, { url: 'http://localhost/api/import/dry-run?entityType=agents' });
      const res = await dryRunPOST(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ImportResult;
      expect(json.dryRun).toBe(true);
      expect(json.appliedRecords.length).toBe(0);
    });

    it('returns 200 even when rows are invalid (dry-run is non-mutating)', async () => {
      const payload = [
        { id: '', name: '', description: 'x', category: 'trading', price: -1, version: 'bad' },
      ];
      const req = makeRequest(payload, { url: 'http://localhost/api/import/dry-run?entityType=agents' });
      const res = await dryRunPOST(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as ImportResult;
      expect(json.summary.errorCount).toBe(1);
    });
  });
});
