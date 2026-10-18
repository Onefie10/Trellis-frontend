import type { TelemetryEvent, TelemetryEventPayload } from './types';

const SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'ssn',
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'ip',
  'ipaddress',
  'wallet',
  'address',
  'publickey',
  'privatekey',
  'name',
  'firstname',
  'lastname',
  'userid',
  'user_id',
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

function scrubString(s: string): string {
  return s.replace(EMAIL_RE, '[redacted]').replace(LONG_BASE64_RE, '[redacted]');
}

/** Remove known sensitive keys and redact obvious PII patterns from strings. */
export function sanitizePayload(
  payload: TelemetryEventPayload | undefined
): TelemetryEventPayload | undefined {
  if (!payload || typeof payload !== 'object') return payload;

  const out: TelemetryEventPayload = {};
  for (const [k, v] of Object.entries(payload)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.has(key)) continue;
    if (typeof v === 'string') {
      (out as Record<string, string>)[k] = scrubString(v);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

import { reviewAndMinimizeMetadata } from './minimizationReview';

/** Apply client-side defense-in-depth and operational metadata minimization before rendering. */
export function sanitizeTelemetryEvent(event: TelemetryEvent): TelemetryEvent {
  const sanitized = {
    ...event,
    payload: sanitizePayload(event.payload),
  };
  const reviewed = reviewAndMinimizeMetadata(sanitized);
  return {
    ...reviewed.event,
    classification: reviewed.classification,
    expiresAt: reviewed.expiresAt,
  };
}
