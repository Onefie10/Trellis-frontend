import crypto from 'crypto';
import { API_CONTRACTS, validateContractSchema } from '@/lib/api-contracts/schemas';
import {
  __resetProcessedWebhooks,
  DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES,
  verifyWebhook,
} from '@/lib/notifications/webhook';
import corpus from '../fixtures/external-payloads/corpus.json';

const SECRET = 'fixture-only-secret';
const goldenCorpus = corpus as unknown as {
  webhookCases: Array<{
    name: string;
    payload?: string;
    payloadBytes?: number;
    headers: Record<string, string>;
    expectedCode: string;
  }>;
  replayCase: {
    name: string;
    payload: string;
    headers: Record<string, string>;
    expectedSequence: string[];
  };
  schemaDriftCase: {
    name: string;
    contract: keyof typeof API_CONTRACTS;
    response: unknown;
    expectedValid: boolean;
  };
};

function createHeaders(raw: Record<string, string>, payload: string): Headers {
  const headers = new Headers();
  const now = Date.now().toString();
  for (const [name, rawValue] of Object.entries(raw)) {
    let value = rawValue.replace('{{now}}', now);
    if (value === '{{valid}}') value = crypto.createHmac('sha256', SECRET).update(`${now}.${payload}`).digest('hex');
    if (value === '{{longEventId}}') value = 'e'.repeat(201);
    headers.set(name, value);
  }
  return headers;
}

describe('external payload golden corpus', () => {
  beforeEach(() => __resetProcessedWebhooks());

  it.each(goldenCorpus.webhookCases)('rejects $name', (fixture) => {
    const payload = fixture.payload ?? 'x'.repeat(fixture.payloadBytes ?? 0);
    const result = verifyWebhook(payload, createHeaders(fixture.headers, payload), { secret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.code).toBe(fixture.expectedCode);
    if (fixture.payloadBytes) expect(Buffer.byteLength(payload)).toBeGreaterThan(DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES);
  });

  it('rejects a verified event replay', () => {
    const fixture = goldenCorpus.replayCase;
    const payload = fixture.payload;
    const headers = createHeaders(fixture.headers, payload);
    const first = verifyWebhook(payload, headers, { secret: SECRET });
    const second = verifyWebhook(payload, headers, { secret: SECRET });
    expect(first.valid ? 'valid' : first.code).toBe(fixture.expectedSequence[0]);
    expect(second.valid ? 'valid' : second.code).toBe(fixture.expectedSequence[1]);
  });

  it('detects response schema drift', () => {
    const fixture = goldenCorpus.schemaDriftCase;
    const result = validateContractSchema(fixture.response, API_CONTRACTS[fixture.contract].responseSchema);
    expect(result.valid).toBe(fixture.expectedValid);
    expect(result.errors).toContain('panels: Required');
  });
});
