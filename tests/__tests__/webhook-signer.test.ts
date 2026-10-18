import {
  signWebhookPayload,
  generateWebhookSecret,
  formatWebhookPayload,
  dispatchWebhookPayload,
  WebhookEndpoint,
} from '../../lib/webhooks';
import crypto from 'crypto';

describe('Webhook Signer and HMAC Generation', () => {
  const sampleSecret = 'secret_key_1234567890_test_hmac';
  const samplePayload = {
    event: 'new_proposal',
    proposalId: 'prop_999',
    amount: '5000 XLM',
  };

  describe('signWebhookPayload', () => {
    it('generates valid HMAC-SHA256 signature prefixed with sha256=', () => {
      const payloadString = JSON.stringify(samplePayload);
      const signature = signWebhookPayload(payloadString, sampleSecret);

      expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify manually with Node crypto
      const expectedHmac = crypto
        .createHmac('sha256', sampleSecret)
        .update(payloadString)
        .digest('hex');

      expect(signature).toBe(`sha256=${expectedHmac}`);
    });

    it('accepts object input directly and converts to JSON string', () => {
      const signatureFromObj = signWebhookPayload(samplePayload, sampleSecret);
      const signatureFromStr = signWebhookPayload(JSON.stringify(samplePayload), sampleSecret);

      expect(signatureFromObj).toBe(signatureFromStr);
    });

    it('produces different signatures for different secrets', () => {
      const sig1 = signWebhookPayload(samplePayload, 'secret_a');
      const sig2 = signWebhookPayload(samplePayload, 'secret_b');

      expect(sig1).not.toBe(sig2);
    });

    it('produces different signatures for different payloads', () => {
      const sig1 = signWebhookPayload({ data: 'a' }, sampleSecret);
      const sig2 = signWebhookPayload({ data: 'b' }, sampleSecret);

      expect(sig1).not.toBe(sig2);
    });

    it('returns empty string if secret is empty', () => {
      expect(signWebhookPayload(samplePayload, '')).toBe('');
    });
  });

  describe('generateWebhookSecret', () => {
    it('generates a 32-character hex secret string', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  describe('formatWebhookPayload', () => {
    it('formats JSON payload with platform metadata and event type', () => {
      const payload = formatWebhookPayload('agent_minted', { agentId: 'ag_777', name: 'AlphaAgent' });

      expect(payload).toHaveProperty('id');
      expect(payload.event).toBe('agent_minted');
      expect(payload.data.agentId).toBe('ag_777');
      expect(payload.data.platform).toBe('Trellis Stellar Agent Platform');
      expect(new Date(payload.timestamp).getTime()).not.toBeNaN();
    });
  });

  describe('dispatchWebhookPayload', () => {
    const mockEndpoint: WebhookEndpoint = {
      id: 'wh_1',
      name: 'Test Endpoint',
      url: 'https://example.com/webhook',
      secret: sampleSecret,
      enabled: true,
      triggers: ['new_proposal', 'high_error_rate', 'payout_executed', 'agent_minted'],
      createdAt: new Date().toISOString(),
    };

    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
      } as any);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('sends HTTP POST request with X-Trellis-Signature and X-Trellis-Event headers', async () => {
      const res = await dispatchWebhookPayload(mockEndpoint, 'payout_executed', { amount: '1000 XLM' });

      expect(res.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Trellis-Event': 'payout_executed',
          }),
        })
      );

      // Verify the signature header sent in fetch call
      const fetchCallArgs = (global.fetch as jest.Mock).mock.calls[0];
      const headers = fetchCallArgs[1].headers;
      const body = fetchCallArgs[1].body;
      const expectedSignature = signWebhookPayload(body, sampleSecret);

      expect(headers['X-Trellis-Signature']).toBe(expectedSignature);
    });

    it('returns failure if endpoint is disabled', async () => {
      const disabledEndpoint = { ...mockEndpoint, enabled: false };
      const res = await dispatchWebhookPayload(disabledEndpoint, 'new_proposal', {});

      expect(res.success).toBe(false);
      expect(res.error).toContain('disabled');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns failure if trigger event is not enabled for endpoint', async () => {
      const restrictedEndpoint = { ...mockEndpoint, triggers: ['agent_minted' as const] };
      const res = await dispatchWebhookPayload(restrictedEndpoint, 'new_proposal', {});

      expect(res.success).toBe(false);
      expect(res.error).toContain('disabled');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
