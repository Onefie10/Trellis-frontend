import crypto from 'crypto';
import { isFieldSafe } from './metric-definitions';

export type WebhookEventTrigger = 'new_proposal' | 'high_error_rate' | 'payout_executed' | 'agent_minted';

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  secret: string;
  enabled: boolean;
  triggers: WebhookEventTrigger[];
  createdAt: string;
  lastTriggeredAt?: string;
  lastStatus?: 'success' | 'failed';
}

export interface EmailDigestPreferences {
  enabled: boolean;
  email: string;
  frequency: 'daily' | 'weekly' | 'realtime';
  triggers: {
    newProposal: boolean;
    highErrorRate: boolean;
    payoutExecuted: boolean;
    agentMinted: boolean;
  };
}

/**
 * Recursively remove fields that are outside the platform's sensitive-data
 * boundary before an event is serialized for a third-party webhook.
 * Cycles and values deeper than eight levels are omitted so malformed input
 * cannot make dispatch fail while building its body.
 */
export function sanitizeWebhookData(data: Record<string, any>): Record<string, any> {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'object' || depth > 8 || seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => visit(item, depth + 1)).filter((item) => item !== undefined);
    }

    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!isFieldSafe(key)) continue;
      const sanitized = visit(nested, depth + 1);
      if (sanitized !== undefined) safe[key] = sanitized;
    }
    return safe;
  };

  return (visit(data, 0) as Record<string, any> | undefined) ?? {};
}

/**
 * Sign a webhook payload string or object using HMAC-SHA256 and return hex header format (sha256=<hex>)
 */
export function signWebhookPayload(payload: string | object, secret: string): string {
  if (!secret) return '';
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Generate a random 32-character hex secret key for webhook HMAC verification
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Build standard JSON payload structure for outbound webhooks
 */
export function formatWebhookPayload(event: WebhookEventTrigger, data: Record<string, any>): Record<string, any> {
  return {
    id: `wh_evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    event,
    timestamp: new Date().toISOString(),
    data: {
      ...sanitizeWebhookData(data),
      platform: 'Trellis Stellar Agent Platform',
    },
  };
}

/**
 * Send an outbound signed webhook HTTP POST request to target endpoint
 */
export async function dispatchWebhookPayload(
  endpoint: WebhookEndpoint,
  event: WebhookEventTrigger,
  data: Record<string, any>
): Promise<{ success: boolean; status?: number; error?: string }> {
  if (!endpoint.enabled || !endpoint.triggers.includes(event)) {
    return { success: false, error: 'Endpoint or event trigger disabled' };
  }

  const payload = formatWebhookPayload(event, data);
  const payloadString = JSON.stringify(payload);
  const signature = signWebhookPayload(payloadString, endpoint.secret);

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trellis-Signature': signature,
        'X-Trellis-Event': event,
        'User-Agent': 'Trellis-Webhook-Dispatcher/1.0',
      },
      body: payloadString,
    });

    if (response.ok) {
      return { success: true, status: response.status };
    } else {
      return {
        success: false,
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Network error during webhook dispatch',
    };
  }
}
