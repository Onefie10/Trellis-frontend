import { describe, expect, it } from 'bun:test';
import {
  classifyMetadata,
  reviewAndMinimizeMetadata,
  DEFAULT_RETENTION_POLICIES,
} from '../../lib/telemetry/minimizationReview';
import { OperationalMetadataRetentionStore } from '../../lib/telemetry/retentionStore';
import type { TelemetryEvent } from '../../lib/telemetry/types';

describe('Operational Metadata Minimization and Retention', () => {
  const baseHeartbeat: TelemetryEvent = {
    id: 'hb-101',
    ts: 1000000,
    agentRef: 'agent_test_1',
    type: 'heartbeat',
    severity: 'info',
    payload: {
      state: 'ok',
    },
  };

  const baseTask: TelemetryEvent = {
    id: 'task-202',
    ts: 1000000,
    agentRef: 'agent_test_2',
    type: 'task_started',
    severity: 'info',
    payload: {
      taskKind: 'wallet_sign',
      correlationId: 'corr_xyz',
    },
  };

  const baseError: TelemetryEvent = {
    id: 'err-303',
    ts: 1000000,
    agentRef: 'agent_test_3',
    type: 'error',
    severity: 'critical',
    payload: {
      code: 'E_FAIL',
      message: 'Failed to process request for user@example.com with key SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };

  describe('Classification', () => {
    it('classifies heartbeats and non-error status as PUBLIC', () => {
      expect(classifyMetadata(baseHeartbeat)).toBe('PUBLIC');
    });

    it('classifies standard task operations as OPERATIONAL', () => {
      expect(classifyMetadata(baseTask)).toBe('OPERATIONAL');
    });

    it('classifies errors and critical events as SENSITIVE', () => {
      expect(classifyMetadata(baseError)).toBe('SENSITIVE');
    });
  });

  describe('Minimization Review (Unnecessary fields removed & secrets redacted)', () => {
    it('removes unnecessary fields outside the operational contract', () => {
      const noisyEvent: TelemetryEvent = {
        ...baseTask,
        payload: {
          taskKind: 'wallet_sign',
          correlationId: 'corr_xyz',
          // Unnecessary fields
          internalQueryPlan: 'SELECT * FROM ops',
          unboundedContext: 'random arbitrary debugging fluff',
          extraPayload: { nested: true },
        } as unknown as TelemetryEvent['payload'],
      };

      const review = reviewAndMinimizeMetadata(noisyEvent, DEFAULT_RETENTION_POLICIES, 1000000);

      expect(review.accepted).toBe(true);
      expect(review.retainedFields).toContain('taskKind');
      expect(review.retainedFields).toContain('correlationId');
      expect(review.droppedFields).toContain('internalQueryPlan');
      expect(review.droppedFields).toContain('unboundedContext');
      expect(review.droppedFields).toContain('extraPayload');
      expect(review.event.payload).toEqual({
        taskKind: 'wallet_sign',
        correlationId: 'corr_xyz',
      });
    });

    it('redacts emails, long tokens, and secret seeds in messages', () => {
      const review = reviewAndMinimizeMetadata(baseError, DEFAULT_RETENTION_POLICIES, 1000000);

      expect(review.accepted).toBe(true);
      expect(review.redactedFields).toContain('message');
      expect(review.event.payload?.message).not.toContain('user@example.com');
      expect(review.event.payload?.message).toContain('[redacted_email]');
      expect(review.event.payload?.message).toContain('[redacted_stellar_seed]');
    });

    it('drops explicitly restricted keys like passwords, private keys, tokens', () => {
      const secretPayloadEvent: TelemetryEvent = {
        ...baseTask,
        payload: {
          taskKind: 'wallet_sign',
          password: 'supersecretpassword',
          private_key: 'privatekey123',
          token: 'jwt-token-val',
        } as unknown as TelemetryEvent['payload'],
      };

      const review = reviewAndMinimizeMetadata(secretPayloadEvent, DEFAULT_RETENTION_POLICIES, 1000000);

      expect(review.droppedFields).toContain('password');
      expect(review.droppedFields).toContain('private_key');
      expect(review.droppedFields).toContain('token');
      expect(review.event.payload?.taskKind).toBe('wallet_sign');
    });
  });

  describe('Retention Enforcement Store & Testable Deletion', () => {
    it('enforces retention window expiration', () => {
      const store = new OperationalMetadataRetentionStore({
        SENSITIVE: {
          classification: 'SENSITIVE',
          retentionWindowMs: 1000, // 1 second retention for test
        },
        PUBLIC: {
          classification: 'PUBLIC',
          retentionWindowMs: 10000, // 10 second retention
        },
      });

      const t0 = 10000;
      store.ingest(baseError, t0);
      store.ingest(baseHeartbeat, t0);

      expect(store.getAllRecords()).toHaveLength(2);

      // At t0 + 500ms: nothing expired
      const sweepEarly = store.enforceRetention(t0 + 500);
      expect(sweepEarly.expiredCount).toBe(0);
      expect(sweepEarly.retainedCount).toBe(2);
      expect(store.getAllRecords()).toHaveLength(2);

      // At t0 + 1500ms: sensitive record expired
      const sweepLater = store.enforceRetention(t0 + 1500);
      expect(sweepLater.expiredCount).toBe(1);
      expect(sweepLater.deletedCount).toBe(1);
      expect(sweepLater.retainedCount).toBe(1);

      // Remaining record should be the public heartbeat
      const remaining = store.getAllRecords();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(baseHeartbeat.id);

      // Audit log records the deletion
      const auditLog = store.getAuditLog();
      expect(auditLog.length).toBeGreaterThanOrEqual(1);
      const deletionEntry = auditLog.find((a) => a.eventId === baseError.id);
      expect(deletionEntry).toBeDefined();
      expect(deletionEntry?.reason).toBe('expired');
      expect(deletionEntry?.classification).toBe('SENSITIVE');
    });

    it('supports testable explicit record deletion', () => {
      const store = new OperationalMetadataRetentionStore();
      store.ingest(baseTask, 10000);

      expect(store.getRecord(baseTask.id)).toBeDefined();

      const deleted = store.deleteRecord(baseTask.id, 'manual', 10500);
      expect(deleted).toBe(true);
      expect(store.getRecord(baseTask.id)).toBeUndefined();

      const audit = store.getAuditLog().find((a) => a.eventId === baseTask.id);
      expect(audit).toBeDefined();
      expect(audit?.reason).toBe('manual');
    });

    it('enforces tier capacity quota and prunes oldest entries', () => {
      const store = new OperationalMetadataRetentionStore({
        OPERATIONAL: {
          classification: 'OPERATIONAL',
          retentionWindowMs: 100000,
          maxEntries: 2,
        },
      });

      store.ingest({ ...baseTask, id: 'event-1' }, 1000);
      store.ingest({ ...baseTask, id: 'event-2' }, 2000);
      store.ingest({ ...baseTask, id: 'event-3' }, 3000);

      const records = store.getAllRecords();
      expect(records).toHaveLength(2);
      // event-1 should have been pruned as oldest
      expect(store.getRecord('event-1')).toBeUndefined();
      expect(store.getRecord('event-2')).toBeDefined();
      expect(store.getRecord('event-3')).toBeDefined();

      const audit = store.getAuditLog().find((a) => a.eventId === 'event-1');
      expect(audit?.reason).toBe('quota_exceeded');
    });

    it('supports classification-wide purge for emergency containment', () => {
      const store = new OperationalMetadataRetentionStore();
      store.ingest(baseError, 1000);
      store.ingest(baseHeartbeat, 1000);

      const purgedCount = store.purgeClassification('SENSITIVE', 1500);
      expect(purgedCount).toBe(1);
      expect(store.getRecord(baseError.id)).toBeUndefined();
      expect(store.getRecord(baseHeartbeat.id)).toBeDefined();
    });
  });
});
