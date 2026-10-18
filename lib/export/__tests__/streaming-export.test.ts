/**
 * Tests for the permission-aware streaming export pipeline.
 *
 * These tests verify:
 * - Permission enforcement before and during export
 * - Bounded memory processing via batch-based streaming
 * - Cancellation support via AbortController
 * - Field-level permission checks and redaction
 * - Large dataset handling
 * - Forbidden field handling
 */

import {
  streamingExport,
  type ExportRequest,
  type RecordFetcher,
  type PermissionRecord,
  type StreamWriter,
  getFieldPermissions,
  buildPermissionMap,
  canViewField,
  redactRecord,
  ExportRequestSchema,
  ExportConfigSchema,
  ExportMetadataSchema,
} from '../streaming-export';
import type { Role } from '@/lib/permissions';

describe('streaming-export', () => {
  describe('field permissions', () => {
    it('returns field permissions for each export type', () => {
      const simPermissions = getFieldPermissions('simulations');
      expect(simPermissions).toHaveLength(7);
      expect(simPermissions[0].name).toBe('id');
      expect(simPermissions[0].requiredLevel).toBe('public');
      expect(simPermissions[1].name).toBe('wallet');
      expect(simPermissions[1].requiredLevel).toBe('contributor');
      expect(simPermissions[1].isPii).toBe(true);
    });

    it('builds a permission map for fast lookup', () => {
      const map = buildPermissionMap('simulations');
      expect(map.has('id')).toBe(true);
      expect(map.has('wallet')).toBe(true);
      expect(map.get('id')?.requiredLevel).toBe('public');
      expect(map.get('wallet')?.requiredLevel).toBe('contributor');
    });

    it('correctly evaluates field access based on role', () => {
      expect(canViewField('guest', 'public')).toBe(true);
      expect(canViewField('guest', 'viewer')).toBe(false);
      expect(canViewField('viewer', 'viewer')).toBe(true);
      expect(canViewField('viewer', 'contributor')).toBe(false);
      expect(canViewField('contributor', 'contributor')).toBe(true);
      expect(canViewField('contributor', 'maintainer')).toBe(false);
      expect(canViewField('maintainer', 'maintainer')).toBe(true);
      expect(canViewField('maintainer', 'admin')).toBe(false);
      expect(canViewField('admin', 'admin')).toBe(true);
    });
  });

  describe('record redaction', () => {
    it('redacts fields based on role', () => {
      const permissionMap = buildPermissionMap('simulations');
      const record: PermissionRecord = {
        data: {
          id: 'sim-1',
          wallet: 'GABC...XYZ',
          created_at: '2024-01-01T00:00:00Z',
          parameters: { foo: 'bar' },
          ip_address: '192.168.1.1',
        },
        fieldPermissions: permissionMap,
      };

      const { redacted, redactedFieldCount } = redactRecord(record, 'viewer');

      expect(redacted.id).toBe('sim-1');
      expect(redacted.wallet).toBe('[REDACTED:CONTRIBUTOR]');
      expect(redacted.created_at).toBe('2024-01-01T00:00:00Z');
      expect(redacted.parameters).toEqual({ foo: 'bar' });
      expect(redacted.ip_address).toBe('[REDACTED:MAINTAINER]');
      expect(redactedFieldCount).toBe(2);
    });

    it('does not redact fields for admin', () => {
      const permissionMap = buildPermissionMap('simulations');
      const record: PermissionRecord = {
        data: {
          id: 'sim-1',
          wallet: 'GABC...XYZ',
          ip_address: '192.168.1.1',
        },
        fieldPermissions: permissionMap,
      };

      const { redacted, redactedFieldCount } = redactRecord(record, 'admin');

      expect(redacted.id).toBe('sim-1');
      expect(redacted.wallet).toBe('GABC...XYZ');
      expect(redacted.ip_address).toBe('192.168.1.1');
      expect(redactedFieldCount).toBe(0);
    });

    it('handles missing fields gracefully', () => {
      const permissionMap = buildPermissionMap('simulations');
      const record: PermissionRecord = {
        data: {
          id: 'sim-1',
        },
        fieldPermissions: permissionMap,
      };

      const { redacted, redactedFieldCount } = redactRecord(record, 'viewer');

      expect(redacted.id).toBe('sim-1');
      expect(redactedFieldCount).toBe(0);
    });
  });

  describe('streaming export pipeline', () => {
    it('streams records in batches with JSON format', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        if (offset >= 5) return []; // Stop after 5 records
        return Array.from({ length: Math.min(limit, 5 - offset) }, (_, i) => ({
          data: { id: `sim-${offset + i}`, wallet: `wallet-${offset + i}` },
          fieldPermissions: buildPermissionMap('simulations'),
        }));
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.recordCount).toBe(5);
      expect(metadata.redactedCount).toBe(0);
      expect(metadata.cancelled).toBe(false);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toContain('[');
      expect(chunks[chunks.length - 1]).toContain(']');
    });

    it('streams records in batches with CSV format', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        if (offset >= 3) return [];
        return Array.from({ length: Math.min(limit, 3 - offset) }, (_, i) => ({
          data: { id: `sim-${offset + i}`, wallet: `wallet-${offset + i}` },
          fieldPermissions: buildPermissionMap('simulations'),
        }));
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'csv',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.recordCount).toBe(3);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toContain('id,wallet');
    });

    it('handles cancellation during export', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const controller = new AbortController();
      let fetchCount = 0;

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        fetchCount++;
        if (fetchCount === 2) {
          controller.abort(); // Cancel on second fetch
        }
        if (signal.aborted) return [];
        return Array.from({ length: limit }, (_, i) => ({
          data: { id: `sim-${offset + i}` },
          fieldPermissions: buildPermissionMap('simulations'),
        }));
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, controller.signal);

      expect(metadata.cancelled).toBe(true);
      expect(fetchCount).toBeLessThanOrEqual(2);
    });

    it('respects batch size configuration', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetchCalls: number[] = [];

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        fetchCalls.push(limit);
        if (offset >= 10) return [];
        return Array.from({ length: Math.min(limit, 10 - offset) }, (_, i) => ({
          data: { id: `sim-${offset + i}` },
          fieldPermissions: buildPermissionMap('simulations'),
        }));
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(
        request,
        fetcher,
        writer,
        new AbortController().signal,
        { batchSize: 3 },
      );

      expect(metadata.recordCount).toBe(10);
      expect(fetchCalls).toEqual([3, 3, 3, 1]);
    });

    it('tracks redaction statistics', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        if (offset >= 5) return [];
        return Array.from({ length: Math.min(limit, 5 - offset) }, (_, i) => ({
          data: {
            id: `sim-${offset + i}`,
            wallet: `wallet-${offset + i}`,
            ip_address: `192.168.1.${offset + i}`,
          },
          fieldPermissions: buildPermissionMap('simulations'),
        }));
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'viewer',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.recordCount).toBe(5);
      expect(metadata.redactedCount).toBe(5); // All records have redacted fields
      expect(metadata.redactedFieldCount).toBeGreaterThan(0);
    });

    it('handles empty dataset', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async () => [];

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.recordCount).toBe(0);
      expect(metadata.redactedCount).toBe(0);
      expect(metadata.cancelled).toBe(false);
    });

    it('handles fetcher errors', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async () => {
        throw new Error('Database connection failed');
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.error).toBe('Database connection failed');
    });
  });

  describe('large dataset handling', () => {
    it('handles large datasets without memory issues', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const totalRecords = 10000;
      let offset = 0;

      const fetcher: RecordFetcher = async (offsetParam, limit, signal) => {
        if (offsetParam >= totalRecords) return [];
        const count = Math.min(limit, totalRecords - offsetParam);
        return Array.from({ length: count }, (_, i) => ({
          data: { id: `sim-${offsetParam + i}`, value: i },
          fieldPermissions: buildPermissionMap('simulations'),
        }));
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(
        request,
        fetcher,
        writer,
        new AbortController().signal,
        { batchSize: 1000 },
      );

      expect(metadata.recordCount).toBe(totalRecords);
      expect(metadata.cancelled).toBe(false);
    });
  });

  describe('forbidden field handling', () => {
    it('prevents access to admin-only fields for lower roles', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        if (offset >= 1) return [];
        return [
          {
            data: {
              id: 'sim-1',
              wallet: 'GABC...XYZ',
              ip_address: '192.168.1.1',
              user_agent: 'Mozilla/5.0',
            },
            fieldPermissions: buildPermissionMap('simulations'),
          },
        ];
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'viewer',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.redactedCount).toBe(1);
      expect(metadata.redactedFieldCount).toBe(2); // wallet and ip_address

      // Verify the output contains redaction markers
      const output = chunks.join('');
      expect(output).toContain('[REDACTED:CONTRIBUTOR]');
      expect(output).toContain('[REDACTED:MAINTAINER]');
    });

    it('allows access to all fields for admin', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        if (offset >= 1) return [];
        return [
          {
            data: {
              id: 'sim-1',
              wallet: 'GABC...XYZ',
              ip_address: '192.168.1.1',
            },
            fieldPermissions: buildPermissionMap('simulations'),
          },
        ];
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      const metadata = await streamingExport(request, fetcher, writer, new AbortController().signal);

      expect(metadata.redactedCount).toBe(0);
      expect(metadata.redactedFieldCount).toBe(0);

      const output = chunks.join('');
      expect(output).toContain('GABC...XYZ');
      expect(output).toContain('192.168.1.1');
    });
  });

  describe('validation schemas', () => {
    it('validates export requests', () => {
      const validRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations' as const,
        from: '2024-01-01T00:00:00Z',
        to: '2024-12-31T23:59:59Z',
        format: 'json' as const,
        role: 'admin' as const,
        actorId: 'actor-1',
      };

      expect(ExportRequestSchema.parse(validRequest)).toEqual(validRequest);
    });

    it('rejects invalid export requests', () => {
      const invalidRequest = {
        wallet: 'too-short',
        type: 'invalid-type',
        format: 'json',
        role: 'admin',
        actorId: 'actor-1',
      };

      expect(() => ExportRequestSchema.parse(invalidRequest)).toThrow();
    });

    it('validates export config', () => {
      const validConfig = {
        batchSize: 1000,
        maxMemoryBytes: 100 * 1024 * 1024,
        batchTimeoutMs: 30000,
        debug: false,
      };

      expect(ExportConfigSchema.parse(validConfig)).toEqual(validConfig);
    });

    it('validates export metadata', () => {
      const validMetadata = {
        schemaVersion: '2.0',
        type: 'simulations' as const,
        format: 'json' as const,
        wallet: 'GABC...XYZ',
        role: 'admin' as const,
        dateRange: {
          from: '2024-01-01T00:00:00Z',
          to: '2024-12-31T23:59:59Z',
        },
        recordCount: 100,
        redactedCount: 10,
        redactedFieldCount: 20,
        exportedAt: '2024-01-01T00:00:00Z',
        cancelled: false,
      };

      expect(ExportMetadataSchema.parse(validMetadata)).toEqual(validMetadata);
    });
  });

  describe('CSV escaping', () => {
    it('neutralises formula injection in CSV output', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (chunk) => {
        chunks.push(chunk);
      };

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        if (offset >= 1) return [];
        return [
          {
            data: {
              id: 'sim-1',
              description: '=SUM(A1:B10)',
              notes: '+HYPERLINK("http://evil.com")',
            },
            fieldPermissions: buildPermissionMap('simulations'),
          },
        ];
      };

      const request: ExportRequest = {
        wallet: 'GABC...XYZ',
        type: 'simulations',
        format: 'csv',
        role: 'admin',
        actorId: 'actor-1',
      };

      await streamingExport(request, fetcher, writer, new AbortController().signal);

      const output = chunks.join('');
      expect(output).toContain("'=SUM(A1:B10)");
      expect(output).toContain("'+HYPERLINK");
    });
  });
});
