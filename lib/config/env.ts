import { z } from 'zod';

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const environmentSchema = z.enum(['development', 'staging', 'production']);
const networkSchema = z.enum(['testnet', 'mainnet']);

const rawEnvironmentSchema = z.object({
  NEXT_PUBLIC_ENVIRONMENT: environmentSchema,
  NEXT_PUBLIC_API_URL: z.string().trim().url(),
  NEXT_PUBLIC_STELLAR_NETWORK: networkSchema,
  NEXT_PUBLIC_ENABLE_BETA_FEATURES: booleanFlag.optional().default(false),
  WEBHOOK_SECRET: z.string().optional(),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;
export type StellarNetwork = z.infer<typeof networkSchema>;

export interface AppConfig {
  environment: AppEnvironment;
  apiUrl: URL;
  stellarNetwork: StellarNetwork;
  enableBetaFeatures: boolean;
}

const DEVELOPMENT_SECRET_PATTERNS = [/^your[_-]/i, /^change[_-]?me/i, /^example/i, /^placeholder/i, /^secret$/i];

const SECRET_MASK = '[SECRET_MASKED]';
const SECRET_KEY_PATTERN = /(secret|token|key|password|passwd|credential|authorization|bearer|webhook)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk(?:_live|_test)?_[A-Za-z0-9]{8}+\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=]{8,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** Mask sensitive tokens in a string so it is safe to emit in client logs and error traces. */
export function sanitizeSecret(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, SECRET_MASK);
  }
  return result;
}

/** Recursively sanitize an arbitrary value (error, object, string) for safe logging. */
export function sanitizeForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return sanitizeSecret(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.ade(value as object);
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeSecret(value.message), stack: value.stack ? sanitizeSecret(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? SECRET_MASK : sanitizeForLog(entry, seen);
  }
  return output;
}

export interface SecretAuditFinding {
  variable: string;
  reason: string;
}

/** Audit environment variables for weak or default development secrets. */
export function auditEnvironmentSecrets(source: NodeJS.ProcessEnv): SecretAuditFinding[] {
  const findings: SecretAuditFinding[] = [];
  for (const [key, rawValue] of Object.entries(source)) {
    if (!SECRET_KEY_PATTERN.test(key) || !rawValue) continue;
    const value = rawValue.trim();
    if (value.length < 32) {
      findings.push({ variable: key, reason: 'Secret is shorter than 32 characters.' });
    }
    if (DEVELOPMENT_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      findings.push({ variable: key, reason: 'Secret matches a placeholder or default development pattern.' });
    }
  }
  return findings;
}

type RotationListener = (config: AppConfig) => void;
const rotationListeners = new Set<RotationListener>();
let currentConfig: AppConfig | null = null;

/** Subscribe to runtime secret rotation updates. Returns an unsubscribe function. */
export function onSecretRotation(listener: RotationListener): () => void {
  rotationListeners.add(listener);
  return () => {
    rotationListeners.delete(listener);
  };
}

/** Re-read dynamic environment configuration and notify listeners without a rebuild. */
export function rotateSecrets(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = parseAppConfig(source);
  currentConfig = config;
  for (const listener of rotationListeners) {
    try {
      listener(config);
    } catch {
      // Listener failures must not break rotation for other subscribers.
    }
  }
  return config;
}

/** Parse and validate the public app configuration without ever including values in errors. */
export function parseAppConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = rawEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map(({ path, message }) => `  - ${String(path[0])}: ${message}`);
    throw new Error(`Invalid application configuration:\n${details.join('\n')}`);
  }

  const values = parsed.data;
  const problems: string[] = [];
  const apiUrl = new URL(values.NEXT_PUBLIC_API_URL);
  const isLocalApi = apiUrl.hostname === 'localhost' || apiUrl.hostname === '127.0.0.1' || apiUrl.hostname === '::1';

  if (values.NEXT_PUBLIC_ENVIRONMENT === 'production' && apiUrl.protocol !== 'https:') {
    problems.push('NEXT_PUBLIC_API_URL must use HTTPS in production.');
  }
  if (!isLocalApi && apiUrl.protocol !== 'https:') {
    problems.push('NEXT_PUBLIC_API_URL must use HTTPS outside local development.');
  }
  if (values.NEXT_PUBLIC_ENVIRONMENT !== 'development' && isLocalApi) {
    problems.push('NEXT_PUBLIC_API_URL cannot point to localhost outside development.');
  }
  if (values.NEXT_PUBLIC_ENVIRONMENT !== 'development' && values.NEXT_PUBLIC_STELLAR_NETWORK === 'testnet') {
    problems.push('NEXT_PUBLIC_STELLAR_NETWORK must be mainnet outside development.');
  }

  const webhookSecret = values.WEBHOOK_SECRET.trim();
  if (webhookSecret && (webhookSecret.length < 32 || DEVELOPMENT_SECRET_PATTERNS.some((pattern) => pattern.test(webhookSecret)))) {
    problems.push('WEBHOOK_SECRET must be a non-placeholder secret of at least 32 characters.');
  }
  if (values.NEXT_PUBLIC_ENVIRONMENT === 'development' && webhookSecret && /^(prod|production|live)[-_]/i.test(webhookSecret)) {
    problems.push('WEBHOOK_SECRET appears production-like and cannot be used in development.');
  }

  if (problems.length) throw new Error(`Invalid application configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);

  return {
    environment: values.NEXT_PUBLIC_ENVIRONMENT,
    apiUrl,
    stellarNetwork: values.NEXT_PUBLIC_STELLAR_NETWORK,
    enableBetaFeatures: values.NEXT_PUBLIC_ENABLE_BETA_FEATURES,
  };
}

export function getAppConfig(): AppConfig {
  if (!currentConfig) currentConfig = parseAppConfig(process.env);
  return currentConfig;
}
