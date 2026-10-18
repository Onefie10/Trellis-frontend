/**
 * Operational Metadata Retention Enforcement Store
 *
 * Implements an observable storage container with:
 * - Deterministic retention window enforcement.
 * - Testable deletion mechanisms with full audit records.
 * - Data classification and automatic minimization upon ingestion.
 * - Quota-based and manual purge operations.
 */

import type { TelemetryEvent } from './types';
import type {
  DeletionAuditRecord,
  MetadataClassification,
  RetentionEnforcementSummary,
  RetentionPolicy,
  StoredTelemetryRecord,
} from './retentionTypes';
import {
  DEFAULT_RETENTION_POLICIES,
  reviewAndMinimizeMetadata,
} from './minimizationReview';

export class OperationalMetadataRetentionStore {
  private records: Map<string, StoredTelemetryRecord> = new Map();
  private auditLog: DeletionAuditRecord[] = [];
  private policies: Record<MetadataClassification, RetentionPolicy>;

  constructor(customPolicies?: Partial<Record<MetadataClassification, RetentionPolicy>>) {
    this.policies = {
      ...DEFAULT_RETENTION_POLICIES,
      ...customPolicies,
    };
  }

  /**
   * Updates or overrides retention policy for a specific classification.
   */
  public setPolicy(classification: MetadataClassification, policy: RetentionPolicy): void {
    this.policies[classification] = policy;
  }

  public getPolicy(classification: MetadataClassification): RetentionPolicy {
    return this.policies[classification];
  }

  /**
   * Ingests a telemetry event, running it through data minimization review
   * and assigning retention windows.
   */
  public ingest(event: TelemetryEvent, currentTime: number = Date.now()): StoredTelemetryRecord | null {
    const review = reviewAndMinimizeMetadata(event, this.policies, currentTime);

    if (!review.accepted) {
      // Record audit of rejected / purged entry
      this.auditLog.push({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        deletedAt: currentTime,
        reason: 'purge_classification',
        classification: review.classification,
        eventId: event.id,
      });
      return null;
    }

    const storedRecord: StoredTelemetryRecord = {
      id: event.id,
      storedAt: currentTime,
      expiresAt: review.expiresAt,
      classification: review.classification,
      event: review.event,
    };

    this.records.set(event.id, storedRecord);

    // Enforce tier capacity limit if configured
    const tierPolicy = this.policies[review.classification];
    if (tierPolicy?.maxEntries && tierPolicy.maxEntries > 0) {
      this.enforceTierCapacity(review.classification, tierPolicy.maxEntries, currentTime);
    }

    return storedRecord;
  }

  /**
   * Enforces retention windows across all stored metadata.
   * Deletes expired records and emits an enforcement summary.
   */
  public enforceRetention(currentTime: number = Date.now()): RetentionEnforcementSummary {
    let expiredCount = 0;
    let deletedCount = 0;
    let freedBytesEstimate = 0;
    const inspected = this.records.size;

    for (const [id, record] of this.records.entries()) {
      if (record.expiresAt <= currentTime) {
        expiredCount++;
        const recordBytes = JSON.stringify(record).length;
        freedBytesEstimate += recordBytes;

        this.records.delete(id);
        deletedCount++;

        this.auditLog.push({
          id: `audit-${currentTime}-${Math.random().toString(36).slice(2, 7)}`,
          deletedAt: currentTime,
          reason: 'expired',
          classification: record.classification,
          eventId: record.id,
        });
      }
    }

    return {
      inspected,
      expiredCount,
      deletedCount,
      retainedCount: this.records.size,
      freedBytesEstimate,
      enforcedAt: currentTime,
    };
  }

  /**
   * Delete a single record explicitly (e.g. on operator request or user deletion).
   */
  public deleteRecord(
    id: string,
    reason: DeletionAuditRecord['reason'] = 'manual',
    currentTime: number = Date.now()
  ): boolean {
    const record = this.records.get(id);
    if (!record) return false;

    this.records.delete(id);
    this.auditLog.push({
      id: `audit-${currentTime}-${Math.random().toString(36).slice(2, 7)}`,
      deletedAt: currentTime,
      reason,
      classification: record.classification,
      eventId: record.id,
    });
    return true;
  }

  /**
   * Purge all records under a classification tier (e.g. incident containment).
   */
  public purgeClassification(
    classification: MetadataClassification,
    currentTime: number = Date.now()
  ): number {
    let count = 0;
    for (const [id, record] of this.records.entries()) {
      if (record.classification === classification) {
        this.records.delete(id);
        count++;
        this.auditLog.push({
          id: `audit-${currentTime}-${Math.random().toString(36).slice(2, 7)}`,
          deletedAt: currentTime,
          reason: 'purge_classification',
          classification,
          eventId: id,
        });
      }
    }
    return count;
  }

  /**
   * Enforces capacity limits per tier, deleting oldest records first.
   */
  private enforceTierCapacity(
    classification: MetadataClassification,
    maxAllowed: number,
    currentTime: number
  ): void {
    const tierRecords: StoredTelemetryRecord[] = [];
    for (const record of this.records.values()) {
      if (record.classification === classification) {
        tierRecords.push(record);
      }
    }

    if (tierRecords.length > maxAllowed) {
      // Sort oldest stored first
      tierRecords.sort((a, b) => a.storedAt - b.storedAt);
      const toRemove = tierRecords.slice(0, tierRecords.length - maxAllowed);

      for (const rec of toRemove) {
        this.records.delete(rec.id);
        this.auditLog.push({
          id: `audit-${currentTime}-${Math.random().toString(36).slice(2, 7)}`,
          deletedAt: currentTime,
          reason: 'quota_exceeded',
          classification: rec.classification,
          eventId: rec.id,
        });
      }
    }
  }

  public getRecord(id: string): StoredTelemetryRecord | undefined {
    return this.records.get(id);
  }

  public getAllRecords(): StoredTelemetryRecord[] {
    return Array.from(this.records.values());
  }

  public getRecordsByClassification(classification: MetadataClassification): StoredTelemetryRecord[] {
    return this.getAllRecords().filter((r) => r.classification === classification);
  }

  public getAuditLog(): DeletionAuditRecord[] {
    return [...this.auditLog];
  }

  public clear(): void {
    this.records.clear();
    this.auditLog = [];
  }
}
