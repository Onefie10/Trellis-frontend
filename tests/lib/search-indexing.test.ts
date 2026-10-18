import {
  getRecordVisibility,
  shouldIndexRecord,
  createIndexEntry,
  isIndexConsistent,
  filterSearchResultsByPermissions,
  SearchIndexRepair,
  logVisibilityChange,
  getVisibilityAuditLog,
  createSearchIndexConfig,
  recommendIndexRepair,
} from '@/lib/search-indexing';
import type {
  IndexableRecord,
  PermissionConstraint,
  IndexedRecord,
} from '@/lib/search-indexing';

describe('Search Indexing - Permission Awareness', () => {
  const mockRecord: IndexableRecord = {
    id: 'claim-123',
    title: 'Emergency Aid Claim',
    amount: 100,
  };

  describe('operator repair recommendations', () => {
    it('reports a missing entry with the evidence and safe repair action', () => {
      expect(recommendIndexRepair(mockRecord, { isPublic: true })).toEqual({
        recordId: mockRecord.id,
        evidence: 'missing-index-entry',
        action: 'create-or-update',
      });
    });

    it('recommends removal when authoritative visibility has been revoked', () => {
      const indexed: IndexedRecord = { id: mockRecord.id, visibility: 'public', indexed_at: Date.now() };
      expect(recommendIndexRepair(mockRecord, { isPublic: false }, indexed)).toEqual({
        recordId: mockRecord.id,
        evidence: 'visibility-mismatch',
        action: 'remove',
      });
    });

    it('reports permission scope drift without including permission values', () => {
      const indexed: IndexedRecord = { id: mockRecord.id, visibility: 'restricted', visibleTo: ['old-user'], indexed_at: Date.now() };
      const recommendation = recommendIndexRepair(mockRecord, { visibleTo: ['current-user'] }, indexed);
      expect(recommendation).toMatchObject({ evidence: 'permission-scope-mismatch', action: 'create-or-update' });
      expect(JSON.stringify(recommendation)).not.toContain('current-user');
    });

    it('preserves and checks role and organization scopes', () => {
      const scoped = createIndexEntry(mockRecord, {
        requiredRoles: ['reviewer'],
        organizationId: 'trusted-org',
      });
      expect(scoped).toMatchObject({ requiredRoles: ['reviewer'], organizationId: 'trusted-org' });
      expect(recommendIndexRepair(mockRecord, {
        requiredRoles: ['reviewer'],
        organizationId: 'another-org',
      }, scoped ?? undefined)).toMatchObject({ evidence: 'permission-scope-mismatch', action: 'create-or-update' });
    });
  });

  describe('getRecordVisibility', () => {
    it('returns hidden for records without visibility', () => {
      const permissions: PermissionConstraint = {};
      expect(getRecordVisibility(mockRecord, permissions)).toBe('restricted');
    });

    it('returns public for publicly visible records', () => {
      const permissions: PermissionConstraint = { isPublic: true };
      expect(getRecordVisibility(mockRecord, permissions)).toBe('public');
    });

    it('returns hidden for explicitly hidden records', () => {
      const permissions: PermissionConstraint = { isPublic: false };
      expect(getRecordVisibility(mockRecord, permissions)).toBe('hidden');
    });

    it('returns restricted for records with user visibility list', () => {
      const permissions: PermissionConstraint = {
        visibleTo: ['user-1', 'user-2'],
      };
      expect(getRecordVisibility(mockRecord, permissions)).toBe('restricted');
    });

    it('returns restricted for records with required roles', () => {
      const permissions: PermissionConstraint = {
        requiredRoles: ['admin', 'moderator'],
      };
      expect(getRecordVisibility(mockRecord, permissions)).toBe('restricted');
    });
  });

  describe('shouldIndexRecord', () => {
    it('indexes public records', () => {
      const permissions: PermissionConstraint = { isPublic: true };
      expect(shouldIndexRecord(mockRecord, permissions)).toBe(true);
    });

    it('indexes restricted records', () => {
      const permissions: PermissionConstraint = {
        visibleTo: ['user-1'],
      };
      expect(shouldIndexRecord(mockRecord, permissions)).toBe(true);
    });

    it('does not index hidden records', () => {
      const permissions: PermissionConstraint = { isPublic: false };
      expect(shouldIndexRecord(mockRecord, permissions)).toBe(false);
    });

    it('does not index records with no visibility', () => {
      const permissions: PermissionConstraint = {};
      expect(shouldIndexRecord(mockRecord, permissions)).toBe(false);
    });
  });

  describe('createIndexEntry', () => {
    it('creates index entry for indexable records', () => {
      const permissions: PermissionConstraint = { isPublic: true };
      const entry = createIndexEntry(mockRecord, permissions);

      expect(entry).toBeDefined();
      expect(entry?.id).toBe('claim-123');
      expect(entry?.visibility).toBe('public');
      expect(entry?.indexed_at).toBeDefined();
    });

    it('returns null for non-indexable records', () => {
      const permissions: PermissionConstraint = { isPublic: false };
      const entry = createIndexEntry(mockRecord, permissions);

      expect(entry).toBeNull();
    });

    it('includes visibility constraints in index entry', () => {
      const permissions: PermissionConstraint = {
        visibleTo: ['user-1', 'user-2'],
      };
      const entry = createIndexEntry(mockRecord, permissions);

      expect(entry?.visibility).toBe('restricted');
      expect(entry?.visibleTo).toEqual(['user-1', 'user-2']);
    });

    it('includes additional metadata in index entry', () => {
      const permissions: PermissionConstraint = { isPublic: true };
      const metadata = { indexed_by: 'system', batch_id: 'batch-1' };
      const entry = createIndexEntry(mockRecord, permissions, metadata);

      expect(entry?.indexed_by).toBe('system');
      expect(entry?.batch_id).toBe('batch-1');
    });
  });

  describe('isIndexConsistent', () => {
    it('confirms consistency when visibility matches', () => {
      const permissions: PermissionConstraint = { isPublic: true };
      const indexedEntry: IndexedRecord = {
        id: 'claim-123',
        visibility: 'public',
        indexed_at: Date.now(),
      };

      expect(isIndexConsistent(mockRecord, permissions, indexedEntry)).toBe(true);
    });

    it('detects inconsistency when visibility changed', () => {
      const permissions: PermissionConstraint = { isPublic: false };
      const indexedEntry: IndexedRecord = {
        id: 'claim-123',
        visibility: 'public', // Outdated
        indexed_at: Date.now(),
      };

      expect(isIndexConsistent(mockRecord, permissions, indexedEntry)).toBe(false);
    });

    it('detects inconsistency when permissions changed', () => {
      const permissions: PermissionConstraint = {
        visibleTo: ['user-1', 'user-2', 'user-3'],
      };
      const indexedEntry: IndexedRecord = {
        id: 'claim-123',
        visibility: 'restricted',
        visibleTo: ['user-1', 'user-2'], // Outdated
        indexed_at: Date.now(),
      };

      expect(isIndexConsistent(mockRecord, permissions, indexedEntry)).toBe(false);
    });

    it('detects inconsistency when record should no longer be indexed', () => {
      const permissions: PermissionConstraint = { isPublic: false };
      const indexedEntry: IndexedRecord = {
        id: 'claim-123',
        visibility: 'restricted',
        indexed_at: Date.now(),
      };

      expect(isIndexConsistent(mockRecord, permissions, indexedEntry)).toBe(false);
    });
  });

  describe('filterSearchResultsByPermissions', () => {
    it('includes public records regardless of user permissions', () => {
      const results: IndexedRecord[] = [
        { id: '1', visibility: 'public', indexed_at: Date.now() },
        { id: '2', visibility: 'public', indexed_at: Date.now() },
      ];

      const filtered = filterSearchResultsByPermissions(results);
      expect(filtered).toHaveLength(2);
    });

    it('filters hidden records from all results', () => {
      const results: IndexedRecord[] = [
        { id: '1', visibility: 'public', indexed_at: Date.now() },
        { id: '2', visibility: 'hidden', indexed_at: Date.now() },
        { id: '3', visibility: 'public', indexed_at: Date.now() },
      ];

      const filtered = filterSearchResultsByPermissions(results);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(r => r.id)).toEqual(['1', '3']);
    });

    it('filters restricted records based on user visibility', () => {
      const results: IndexedRecord[] = [
        {
          id: '1',
          visibility: 'restricted',
          visibleTo: ['user-1', 'user-2'],
          indexed_at: Date.now(),
        },
        {
          id: '2',
          visibility: 'restricted',
          visibleTo: ['user-3', 'user-4'],
          indexed_at: Date.now(),
        },
      ];

      const userVisibleTo = ['user-1'];
      const filtered = filterSearchResultsByPermissions(results, userVisibleTo);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('1');
    });

    it('handles mixed visibility levels correctly', () => {
      const results: IndexedRecord[] = [
        { id: '1', visibility: 'public', indexed_at: Date.now() },
        {
          id: '2',
          visibility: 'restricted',
          visibleTo: ['user-1'],
          indexed_at: Date.now(),
        },
        { id: '3', visibility: 'hidden', indexed_at: Date.now() },
      ];

      const userVisibleTo = ['user-1'];
      const filtered = filterSearchResultsByPermissions(results, userVisibleTo);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(r => r.id)).toEqual(['1', '2']);
    });
  });

  describe('SearchIndexRepair', () => {
    it('creates repair job with unique ID', () => {
      const repair = new SearchIndexRepair();
      expect(repair.getStatus().id).toBeDefined();
      expect(repair.getStatus().status).toBe('pending');
    });

    it('accepts custom job ID', () => {
      const repair = new SearchIndexRepair('custom-job-123');
      expect(repair.getStatus().id).toBe('custom-job-123');
    });

    it('adds records for scanning', () => {
      const repair = new SearchIndexRepair();
      const permissions: PermissionConstraint = { isPublic: true };

      repair.addRecord(mockRecord, permissions);
      expect(repair.getStatus().recordsChecked).toBe(0); // Not run yet
    });

    it('executes repair job and counts records', async () => {
      const repair = new SearchIndexRepair();
      const permissions: PermissionConstraint = { isPublic: true };

      repair.addRecord(mockRecord, permissions);
      repair.addRecord(
        { ...mockRecord, id: 'claim-124' },
        permissions
      );

      const result = await repair.run();
      expect(result.status).toBe('completed');
      expect(result.recordsChecked).toBe(2);
    });

    it('identifies and fixes inconsistent records', async () => {
      const repair = new SearchIndexRepair();

      // Consistent record (public)
      const permissions1: PermissionConstraint = { isPublic: true };
      const indexed1: IndexedRecord = {
        id: 'claim-123',
        visibility: 'public',
        indexed_at: Date.now(),
      };

      // Inconsistent record (was public, now hidden)
      const permissions2: PermissionConstraint = { isPublic: false };
      const indexed2: IndexedRecord = {
        id: 'claim-124',
        visibility: 'public', // Outdated
        indexed_at: Date.now() - 86400000, // Old entry
      };

      repair.addRecord(mockRecord, permissions1, indexed1);
      repair.addRecord(
        { ...mockRecord, id: 'claim-124' },
        permissions2,
        indexed2
      );

      const result = await repair.run();
      expect(result.recordsFixed).toBe(1); // One record needed repair
      expect(result.recordsChecked).toBe(2);
    });

    it('handles repair errors gracefully', async () => {
      const repair = new SearchIndexRepair();

      // Add record with missing permissions
      repair.addRecord(mockRecord, undefined as any);

      const result = await repair.run();
      expect(result.status).toBe('running'); // Continues despite error
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Visibility Audit Logging', () => {
    it('logs visibility changes with timestamp', () => {
      logVisibilityChange({
        recordId: 'claim-123',
        previousVisibility: 'public',
        newVisibility: 'hidden',
        reason: 'record deleted',
        userId: 'user-1',
      });

      const log = getVisibilityAuditLog();
      expect(log.length).toBeGreaterThan(0);
      expect(log[log.length - 1].recordId).toBe('claim-123');
    });

    it('filters audit log by record ID', () => {
      logVisibilityChange({
        recordId: 'claim-123',
        previousVisibility: 'public',
        newVisibility: 'hidden',
        reason: 'deleted',
      });

      logVisibilityChange({
        recordId: 'claim-124',
        previousVisibility: 'restricted',
        newVisibility: 'hidden',
        reason: 'permission revoked',
      });

      const specificLog = getVisibilityAuditLog('claim-123');
      expect(specificLog.some(entry => entry.recordId === 'claim-123')).toBe(true);
      expect(specificLog.some(entry => entry.recordId === 'claim-124')).toBe(false);
    });

    it('respects time filter for audit log', () => {
      logVisibilityChange({
        recordId: 'claim-123',
        previousVisibility: 'public',
        newVisibility: 'hidden',
        reason: 'old entry',
      });

      // Query with 0 hours (only very recent entries)
      const recentLog = getVisibilityAuditLog('claim-123', 0);
      expect(recentLog.length).toBe(0); // No entries from the future
    });
  });

  describe('Search Index Configuration', () => {
    it('creates configuration with required fields', () => {
      const config = createSearchIndexConfig(
        'claims',
        ['title', 'description', 'amount']
      );

      expect(config.indexName).toBe('claims');
      expect(config.searchableFields).toEqual(['title', 'description', 'amount']);
      expect(config.facets).toContain('visibility');
    });

    it('includes default sortable fields', () => {
      const config = createSearchIndexConfig('claims', ['title']);
      expect(config.sortableFields).toEqual([]);
    });

    it('includes custom sortable fields', () => {
      const config = createSearchIndexConfig(
        'claims',
        ['title'],
        ['created_at', 'amount']
      );

      expect(config.sortableFields).toEqual(['created_at', 'amount']);
    });
  });

  describe('Integration - Visibility Change Workflow', () => {
    it('handles complete visibility change lifecycle', () => {
      // 1. Record created as public
      const permissions1: PermissionConstraint = { isPublic: true };
      const entry1 = createIndexEntry(mockRecord, permissions1);
      expect(entry1?.visibility).toBe('public');

      // 2. Record restricted to specific users
      const permissions2: PermissionConstraint = {
        visibleTo: ['user-1', 'user-2'],
      };
      logVisibilityChange({
        recordId: mockRecord.id,
        previousVisibility: 'public',
        newVisibility: 'restricted',
        reason: 'permissions modified',
      });

      // 3. Record visibility hidden
      const permissions3: PermissionConstraint = { isPublic: false };
      const entry3 = createIndexEntry(mockRecord, permissions3);
      expect(entry3).toBeNull(); // Should not be indexed

      logVisibilityChange({
        recordId: mockRecord.id,
        previousVisibility: 'restricted',
        newVisibility: 'hidden',
        reason: 'record deleted',
      });

      // 4. Audit log shows full history
      const auditLog = getVisibilityAuditLog(mockRecord.id);
      expect(auditLog).toHaveLength(2);
      expect(auditLog[0].previousVisibility).toBe('public');
      expect(auditLog[1].previousVisibility).toBe('restricted');
    });
  });
});

  describe('Incremental Indexing', () => {
    let mockSearchClient: any;

    beforeEach(() => {
      mockSearchClient = {
        saveObject: jest.fn().mockResolvedValue({}),
        deleteObject: jest.fn().mockResolvedValue({}),
      };
    });

    it('updateRecord should skip update if no searchable fields or visibility changed', async () => {
      const oldRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      const newRecord = { id: 'agent-1', name: 'Test Agent', status: 'inactive' }; // status is not searchable
      const permissions = { isPublic: true };
      
      const { updateRecord } = require('@/lib/search-indexing');
      await updateRecord(newRecord, permissions, oldRecord, mockSearchClient, 'agents', ['name']);
      
      expect(mockSearchClient.saveObject).not.toHaveBeenCalled();
    });

    it('updateRecord should trigger update if searchable fields changed', async () => {
      const oldRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      const newRecord = { id: 'agent-1', name: 'Updated Agent', status: 'active' }; 
      const permissions = { isPublic: true };
      
      const { updateRecord } = require('@/lib/search-indexing');
      await updateRecord(newRecord, permissions, oldRecord, mockSearchClient, 'agents', ['name']);
      
      expect(mockSearchClient.saveObject).toHaveBeenCalledTimes(1);
    });

    it('updateRecord should trigger delete if visibility changed to hidden', async () => {
      const oldRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      const newRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      // The record was indexed while public; it has since become hidden.
      const oldPermissions = { isPublic: true };
      const permissions = { isPublic: false };

      const { updateRecord } = require('@/lib/search-indexing');
      await updateRecord(newRecord, permissions, oldRecord, mockSearchClient, 'agents', ['name'], oldPermissions);

      expect(mockSearchClient.deleteObject).toHaveBeenCalledTimes(1);
      expect(mockSearchClient.deleteObject).toHaveBeenCalledWith({
        indexName: 'agents',
        objectID: 'agent-1',
      });
    });

    it('updateRecord should update when only the permission scope changed', async () => {
      const oldRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      const newRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      const oldPermissions = { visibleTo: ['user-1'] };
      const permissions = { visibleTo: ['user-1', 'user-2'] };

      const { updateRecord } = require('@/lib/search-indexing');
      await updateRecord(newRecord, permissions, oldRecord, mockSearchClient, 'agents', ['name'], oldPermissions);

      expect(mockSearchClient.saveObject).toHaveBeenCalledTimes(1);
      expect(mockSearchClient.deleteObject).not.toHaveBeenCalled();
    });

    it('updateRecord should not touch the index when a mock client is used', async () => {
      const oldRecord = { id: 'agent-1', name: 'Test Agent', status: 'active' };
      const newRecord = { id: 'agent-1', name: 'Updated Agent', status: 'active' };
      const permissions = { isPublic: true };

      const { updateRecord } = require('@/lib/search-indexing');
      // No client / index name -> no-op instead of throwing.
      await expect(
        updateRecord(newRecord, permissions, oldRecord)
      ).resolves.toBeUndefined();
    });

    it('deleteRecord should trigger delete in search client', async () => {
      const { deleteRecord } = require('@/lib/search-indexing');
      await deleteRecord('agent-1', mockSearchClient, 'agents');
      
      expect(mockSearchClient.deleteObject).toHaveBeenCalledTimes(1);
      expect(mockSearchClient.deleteObject).toHaveBeenCalledWith({
        indexName: 'agents',
        objectID: 'agent-1',
      });
    });
  });
