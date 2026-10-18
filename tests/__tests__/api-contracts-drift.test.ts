import { z } from 'zod';
import { API_CONTRACTS, validateContractSchema } from '@/lib/api-contracts/schemas';
import { GET as getAffiliates } from '@/app/api/affiliates/route';
import { GET as getAffiliatesProgram } from '@/app/api/affiliates/program/route';
import { GET as getMetricsPanels } from '@/app/api/metrics/panels/route';
import { POST as postDryRun } from '@/app/api/import/dry-run/route';
import { NextRequest } from 'next/server';

describe('Public API Contract Drift Tests (Issue #39)', () => {
  it('GET /api/affiliates satisfies contract schema', async () => {
    const contract = API_CONTRACTS['GET /api/affiliates'];
    const req = new NextRequest('http://localhost:3000/api/affiliates');
    const response = await getAffiliates(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    const validation = validateContractSchema(data, contract.responseSchema);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(data.endpoints).toBeDefined();
  });

  it('GET /api/affiliates/program satisfies contract schema', async () => {
    const contract = API_CONTRACTS['GET /api/affiliates/program'];
    const response = await getAffiliatesProgram();
    const data = await response.json();

    expect(response.status).toBe(200);
    const validation = validateContractSchema(data, contract.responseSchema);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(Array.isArray(data.tiers)).toBe(true);
  });

  it('GET /api/metrics/panels satisfies contract schema', async () => {
    const contract = API_CONTRACTS['GET /api/metrics/panels'];
    const response = await getMetricsPanels();
    const data = await response.json();

    expect(response.status).toBe(200);
    const validation = validateContractSchema(data, contract.responseSchema);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(data.source).toBeDefined();
    expect(Array.isArray(data.panels)).toBe(true);
  });

  it('POST /api/import/dry-run satisfies contract schema', async () => {
    const contract = API_CONTRACTS['POST /api/import/dry-run'];
    const payload = JSON.stringify([
      { id: 'ag-1', name: 'Contract Test Agent', description: 'Agent description' },
    ]);
    const req = new NextRequest('http://localhost:3000/api/import/dry-run?entityType=agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const response = await postDryRun(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    const validation = validateContractSchema(data, contract.responseSchema);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(data.dryRun).toBe(true);
    expect(data.summary.totalRows).toBe(1);
  });

  it('detects schema drift on modified responses', () => {
    const fakeSchema = z.object({
      nonExistentField: z.string(),
      anotherMissing: z.string(),
    });
    const testData = { message: 'hello' };
    const validation = validateContractSchema(testData, fakeSchema);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBe(2);
  });
});
