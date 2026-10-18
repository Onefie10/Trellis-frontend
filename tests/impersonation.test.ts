import {
  startImpersonation,
  endImpersonation,
  isImpersonationActive,
  getImpersonationSession,
  canPerformActionInImpersonation,
  recordImpersonationAction,
  getImpersonationAuditLog,
  getActiveSessions,
  getSessionsForAdmin,
  getSessionsForTarget,
  impersonationManager,
} from '@/lib/impersonation';

describe('Impersonation Manager', () => {
  beforeEach(() => {
    impersonationManager.clearExpiredSessions();
    impersonationManager.setMaxDuration(30);
  });

  describe('Session Management', () => {
    it('should create an impersonation session', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');

      expect(session).toBeDefined();
      expect(session.adminId).toBe('admin1');
      expect(session.targetUserId).toBe('user1');
      expect(session.scope).toBe('read_only');
      expect(session.isActive).toBe(true);
    });

    it('should enforce max duration', () => {
      impersonationManager.setMaxDuration(15);
      const session = startImpersonation('admin1', 'user1', 'read_only', 60);

      const startTime = new Date(session.startedAt);
      const endTime = new Date(session.expiresAt);
      const durationMinutes = (endTime.getTime() - startTime.getTime()) / (60 * 1000);

      expect(durationMinutes).toBe(15);
    });

    it('should retrieve an active session', () => {
      const created = startImpersonation('admin1', 'user1', 'read_only');
      const retrieved = getImpersonationSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should mark session as inactive when ended', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      endImpersonation(session.id, 'testing complete');

      const retrieved = getImpersonationSession(session.id);
      expect(retrieved?.isActive).toBe(false);
    });
  });

  describe('Session Expiry', () => {
    it('should detect expired sessions', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only', 0.001); // ~0.06 seconds

      // Wait for expiry
      const checkActive = () => isImpersonationActive(session.id);

      expect(checkActive()).toBe(false);
    });

    it('should expire sessions without deleting their audit history', () => {
      jest.useFakeTimers();
      const session1 = startImpersonation('admin1', 'user1', 'read_only', 0.001);
      const session2 = startImpersonation('admin2', 'user2', 'debug');

      jest.advanceTimersByTime(61);
      impersonationManager.clearExpiredSessions();

      expect(getImpersonationSession(session1.id)?.isActive).toBe(false);
      expect(getImpersonationAuditLog(session1.id).map((event) => event.action)).toContain(
        'session_expired',
      );
      expect(getImpersonationSession(session2.id)).toBeDefined();
      jest.useRealTimers();
    });
  });

  describe('Scope and Permissions', () => {
    it('should allow read actions in read_only scope', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');

      expect(canPerformActionInImpersonation(session.id, 'view_user_data')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'view_wallet')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'view_transactions')).toBe(true);
    });

    it('should block write actions in read_only scope', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');

      expect(canPerformActionInImpersonation(session.id, 'create_agent')).toBe(false);
      expect(canPerformActionInImpersonation(session.id, 'transfer_funds')).toBe(false);
      expect(canPerformActionInImpersonation(session.id, 'delete_user')).toBe(false);
    });

    it('should allow limited write in limited_write scope', () => {
      const session = startImpersonation('admin1', 'user1', 'limited_write');

      expect(canPerformActionInImpersonation(session.id, 'view_user_data')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'update_profile')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'create_agent')).toBe(true);
    });

    it('should block dangerous mutations in limited_write scope', () => {
      const session = startImpersonation('admin1', 'user1', 'limited_write');

      expect(canPerformActionInImpersonation(session.id, 'transfer_funds')).toBe(false);
      expect(canPerformActionInImpersonation(session.id, 'delete_user')).toBe(false);
      expect(canPerformActionInImpersonation(session.id, 'escalate_role')).toBe(false);
    });

    it('should allow debug scope actions except financial operations', () => {
      const session = startImpersonation('admin1', 'user1', 'debug');

      expect(canPerformActionInImpersonation(session.id, 'view_user_data')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'create_agent')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'delete_agent')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'test_operations')).toBe(true);
      expect(canPerformActionInImpersonation(session.id, 'transfer_funds')).toBe(false);
    });
  });

  describe('Audit Logging', () => {
    it('should record session start in audit log', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');

      expect(session.auditLog.length).toBe(1);
      expect(session.auditLog[0].action).toBe('session_started');
      expect(session.auditLog[0].result).toBe('success');
    });

    it('should record action in audit log', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      impersonationManager.recordAction(session.id, 'view_user_data', 'user:user1', 'success');

      const auditLog = impersonationManager.getAuditLog(session.id);
      expect(auditLog.length).toBe(2);
      expect(auditLog[1].action).toBe('view_user_data');
    });

    it('does not expose mutable references to its audit history', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      const sessionSnapshot = getImpersonationSession(session.id)!;
      sessionSnapshot.auditLog[0].action = 'rewritten';
      sessionSnapshot.auditLog.push({
        id: 'forged',
        timestamp: new Date().toISOString(),
        action: 'forged',
        resource: 'user:user1',
        result: 'success',
      });

      const auditSnapshot = getImpersonationAuditLog(session.id);
      auditSnapshot[0].action = 'rewritten again';
      expect(getImpersonationAuditLog(session.id).map((event) => event.action)).toEqual([
        'session_started',
      ]);
    });

    it('should record blocked action in audit log', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      impersonationManager.recordAction(
        session.id,
        'transfer_funds',
        'wallet:wallet1',
        'blocked',
        { amount: '1000' }
      );

      const auditLog = impersonationManager.getAuditLog(session.id);
      const blockedEvent = auditLog[auditLog.length - 1];
      expect(blockedEvent.result).toBe('blocked');
      expect(blockedEvent.metadata?.amount).toBe('1000');
    });

    it('should record session end in audit log', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      endImpersonation(session.id, 'debugging complete');

      const auditLog = impersonationManager.getAuditLog(session.id);
      const endEvent = auditLog[auditLog.length - 1];
      expect(endEvent.action).toBe('session_ended');
      expect(endEvent.metadata?.reason).toBe('debugging complete');
    });
  });

  describe('Session Queries', () => {
    it('should get all active sessions', () => {
      const session1 = startImpersonation('admin1', 'user1', 'read_only');
      const session2 = startImpersonation('admin1', 'user2', 'debug');

      const active = impersonationManager.getActiveSessions();
      expect(active.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter sessions by admin', () => {
      const session1 = startImpersonation('admin1', 'user1', 'read_only');
      const session2 = startImpersonation('admin1', 'user2', 'debug');
      const session3 = startImpersonation('admin2', 'user3', 'limited_write');

      const admin1Sessions = impersonationManager.getSessionsForAdmin('admin1');
      expect(admin1Sessions.length).toBeGreaterThanOrEqual(2);

      const admin1Targets = admin1Sessions.map((s) => s.targetUserId);
      expect(admin1Targets).toContain('user1');
      expect(admin1Targets).toContain('user2');
    });
  });

  describe('Permissions Query', () => {
    it('should return correct permissions for scope', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      const perms = impersonationManager.getPermissions(session.id);

      expect(perms).toBeDefined();
      expect(perms?.canRead).toBe(true);
      expect(perms?.canWrite).toBe(false);
      expect(perms?.canDelete).toBe(false);
      expect(perms?.canTransfer).toBe(false);
    });

    it('should return null for invalid session', () => {
      const perms = impersonationManager.getPermissions('invalid-id');
      expect(perms).toBeNull();
    });
  });

  describe('Session Validation', () => {
    it('should validate active session', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      expect(impersonationManager.validateSession(session.id)).toBe(true);
    });

    it('should reject invalid session ID', () => {
      expect(impersonationManager.validateSession('invalid-id')).toBe(false);
    });

    it('should reject ended session', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      endImpersonation(session.id);

      expect(impersonationManager.validateSession(session.id)).toBe(false);
    });

    it('should reject expired session', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only', 0.001);

      expect(impersonationManager.validateSession(session.id)).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should throw when ending non-existent session', () => {
      expect(() => endImpersonation('invalid-id')).toThrow('Session not found');
    });

    it('should return false for expired session action', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only', 0.001);

      expect(canPerformActionInImpersonation(session.id, 'view_user_data')).toBe(false);
    });

    it('should throw when impersonating self', () => {
      expect(() => startImpersonation('user1', 'user1', 'read_only')).toThrow('Cannot impersonate yourself');
    });

    it('should throw for invalid session parameters', () => {
      expect(() => startImpersonation('', 'user1', 'read_only')).toThrow();
      expect(() => startImpersonation('admin1', '', 'read_only')).toThrow();
    });
  });

  describe('Session Tracking', () => {
    it('should track sessions by target user', () => {
      const session1 = startImpersonation('admin1', 'user1', 'read_only');
      const session2 = startImpersonation('admin2', 'user1', 'debug');
      const session3 = startImpersonation('admin1', 'user2', 'limited_write');

      const user1Sessions = getSessionsForTarget('user1');
      expect(user1Sessions.length).toBeGreaterThanOrEqual(2);

      const user1Admins = user1Sessions.map((s) => s.adminId);
      expect(user1Admins).toContain('admin1');
      expect(user1Admins).toContain('admin2');
    });

    it('should get session statistics', () => {
      const session1 = startImpersonation('admin1', 'user1', 'read_only');
      const session2 = startImpersonation('admin1', 'user2', 'debug');

      const stats = impersonationManager.getSessionStats();
      expect(stats.active).toBeGreaterThanOrEqual(2);
      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(stats.expired).toBeGreaterThanOrEqual(0);
    });

    it('should support session metadata', () => {
      const session = startImpersonation(
        'admin1',
        'user1',
        'read_only',
        30,
        {
          reason: 'User reported transaction issue',
          ipAddress: '192.168.1.1',
        }
      );

      expect(session.reason).toBe('User reported transaction issue');
      const auditLog = getImpersonationAuditLog(session.id);
      expect(auditLog[0].metadata?.ipAddress).toBe('192.168.1.1');
    });
  });

  describe('Exported Helper Functions', () => {
    it('should export action recording function', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');
      recordImpersonationAction(session.id, 'view_wallet', 'wallet:wallet1', 'success');

      const log = getImpersonationAuditLog(session.id);
      const actionEvent = log.find((e) => e.action === 'view_wallet');
      expect(actionEvent).toBeDefined();
    });

    it('should export session query functions', () => {
      const session = startImpersonation('admin1', 'user1', 'read_only');

      const active = getActiveSessions();
      expect(active.length).toBeGreaterThan(0);

      const adminSessions = getSessionsForAdmin('admin1');
      expect(adminSessions.length).toBeGreaterThan(0);

      const targetSessions = getSessionsForTarget('user1');
      expect(targetSessions.length).toBeGreaterThan(0);
    });
  });
});
