import { z } from 'zod';
import { evaluatePolicy, type PolicyDecision } from './policy-engine';

/**
 * Scoped maintainer impersonation for support debugging
 *
 * Features:
 * - Time-limited impersonation sessions with configurable durations
 * - Scope-based permission model (read_only, limited_write, debug)
 * - Comprehensive audit logging of all actions
 * - Visible session indicators and status tracking
 * - Automated session expiration and cleanup
 * - Policy-driven access control
 *
 * Usage:
 * 1. Admin calls startImpersonation() to create a session
 * 2. Session is time-limited and scope-restricted
 * 3. All actions are logged to audit trail
 * 4. Session auto-expires after configured duration
 * 5. Sensitive actions blocked based on scope
 */

export type ImpersonationScope = 'read_only' | 'limited_write' | 'debug';
export type AuditEventResult = 'success' | 'blocked' | 'error';

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: string;
  resource: string;
  result: AuditEventResult;
  metadata?: Record<string, unknown>;
}

export interface ImpersonationPermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canTransfer: boolean;
  allowedActions: string[];
  blockedActions: string[];
}

export interface ImpersonationSession {
  id: string;
  adminId: string;
  targetUserId: string;
  startedAt: string;
  expiresAt: string;
  scope: ImpersonationScope;
  auditLog: AuditEvent[];
  isActive: boolean;
  reason?: string;
}

export interface SessionMetadata {
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
}

function snapshotSession(session: ImpersonationSession): ImpersonationSession {
  return structuredClone(session);
}

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  action: z.string().min(1),
  resource: z.string().min(1),
  result: z.enum(['success', 'blocked', 'error']),
  metadata: z.record(z.unknown()).optional(),
});

export const ImpersonationSessionSchema = z.object({
  id: z.string().min(1),
  adminId: z.string().min(1),
  targetUserId: z.string().min(1),
  startedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  scope: z.enum(['read_only', 'limited_write', 'debug']),
  auditLog: z.array(AuditEventSchema),
  isActive: z.boolean(),
  reason: z.string().optional(),
});

/**
 * Scope-based permission mappings
 * Each scope defines what actions are allowed/blocked
 */
const scopePermissions: Record<ImpersonationScope, ImpersonationPermissions> = {
  read_only: {
    canRead: true,
    canWrite: false,
    canDelete: false,
    canTransfer: false,
    allowedActions: ['view_user_data', 'view_wallet', 'view_transactions', 'view_agents'],
    blockedActions: ['create', 'update', 'delete', 'transfer', 'impersonate'],
  },
  limited_write: {
    canRead: true,
    canWrite: true,
    canDelete: false,
    canTransfer: false,
    allowedActions: [
      'view_user_data',
      'update_profile',
      'create_agent',
      'view_wallet',
      'view_transactions',
    ],
    blockedActions: ['delete_user', 'transfer_funds', 'delete_data', 'escalate_role'],
  },
  debug: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canTransfer: false,
    allowedActions: [
      'view_user_data',
      'update_profile',
      'create_agent',
      'delete_agent',
      'view_wallet',
      'view_transactions',
      'test_operations',
    ],
    blockedActions: ['transfer_funds', 'escalate_role', 'impersonate'],
  },
};

/**
 * ImpersonationManager: Handles scoped maintainer impersonation
 *
 * Key responsibilities:
 * - Creating time-limited impersonation sessions
 * - Validating sessions with policy engine
 * - Tracking permissions and allowed actions
 * - Logging all actions to audit trail
 * - Managing session lifecycle (creation, use, expiration)
 * - Enforcing scope-based restrictions
 */
class ImpersonationManager {
  private sessions: Map<string, ImpersonationSession> = new Map();
  private sessionsByAdmin: Map<string, Set<string>> = new Map();
  private sessionsByTarget: Map<string, Set<string>> = new Map();
  private maxDurationMinutes: number = 30;
  private defaultDurationMinutes: number = 15;
  private cleanupIntervalMs: number = 5 * 60 * 1000; // 5 minutes

  constructor() {
    // Periodic cleanup of expired sessions
    this.startCleanupInterval();
  }

  setMaxDuration(minutes: number): void {
    if (minutes <= 0) {
      throw new Error('Max duration must be positive');
    }
    this.maxDurationMinutes = minutes;
  }

  setDefaultDuration(minutes: number): void {
    if (minutes <= 0) {
      throw new Error('Default duration must be positive');
    }
    this.defaultDurationMinutes = minutes;
  }

  startSession(
    adminId: string,
    targetUserId: string,
    scope: ImpersonationScope = 'read_only',
    durationMinutes?: number,
    metadata?: SessionMetadata
  ): ImpersonationSession {
    if (!adminId || !targetUserId) {
      throw new Error('Admin ID and Target User ID are required');
    }

    if (adminId === targetUserId) {
      throw new Error('Cannot impersonate yourself');
    }

    // Validate admin permissions through policy engine
    const policyDecision: PolicyDecision = evaluatePolicy({
      actor: {
        id: adminId,
        role: 'admin',
        permissions: ['impersonate'],
      },
      resource: {
        id: targetUserId,
        type: 'user',
        owner: 'system',
      },
      action: 'impersonate_user',
    });

    if (!policyDecision.allowed) {
      throw new Error(`Impersonation denied: ${policyDecision.reason}`);
    }

    const now = new Date();
    const requestedDuration = durationMinutes || this.defaultDurationMinutes;
    const duration = Math.min(requestedDuration, this.maxDurationMinutes);
    const expiresAt = new Date(now.getTime() + duration * 60 * 1000);

    const sessionId = this.generateSessionId();
    const session: ImpersonationSession = {
      id: sessionId,
      adminId,
      targetUserId,
      startedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      scope,
      auditLog: [],
      isActive: true,
      reason: metadata?.reason,
    };

    // Log session start
    session.auditLog.push({
      id: this.generateEventId(),
      timestamp: now.toISOString(),
      action: 'session_started',
      resource: `user:${targetUserId}`,
      result: 'success',
      metadata: {
        scope,
        durationMinutes: duration,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
        reason: metadata?.reason,
      },
    });

    // Validate session schema
    try {
      ImpersonationSessionSchema.parse(session);
    } catch (error) {
      throw new Error(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.sessions.set(sessionId, session);

    // Track by admin and target
    const adminSessions = this.sessionsByAdmin.get(adminId) || new Set();
    adminSessions.add(sessionId);
    this.sessionsByAdmin.set(adminId, adminSessions);

    const targetSessions = this.sessionsByTarget.get(targetUserId) || new Set();
    targetSessions.add(sessionId);
    this.sessionsByTarget.set(targetUserId, targetSessions);

    return snapshotSession(session);
  }

  endSession(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (!session.isActive || this.isExpired(session)) {
      this.expireSession(session);
      throw new Error('Session is already inactive');
    }

    session.isActive = false;
    session.auditLog.push({
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      action: 'session_ended',
      resource: `user:${session.targetUserId}`,
      result: 'success',
      metadata: { reason },
    });
  }

  getSession(sessionId: string): ImpersonationSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Mark as expired if needed
    if (this.isExpired(session)) {
      this.expireSession(session);
    }

    return snapshotSession(session);
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;
    return session.isActive && !this.isExpired(session);
  }

  canPerformAction(sessionId: string, action: string): boolean {
    if (!this.isSessionActive(sessionId)) {
      return false;
    }

    const session = this.getSession(sessionId);
    if (!session) return false;

    const permissions = scopePermissions[session.scope];
    const isAllowed = permissions.allowedActions.includes(action);
    const isBlocked = permissions.blockedActions.includes(action);

    return isAllowed && !isBlocked;
  }

  recordAction(
    sessionId: string,
    action: string,
    resource: string,
    result: AuditEventResult,
    metadata?: Record<string, unknown>
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (!session.isActive || this.isExpired(session)) {
      this.expireSession(session);
      throw new Error('Cannot append an action to an inactive session');
    }

    session.auditLog.push({
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      action,
      resource,
      result,
      metadata: metadata ? structuredClone(metadata) : undefined,
    });
  }

  getPermissions(sessionId: string): ImpersonationPermissions | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return { ...scopePermissions[session.scope] };
  }

  getAuditLog(sessionId: string): AuditEvent[] {
    const session = this.getSession(sessionId);
    if (!session) return [];
    return structuredClone(session.auditLog);
  }

  getActiveSessions(): ImpersonationSession[] {
    return Array.from(this.sessions.values()).filter((session) =>
      this.isSessionActive(session.id)
    );
  }

  getSessionsForAdmin(adminId: string): ImpersonationSession[] {
    const sessionIds = this.sessionsByAdmin.get(adminId) || new Set();
    return Array.from(sessionIds)
      .map((id) => this.getSession(id))
      .filter((s): s is ImpersonationSession => s !== null);
  }

  getSessionsForTarget(targetUserId: string): ImpersonationSession[] {
    const sessionIds = this.sessionsByTarget.get(targetUserId) || new Set();
    return Array.from(sessionIds)
      .map((id) => this.getSession(id))
      .filter((s): s is ImpersonationSession => s !== null);
  }

  validateSession(sessionId: string): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) return false;
      ImpersonationSessionSchema.parse(session);
      return this.isSessionActive(sessionId);
    } catch {
      return false;
    }
  }

  clearExpiredSessions(): number {
    let cleared = 0;
    this.sessions.forEach((session) => {
      if (session.isActive && this.isExpired(session)) {
        this.expireSession(session);
        cleared += 1;
      }
    });

    return cleared;
  }

  getAllSessions(): ImpersonationSession[] {
    return Array.from(this.sessions.values(), snapshotSession);
  }

  getSessionStats(): { active: number; total: number; expired: number } {
    const sessions = Array.from(this.sessions.values());
    return {
      active: sessions.filter((s) => this.isSessionActive(s.id)).length,
      total: sessions.length,
      expired: sessions.filter((s) => this.isExpired(s)).length,
    };
  }

  private isExpired(session: ImpersonationSession): boolean {
    return new Date(session.expiresAt).getTime() <= Date.now();
  }

  private expireSession(session: ImpersonationSession): void {
    if (!session.isActive) return;
    session.isActive = false;
    session.auditLog.push({
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      action: 'session_expired',
      resource: `user:${session.targetUserId}`,
      result: 'success',
    });
  }

  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private startCleanupInterval(): void {
    if (typeof setInterval !== 'undefined') {
      setInterval(() => {
        this.clearExpiredSessions();
      }, this.cleanupIntervalMs);
    }
  }
}

export const impersonationManager = new ImpersonationManager();

// Exported helper functions

export function startImpersonation(
  adminId: string,
  targetUserId: string,
  scope?: ImpersonationScope,
  durationMinutes?: number,
  metadata?: SessionMetadata
): ImpersonationSession {
  return impersonationManager.startSession(adminId, targetUserId, scope, durationMinutes, metadata);
}

export function endImpersonation(sessionId: string, reason?: string): void {
  impersonationManager.endSession(sessionId, reason);
}

export function isImpersonationActive(sessionId: string): boolean {
  return impersonationManager.isSessionActive(sessionId);
}

export function getImpersonationSession(sessionId: string): ImpersonationSession | null {
  return impersonationManager.getSession(sessionId);
}

export function canPerformActionInImpersonation(sessionId: string, action: string): boolean {
  return impersonationManager.canPerformAction(sessionId, action);
}

export function recordImpersonationAction(
  sessionId: string,
  action: string,
  resource: string,
  result: AuditEventResult,
  metadata?: Record<string, unknown>
): void {
  impersonationManager.recordAction(sessionId, action, resource, result, metadata);
}

export function getImpersonationAuditLog(sessionId: string): AuditEvent[] {
  return impersonationManager.getAuditLog(sessionId);
}

export function getActiveSessions(): ImpersonationSession[] {
  return impersonationManager.getActiveSessions();
}

export function getSessionsForAdmin(adminId: string): ImpersonationSession[] {
  return impersonationManager.getSessionsForAdmin(adminId);
}

export function getSessionsForTarget(targetUserId: string): ImpersonationSession[] {
  return impersonationManager.getSessionsForTarget(targetUserId);
}
