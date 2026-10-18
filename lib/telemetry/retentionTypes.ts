/**
 * Metadata Classification & Retention Types
 *
 * Defines classification tiers for operational metadata, retention policy rules,
 * minimization review results, and storage record models.
 */

import type { TelemetryEvent, TelemetrySeverity } from './types';

export type MetadataClassification =
  | 'PUBLIC'        // Safe to expose to all roles, unbounded by strict minimization (non-identifying aggregate metrics)
  | 'OPERATIONAL'   // Standard system health/task events (sanitized, medium retention)
  | 'SENSITIVE'     // Security/error traces, diagnostics (requires strict role gating & shortest retention)
  | 'RESTRICTED';   // Disallowed or PII-bearing fields (must be redacted or dropped immediately)

export interface FieldClassificationPolicy {
  field: string;
  classification: MetadataClassification;
  allowedSeverities?: TelemetrySeverity[];
  description: string;
  allowedInStorage: boolean;
}

export interface RetentionPolicy {
  classification: MetadataClassification;
  /** Retention duration in milliseconds */
  retentionWindowMs: number;
  /** Max items allowed per tier in buffer/storage before LRU pruning */
  maxEntries?: number;
}

export interface MinimizationReviewResult {
  accepted: boolean;
  classification: MetadataClassification;
  retainedFields: string[];
  droppedFields: string[];
  redactedFields: string[];
  expiresAt: number;
  event: TelemetryEvent;
}

export interface StoredTelemetryRecord {
  id: string;
  storedAt: number;
  expiresAt: number;
  classification: MetadataClassification;
  event: TelemetryEvent;
}

export interface DeletionAuditRecord {
  id: string;
  deletedAt: number;
  reason: 'expired' | 'manual' | 'quota_exceeded' | 'purge_classification';
  classification: MetadataClassification;
  eventId: string;
}

export interface RetentionEnforcementSummary {
  inspected: number;
  expiredCount: number;
  deletedCount: number;
  retainedCount: number;
  freedBytesEstimate: number;
  enforcedAt: number;
}
