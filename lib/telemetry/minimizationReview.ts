/**
 * Operational Metadata Minimization Reviewer
 *
 * Enforces data minimization review on operational metadata:
 * - Classifies telemetry events based on payload and severity.
 * - Enforces field-level classification policies.
 * - Strips unnecessary/unrecognized fields to guarantee least-privilege schemas.
 * - Redacts detected PII/secrets or drops restricted attributes.
 * - Assigns retention expiration timestamps.
 */

import type { TelemetryEvent, TelemetryEventPayload } from './types';
import type {
  MetadataClassification,
  MinimizationReviewResult,
  RetentionPolicy,
} from './retentionTypes';

/**
 * Standard retention policies per classification tier.
 * PUBLIC: 30 days (default client session/audit window)
 * OPERATIONAL: 7 days
 * SENSITIVE: 24 hours (errors/diagnostics)
 * RESTRICTED: 0 ms (immediate purge / not stored)
 */
export const DEFAULT_RETENTION_POLICIES: Record<MetadataClassification, RetentionPolicy> = {
  PUBLIC: {
    classification: 'PUBLIC',
    retentionWindowMs: 30 * 24 * 60 * 60 * 1000,
    maxEntries: 1000,
  },
  OPERATIONAL: {
    classification: 'OPERATIONAL',
    retentionWindowMs: 7 * 24 * 60 * 60 * 1000,
    maxEntries: 500,
  },
  SENSITIVE: {
    classification: 'SENSITIVE',
    retentionWindowMs: 24 * 60 * 60 * 1000,
    maxEntries: 200,
  },
  RESTRICTED: {
    classification: 'RESTRICTED',
    retentionWindowMs: 0,
    maxEntries: 0,
  },
};

/**
 * Allowed known payload fields according to the telemetry event contract.
 * Any operational metadata field not on this list is deemed unnecessary and removed.
 */
export const ALLOWED_PAYLOAD_FIELDS = new Set<string>([
  'correlationId',
  'taskKind',
  'state',
  'code',
  'message',
]);

const RESTRICTED_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api_?key/i,
  /auth/i,
  /bearer/i,
  /cookie/i,
  /ssn/i,
  /private_?key/i,
  /seed/i,
  /mnemonic/i,
  /credit_?card/i,
  /cvv/i,
  /wallet.*key/i,
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z0-9]{55}\b/g;

/**
 * Classifies a telemetry event based on its contents, severity, and event type.
 */
export function classifyMetadata(event: TelemetryEvent): MetadataClassification {
  // If severity is critical or error, or event type is error, classify as SENSITIVE
  if (
    event.type === 'error' ||
    event.severity === 'critical' ||
    event.severity === 'error'
  ) {
    return 'SENSITIVE';
  }

  // Heartbeats and standard idle status events are PUBLIC operational health signals
  if (event.type === 'heartbeat' || (event.type === 'status' && !event.payload?.message)) {
    return 'PUBLIC';
  }

  // Standard task operations, task_started, task_completed, status updates
  return 'OPERATIONAL';
}

function scrubValue(val: string): { cleaned: string; wasRedacted: boolean } {
  let wasRedacted = false;
  let cleaned = val;

  const stellarMatches = cleaned.match(/\bS[A-Z0-9]{55}\b/g);
  if (stellarMatches) {
    cleaned = cleaned.replace(/\bS[A-Z0-9]{55}\b/g, '[redacted_stellar_seed]');
    wasRedacted = true;
  }

  const emailMatches = cleaned.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
  if (emailMatches) {
    cleaned = cleaned.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[redacted_email]');
    wasRedacted = true;
  }

  const base64Matches = cleaned.match(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g);
  if (base64Matches) {
    cleaned = cleaned.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted_secret]');
    wasRedacted = true;
  }

  return { cleaned, wasRedacted };
}

/**
 * Reviews operational metadata against minimization policies:
 * - Drops prohibited/unnecessary fields (allowlist enforcement).
 * - Redacts embedded sensitive values.
 * - Determines classification tier and expiration timestamp.
 */
export function reviewAndMinimizeMetadata(
  event: TelemetryEvent,
  customPolicies: Record<MetadataClassification, RetentionPolicy> = DEFAULT_RETENTION_POLICIES,
  currentTime: number = Date.now()
): MinimizationReviewResult {
  const classification = classifyMetadata(event);
  const policy = customPolicies[classification] || DEFAULT_RETENTION_POLICIES[classification];

  // If classification is RESTRICTED, immediately reject/purge
  if (classification === 'RESTRICTED' || policy.retentionWindowMs === 0) {
    return {
      accepted: false,
      classification: 'RESTRICTED',
      retainedFields: [],
      droppedFields: Object.keys(event.payload || {}),
      redactedFields: [],
      expiresAt: currentTime,
      event: {
        ...event,
        payload: undefined,
      },
    };
  }

  const rawPayload = (event.payload || {}) as Record<string, unknown>;
  const minimizedPayload: Record<string, string> = {};
  const retainedFields: string[] = [];
  const droppedFields: string[] = [];
  const redactedFields: string[] = [];

  for (const [key, value] of Object.entries(rawPayload)) {
    // Check if the key matches known restricted patterns
    const isRestrictedKey = RESTRICTED_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isRestrictedKey) {
      droppedFields.push(key);
      continue;
    }

    // Check if key is permitted under operational metadata contract
    if (!ALLOWED_PAYLOAD_FIELDS.has(key)) {
      droppedFields.push(key);
      continue;
    }

    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === 'string') {
      const { cleaned, wasRedacted } = scrubValue(value);
      minimizedPayload[key] = cleaned;
      retainedFields.push(key);
      if (wasRedacted) {
        redactedFields.push(key);
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      minimizedPayload[key] = String(value);
      retainedFields.push(key);
    } else {
      // Non-primitive values in metadata payload are dropped for strict minimization
      droppedFields.push(key);
    }
  }

  const cleanPayload: TelemetryEventPayload | undefined =
    Object.keys(minimizedPayload).length > 0
      ? (minimizedPayload as TelemetryEventPayload)
      : undefined;

  const expiresAt = currentTime + policy.retentionWindowMs;

  return {
    accepted: true,
    classification,
    retainedFields,
    droppedFields,
    redactedFields,
    expiresAt,
    event: {
      ...event,
      payload: cleanPayload,
    },
  };
}
