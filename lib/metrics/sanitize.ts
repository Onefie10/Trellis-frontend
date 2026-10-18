const SENSITIVE_LABEL_KEYS = new Set([
  // Common PII keys
  'email',
  'phone',
  'ssn',
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'userid',
  'user_id',
  'username',
  'name',
  'firstname',
  'lastname',
  // Infra keys that often embed IPs/hostnames (treated as sensitive for this UI)
  'ip',
  'ipaddress',
  'instance',
  'host',
  'hostname',
  'node',
  'pod',
  'container',
  // Wallet / keys
  'wallet',
  'address',
  'publickey',
  'privatekey',
  'account',
  'sourceaccount',
  'source_account',
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
// Stellar public keys are typically G + 55 chars of base32 (A-Z2-7)
const STELLAR_G_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const NUMERIC_SEGMENT_RE = /(^|\/)[0-9]{3,}(?=\/|$)/g;
const SAFE_LABEL_KEYS = new Set([
  'job', 'env', 'environment', 'service', 'method', 'status', 'route', 'le',
  'type', 'severity', 'taskkind', 'state', 'code',
]);
const MAX_LABELS = 6;
const MAX_LABEL_VALUE_LENGTH = 80;

function scrubString(s: string): string {
  return s
    .replace(EMAIL_RE, '[redacted]')
    .replace(IPV4_RE, '[redacted]')
    .replace(STELLAR_G_ADDRESS_RE, '[redacted]')
    .replace(UUID_RE, '[redacted]')
    .replace(LONG_BASE64_RE, '[redacted]');
}

function normalizeLabelValue(key: string, value: string): string | undefined {
  const routeTemplate = key === 'route'
    ? value.replace(UUID_RE, ':param').replace(NUMERIC_SEGMENT_RE, '$1:param')
    : value;
  const cleaned = scrubString(routeTemplate).trim();
  if (!cleaned || cleaned.length > MAX_LABEL_VALUE_LENGTH || /[\r\n\0]/.test(cleaned)) return undefined;
  if (key === 'method' && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(cleaned)) return undefined;
  if (key === 'status' && !/^(1xx|2xx|3xx|4xx|5xx|[1-5][0-9]{2})$/i.test(cleaned)) return undefined;
  if (key === 'severity' && !/^(debug|info|warn|error|critical)$/i.test(cleaned)) return undefined;
  if (key === 'state' && !/^(ok|success|succeeded|failed|error|pending|cancelled|canceled|timeout|timed_out|healthy|unhealthy)$/i.test(cleaned)) return undefined;
  if (key === 'route') {
    // Keep route templates useful while collapsing common request-specific path segments.
    return cleaned;
  }
  // Prometheus histogram buckets are numeric or +Inf. Other labels remain bounded
  // by the allow-list, value length limit, and per-query series ceiling.
  if (key === 'le' && !/^(?:\+Inf|Inf|-?\d+(?:\.\d+)?)$/.test(cleaned)) return undefined;
  return cleaned;
}

export function sanitizeLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const key = k.toLowerCase();
    if (SENSITIVE_LABEL_KEYS.has(key) || !SAFE_LABEL_KEYS.has(key) || Object.keys(out).length >= MAX_LABELS) continue;
    if (typeof v !== 'string') continue;
    const safeValue = normalizeLabelValue(key, v);
    if (safeValue !== undefined) out[k] = safeValue;
  }
  return out;
}

export function labelsToSeriesName(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 6);
  if (entries.length === 0) return 'total';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

