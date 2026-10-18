/**
 * Permission-Aware Search Indexing and Stale-Index Repair
 *
 * Ensures search and discovery indexes respect record visibility
 * and repairs stale entries when records are hidden, deleted, revoked,
 * or permission-scoped.
 *
 * Integrates with Algolia and supports repair jobs for consistency.
 */

import type { SearchClient } from 'algoliasearch';

export interface IndexableRecord {
  id: string;
  [key: string]: unknown;
}

export interface PermissionConstraint {
  /** Users who can see this record */
  visibleTo?: string[];
  /** User roles that can see this record */
  requiredRoles?: string[];
  /** Whether record is publicly visible */
  isPublic?: boolean;
  /** Organization/owner scoping */
  organizationId?: string;
}

export interface IndexedRecord {
  id: string;
  visibility: 'public' | 'restricted' | 'hidden';
  visibleTo?: string[];
  requiredRoles?: string[];
  organizationId?: string;
  indexed_at: number;
  [key: string]: unknown;
}

export interface SearchIndexConfig {
  indexName: string;
  searchableFields: string[];
  sortableFields: string[];
  facets: string[];
}

export interface RepairJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  recordsChecked: number;
  recordsFixed: number;
  errors: string[];
  recommendations?: IndexRepairRecommendation[];
}

export interface IndexRepairRecommendation {
  recordId: string;
  evidence: 'missing-index-entry' | 'visibility-mismatch' | 'permission-scope-mismatch' | 'consistent';
  action: 'create-or-update' | 'remove' | 'none';
}

/** Compare authoritative record permissions with the indexed snapshot. */
export function recommendIndexRepair(
  record: IndexableRecord,
  permissions: PermissionConstraint,
  indexedEntry?: IndexedRecord,
): IndexRepairRecommendation {
  const shouldIndex = shouldIndexRecord(record, permissions);
  if (!indexedEntry) {
    if (!shouldIndex) {
      return { recordId: record.id, evidence: 'consistent', action: 'none' };
    }
    return {
      recordId: record.id,
      evidence: 'missing-index-entry',
      action: shouldIndex ? 'create-or-update' : 'none',
    };
  }
  if (!shouldIndex) {
    return { recordId: record.id, evidence: 'visibility-mismatch', action: 'remove' };
  }
  const expectedVisibility = getRecordVisibility(record, permissions);
  if (indexedEntry.visibility !== expectedVisibility) {
    return { recordId: record.id, evidence: 'visibility-mismatch', action: 'create-or-update' };
  }
  if (
    JSON.stringify(indexedEntry.visibleTo) !== JSON.stringify(permissions.visibleTo) ||
    JSON.stringify(indexedEntry.requiredRoles) !== JSON.stringify(permissions.requiredRoles) ||
    indexedEntry.organizationId !== permissions.organizationId
  ) {
    return { recordId: record.id, evidence: 'permission-scope-mismatch', action: 'create-or-update' };
  }
  return { recordId: record.id, evidence: 'consistent', action: 'none' };
}

/**
 * Determine record visibility level based on permissions
 */
export function getRecordVisibility(
  record: IndexableRecord,
  permissions: PermissionConstraint
): 'public' | 'restricted' | 'hidden' {
  // Hidden if explicitly marked as hidden
  if (permissions.isPublic === false && !permissions.visibleTo?.length) {
    return 'hidden';
  }

  // Public if marked as public
  if (permissions.isPublic === true) {
    return 'public';
  }

  // Restricted if has specific visibility constraints
  if (permissions.visibleTo?.length || permissions.requiredRoles?.length) {
    return 'restricted';
  }

  // Default to restricted for safety
  return 'restricted';
}

/**
 * Check if a record should be indexed
 *
 * Records are indexed unless they're hidden or visibility constraints
 * are too restrictive for meaningful search.
 */
export function shouldIndexRecord(
  record: IndexableRecord,
  permissions: PermissionConstraint
): boolean {
  const visibility = getRecordVisibility(record, permissions);

  // Don't index hidden records
  if (visibility === 'hidden') {
    return false;
  }

  // Index public and restricted records
  return visibility === 'public' || visibility === 'restricted';
}

/**
 * Create a search index entry from a record
 *
 * Adds metadata for visibility-aware filtering while preserving searchable fields.
 */
export function createIndexEntry(
  record: IndexableRecord,
  permissions: PermissionConstraint,
  additionalMetadata?: Record<string, unknown>
): IndexedRecord | null {
  if (!shouldIndexRecord(record, permissions)) {
    return null;
  }

  const visibility = getRecordVisibility(record, permissions);

  return {
    id: record.id,
    visibility,
    visibleTo: permissions.visibleTo,
    requiredRoles: permissions.requiredRoles,
    organizationId: permissions.organizationId,
    indexed_at: Date.now(),
    ...record,
    ...additionalMetadata,
  };
}

/**
 * Update visibility when record permissions change
 *
 * Called when:
 * - Record is deleted/revoked
 * - Permissions are modified
 * - Visibility scope is reduced
 */
export async function updateRecordVisibility(
  recordId: string,
  permissions: PermissionConstraint,
  searchClient?: SearchClient,
  indexName?: string
): Promise<void> {
  if (!searchClient || !indexName) {
    // Log visibility change for audit trail
    console.info(`[Search Index] Visibility update for ${recordId}`, {
      visibility: getRecordVisibility({ id: recordId } as any, permissions),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const visibility = getRecordVisibility({ id: recordId } as any, permissions);

    if (visibility === 'hidden') {
      // Remove from index if now hidden
      await searchClient.deleteObject({
        indexName,
        objectID: recordId,
      });
    } else {
      // Update visibility metadata in index
      await searchClient.partialUpdateObject(
        {
          indexName,
          objectID: recordId,
          body: {
            visibility,
            visibleTo: permissions.visibleTo,
            indexed_at: Date.now(),
          },
        }
      );
    }
  } catch (error) {
    console.error(`[Search Index] Failed to update visibility for ${recordId}:`, error);
    throw error;
  }
}

/**
 * Check if indexed record matches current permissions
 *
 * Returns true if index entry is consistent with current permissions.
 */
export function isIndexConsistent(
  currentRecord: IndexableRecord,
  permissions: PermissionConstraint,
  indexedEntry: IndexedRecord
): boolean {
  const expectedVisibility = getRecordVisibility(currentRecord, permissions);
  const expectedShouldIndex = shouldIndexRecord(currentRecord, permissions);

  // Index entry should exist if record should be indexed
  if (expectedShouldIndex) {
    return (
      indexedEntry.visibility === expectedVisibility &&
      JSON.stringify(indexedEntry.visibleTo) === JSON.stringify(permissions.visibleTo) &&
      JSON.stringify(indexedEntry.requiredRoles) === JSON.stringify(permissions.requiredRoles) &&
      indexedEntry.organizationId === permissions.organizationId
    );
  } else {
    // If record shouldn't be indexed, presence of entry is inconsistent
    return false;
  }
}

/**
 * Repair job for fixing stale index entries
 *
 * Identifies records whose index entries don't match current visibility.
 */
export class SearchIndexRepair {
  private job: RepairJob;
  private records: Map<string, IndexableRecord> = new Map();
  private indexedRecords: Map<string, IndexedRecord> = new Map();
  private permissionsMap: Map<string, PermissionConstraint> = new Map();

  constructor(jobId: string = `repair-${Date.now()}`) {
    this.job = {
      id: jobId,
      status: 'pending',
      startTime: Date.now(),
      recordsChecked: 0,
      recordsFixed: 0,
      errors: [],
      recommendations: [],
    };
  }

  /**
   * Add record to repair scan
   */
  addRecord(
    record: IndexableRecord,
    permissions: PermissionConstraint,
    indexedEntry?: IndexedRecord
  ): void {
    this.records.set(record.id, record);
    this.permissionsMap.set(record.id, permissions);
    if (indexedEntry) {
      this.indexedRecords.set(record.id, indexedEntry);
    }
  }

  /**
   * Run repair job and return results
   */
  async run(): Promise<RepairJob> {
    this.job.status = 'running';

    try {
      for (const [recordId, record] of this.records) {
        this.job.recordsChecked++;

        const permissions = this.permissionsMap.get(recordId);
        const indexedEntry = this.indexedRecords.get(recordId);

        if (!permissions) {
          this.job.errors.push(`Missing permissions for ${recordId}`);
          continue;
        }

        // Check consistency
        const recommendation = recommendIndexRepair(record, permissions, indexedEntry);
        this.job.recommendations?.push(recommendation);
        if (recommendation.action !== 'none') {
          await this.repairRecord(record, permissions, indexedEntry);
          this.job.recordsFixed++;
        }
      }

      this.job.status = 'completed';
      this.job.endTime = Date.now();
    } catch (error) {
      this.job.status = 'failed';
      this.job.endTime = Date.now();
      this.job.errors.push(
        `Repair failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.job;
  }

  /**
   * Repair a single record's index entry
   */
  private async repairRecord(
    record: IndexableRecord,
    permissions: PermissionConstraint,
    currentIndexedEntry?: IndexedRecord
  ): Promise<void> {
    const shouldIndex = shouldIndexRecord(record, permissions);

    if (!shouldIndex && currentIndexedEntry) {
      // Remove from index if visibility has been revoked
      console.log(`[Search Index Repair] Removing ${record.id} from index`);
      // In production, would call searchClient.deleteObject
    } else if (shouldIndex) {
      // Update or create index entry
      const newEntry = createIndexEntry(record, permissions);
      if (newEntry) {
        console.log(`[Search Index Repair] Updating ${record.id} in index`);
        // In production, would call searchClient.saveObject
      }
    }
  }

  /**
   * Get repair job status
   */
  getStatus(): RepairJob {
    return this.job;
  }
}

/**
 * Apply visibility filters to search results
 *
 * Ensures search results respect user permissions.
 */
export function filterSearchResultsByPermissions(
  results: IndexedRecord[],
  userVisibleTo?: string[],
  userRoles?: string[]
): IndexedRecord[] {
  return results.filter(result => {
    // If not restricted, include in results
    if (result.visibility === 'public') {
      return true;
    }

    // If restricted, check user permissions
    if (result.visibility === 'restricted') {
      if (userVisibleTo && result.visibleTo) {
        return result.visibleTo.some(userId => userVisibleTo.includes(userId));
      }
      return false;
    }

    // Hidden records never appear in results
    return false;
  });
}

/**
 * Track visibility change events for audit trail
 */
export interface VisibilityChangeEvent {
  recordId: string;
  previousVisibility: 'public' | 'restricted' | 'hidden';
  newVisibility: 'public' | 'restricted' | 'hidden';
  reason: string;
  timestamp: number;
  userId?: string;
}

const visibilityAuditLog: VisibilityChangeEvent[] = [];

/**
 * Log visibility change for audit trail
 */
export function logVisibilityChange(event: Omit<VisibilityChangeEvent, 'timestamp'>): void {
  visibilityAuditLog.push({
    ...event,
    timestamp: Date.now(),
  });

  // In production, would persist to audit log
  console.debug('[Search Index] Visibility change logged:', event);
}

/**
 * Get audit log of visibility changes
 */
export function getVisibilityAuditLog(
  recordId?: string,
  hours: number = 24
): VisibilityChangeEvent[] {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  return visibilityAuditLog.filter(
    event =>
      event.timestamp > cutoff &&
      (!recordId || event.recordId === recordId)
  );
}

/**
 * Configuration helper for setting up search index with visibility
 */
export function createSearchIndexConfig(
  indexName: string,
  searchableFields: string[],
  sortableFields?: string[]
): SearchIndexConfig {
  return {
    indexName,
    searchableFields,
    sortableFields: sortableFields || [],
    facets: ['visibility', 'organizationId'],
  };
}

/**
 * Permission fields that affect how a record is indexed beyond its searchable
 * content. A change in any of these requires the index entry to be refreshed
 * even when the searchable content itself is unchanged.
 */
const VISIBILITY_FIELDS: Array<keyof PermissionConstraint> = [
  'isPublic',
  'visibleTo',
  'requiredRoles',
  'organizationId',
];

function permissionsEqual(
  a: PermissionConstraint,
  b: PermissionConstraint
): boolean {
  return VISIBILITY_FIELDS.every(
    (field) => JSON.stringify(a[field]) === JSON.stringify(b[field])
  );
}

/**
 * Diff detector: does this mutation change anything the search index cares
 * about? Returns true when a searchable field changed or the visibility /
 * permission scope changed, meaning the single record must be re-indexed
 * (or removed). When nothing relevant changed the caller can skip re-indexing.
 */
export function hasIndexableChanges(
  newRecord: IndexableRecord,
  permissions: PermissionConstraint,
  oldRecord: IndexableRecord,
  searchableFields: string[],
  oldPermissions?: PermissionConstraint
): boolean {
  const fieldsChanged = searchableFields.some(
    (field) => JSON.stringify(oldRecord[field]) !== JSON.stringify(newRecord[field])
  );
  if (fieldsChanged) {
    return true;
  }

  const previousPermissions = oldPermissions ?? permissions;
  const oldVisibility = getRecordVisibility(oldRecord, previousPermissions);
  const newVisibility = getRecordVisibility(newRecord, permissions);
  if (oldVisibility !== newVisibility) {
    return true;
  }

  return !permissionsEqual(previousPermissions, permissions);
}

/**
 * Update an existing record in the search index incrementally.
 *
 * Rather than re-indexing the whole dataset, a diff detector compares the
 * previous record state against the new one and only touches this single
 * record's index entry:
 *  - searchable field changed  -> single-record saveObject
 *  - visibility/permissions changed -> single-record saveObject or removal
 *  - nothing relevant changed  -> no-op (full rebuild avoided)
 *
 * `oldPermissions` is the permission state the record was last indexed under;
 * pass it when permissions changed alongside the record so visibility
 * transitions (e.g. a record becoming hidden) are detected.
 */
export async function updateRecord(
  newRecord: IndexableRecord,
  permissions: PermissionConstraint,
  oldRecord?: IndexableRecord,
  searchClient?: SearchClient,
  indexName?: string,
  searchableFields?: string[],
  oldPermissions?: PermissionConstraint
): Promise<void> {
  if (!searchClient || !indexName) {
    console.info(`[Search Index] Mock incremental update for ${newRecord.id}`);
    return;
  }

  // If the previous record state and the searchable field list are known,
  // detect whether anything the index cares about actually changed.
  if (oldRecord && searchableFields) {
    const changed = hasIndexableChanges(
      newRecord,
      permissions,
      oldRecord,
      searchableFields,
      oldPermissions
    );

    if (!changed) {
      console.info(`[Search Index] No indexable changes detected for ${newRecord.id}, skipping update`);
      return;
    }
  }

  const shouldIndex = shouldIndexRecord(newRecord, permissions);

  try {
    if (shouldIndex) {
      const entry = createIndexEntry(newRecord, permissions);
      if (entry) {
        await searchClient.saveObject({
          indexName,
          body: entry,
        });
      }
    } else {
      await deleteRecord(newRecord.id, searchClient, indexName);
    }
  } catch (error) {
    console.error(`[Search Index] Failed to incrementally update record ${newRecord.id}:`, error);
    throw error;
  }
}

/**
 * Delete a single record from the search index.
 */
export async function deleteRecord(
  recordId: string,
  searchClient?: SearchClient,
  indexName?: string
): Promise<void> {
  if (!searchClient || !indexName) {
    console.info(`[Search Index] Mock delete record for ${recordId}`);
    return;
  }

  try {
    await searchClient.deleteObject({
      indexName,
      objectID: recordId,
    });
  } catch (error) {
    console.error(`[Search Index] Failed to delete record ${recordId}:`, error);
    throw error;
  }
}
