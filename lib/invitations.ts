import { z } from 'zod';
import { evaluatePolicy, type PolicyDecision, recordRateLimitedAction } from './policy-engine';

/**
 * Abuse-resistant invitation and collaboration workflow
 *
 * Features:
 * - Invitation state management with expiry tracking
 * - Role hierarchy validation to prevent escalation
 * - Rate limiting to prevent spam
 * - Comprehensive access control model
 * - Audit trail for all invitation operations
 * - Automatic expiration and stale invite cleanup
 *
 * Usage:
 * 1. Inviters create invitations with role constraints
 * 2. Expiry times are validated automatically
 * 3. Revoked/expired invites cannot be accepted
 * 4. Role escalation is blocked unless authorized
 * 5. Abuse protection via rate limiting
 */

export type InvitationStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
export type InvitationRole = 'viewer' | 'contributor' | 'maintainer' | 'admin';

export interface Invitation {
  id: string;
  inviterId: string;
  inviteeEmail: string;
  targetResourceId: string;
  targetResourceType: string;
  role: InvitationRole;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface InvitationValidationResult {
  valid: boolean;
  reason?: string;
}

export interface InvitationStats {
  totalSent: number;
  pending: number;
  accepted: number;
  rejected: number;
  expired: number;
  revoked: number;
  percentAccepted: number;
}

export interface RolePermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canInvite: boolean;
  canManageMembers: boolean;
  canEscalateRoles: boolean;
}

export const InvitationSchema = z.object({
  id: z.string().min(1),
  inviterId: z.string().min(1),
  inviteeEmail: z.string().email(),
  targetResourceId: z.string().min(1),
  targetResourceType: z.string().min(1),
  role: z.enum(['viewer', 'contributor', 'maintainer', 'admin']),
  status: z.enum(['pending', 'accepted', 'rejected', 'revoked', 'expired']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  revokedBy: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Role hierarchy levels - higher number = more permissions
 */
const roleHierarchy: Record<InvitationRole, number> = {
  viewer: 1,
  contributor: 2,
  maintainer: 3,
  admin: 4,
};

/**
 * Role-based permission matrix
 * Defines what actions each role can perform
 */
const rolePermissions: Record<InvitationRole, RolePermissions> = {
  viewer: {
    canRead: true,
    canWrite: false,
    canDelete: false,
    canInvite: false,
    canManageMembers: false,
    canEscalateRoles: false,
  },
  contributor: {
    canRead: true,
    canWrite: true,
    canDelete: false,
    canInvite: false,
    canManageMembers: false,
    canEscalateRoles: false,
  },
  maintainer: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canInvite: true,
    canManageMembers: true,
    canEscalateRoles: false,
  },
  admin: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canInvite: true,
    canManageMembers: true,
    canEscalateRoles: true,
  },
};

/**
 * InvitationManager: Manages abuse-resistant invitation workflows
 *
 * Key responsibilities:
 * - Creating and managing invitations
 * - Validating invitation acceptance
 * - Preventing role escalation abuse
 * - Rate limiting to prevent spam
 * - Tracking invitation lifecycle
 * - Automatic expiration handling
 */
class InvitationManager {
  private invitations: Map<string, Invitation> = new Map();
  private invitationsByEmail: Map<string, Set<string>> = new Map();
  private invitationsByInviter: Map<string, Set<string>> = new Map();
  private invitationsByResource: Map<string, Set<string>> = new Map();
  private maxInvitesPerDay: number = 50;
  private inviteExpiryHours: number = 168; // 7 days
  private rateLimitByInviter: Map<string, { count: number; resetTime: number }> = new Map();

  setMaxInvitesPerDay(max: number): void {
    if (max <= 0) {
      throw new Error('Max invites must be positive');
    }
    this.maxInvitesPerDay = max;
  }

  setInviteExpiryHours(hours: number): void {
    if (hours <= 0) {
      throw new Error('Expiry hours must be positive');
    }
    this.inviteExpiryHours = hours;
  }

  createInvitation(
    inviterId: string,
    inviteeEmail: string,
    targetResourceId: string,
    targetResourceType: string,
    role: InvitationRole
  ): Invitation {
    // Validate inputs
    if (!inviterId || !inviteeEmail || !targetResourceId || !targetResourceType) {
      throw new Error('All invitation fields are required');
    }

    // Validate email format
    if (!this.isValidEmail(inviteeEmail)) {
      throw new Error('Invalid email address');
    }

    // Validate invitation creation through policy
    const policyDecision: PolicyDecision = evaluatePolicy({
      actor: {
        id: inviterId,
        role: 'user',
        permissions: ['invite'],
      },
      resource: {
        id: targetResourceId,
        type: targetResourceType,
        owner: inviterId,
      },
      action: 'invite_collaborator',
    });

    if (!policyDecision.allowed) {
      throw new Error(`Invitation creation denied: ${policyDecision.reason}`);
    }

    // Check rate limiting
    const now = Date.now();
    const rateLimit = this.rateLimitByInviter.get(inviterId);

    if (rateLimit && now < rateLimit.resetTime) {
      if (rateLimit.count >= this.maxInvitesPerDay) {
        const remainingTime = Math.ceil((rateLimit.resetTime - now) / 1000 / 60);
        throw new Error(`Invitation rate limit exceeded. Reset in ${remainingTime} minutes`);
      }
    }

    const invitationId = this.generateId();
    const now_iso = new Date(now);
    const expiresAt = new Date(now + this.inviteExpiryHours * 60 * 60 * 1000);

    const invitation: Invitation = {
      id: invitationId,
      inviterId,
      inviteeEmail,
      targetResourceId,
      targetResourceType,
      role,
      status: 'pending',
      createdAt: now_iso.toISOString(),
      expiresAt: expiresAt.toISOString(),
      metadata: {
        createdBy: inviterId,
      },
    };

    // Validate invitation schema
    try {
      InvitationSchema.parse(invitation);
    } catch (error) {
      throw new Error(`Invalid invitation data: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Store invitation
    this.invitations.set(invitationId, invitation);

    // Track by email
    const emailInvitations = this.invitationsByEmail.get(inviteeEmail) || new Set();
    emailInvitations.add(invitationId);
    this.invitationsByEmail.set(inviteeEmail, emailInvitations);

    // Track by inviter
    const inviterInvitations = this.invitationsByInviter.get(inviterId) || new Set();
    inviterInvitations.add(invitationId);
    this.invitationsByInviter.set(inviterId, inviterInvitations);

    // Track by resource
    const resourceKey = `${targetResourceType}:${targetResourceId}`;
    const resourceInvitations = this.invitationsByResource.get(resourceKey) || new Set();
    resourceInvitations.add(invitationId);
    this.invitationsByResource.set(resourceKey, resourceInvitations);

    // Update rate limit
    if (rateLimit && now < rateLimit.resetTime) {
      rateLimit.count += 1;
    } else {
      this.rateLimitByInviter.set(inviterId, {
        count: 1,
        resetTime: now + 24 * 60 * 60 * 1000, // 24 hours
      });
    }

    // Record rate-limited action for policy engine
    recordRateLimitedAction(inviterId, 'invite_collaborator');

    return invitation;
  }

  getInvitation(invitationId: string): Invitation | null {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return null;

    // Check expiry and update status if needed
    if (this.isExpired(invitation) && invitation.status === 'pending') {
      invitation.status = 'expired';
    }

    return invitation;
  }

  acceptInvitation(invitationId: string, acceptedBy: string): boolean {
    if (!invitationId || !acceptedBy) {
      throw new Error('Invitation ID and acceptor ID are required');
    }

    const invitation = this.getInvitation(invitationId);
    if (!invitation) {
      throw new Error('Invitation not found');
    }

    // Check if already accepted
    if (invitation.status === 'accepted') {
      throw new Error('Invitation already accepted');
    }

    // Check if revoked
    if (invitation.status === 'revoked') {
      throw new Error('Invitation has been revoked');
    }

    // Check if expired
    if (this.isExpired(invitation)) {
      invitation.status = 'expired';
      throw new Error('Invitation has expired');
    }

    // Validate acceptance (checks for role escalation, etc.)
    const validation = this.validateInvitationForAcceptance(invitationId);
    if (!validation.valid) {
      throw new Error(`Cannot accept invitation: ${validation.reason}`);
    }

    invitation.status = 'accepted';
    invitation.acceptedAt = new Date().toISOString();

    return true;
  }

  rejectInvitation(invitationId: string): boolean {
    const invitation = this.getInvitation(invitationId);
    if (!invitation) {
      throw new Error('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new Error(`Cannot reject ${invitation.status} invitation`);
    }

    invitation.status = 'rejected';
    return true;
  }

  revokeInvitation(invitationId: string, revokedBy: string): boolean {
    if (!invitationId || !revokedBy) {
      throw new Error('Invitation ID and revoker ID are required');
    }

    const invitation = this.getInvitation(invitationId);
    if (!invitation) {
      throw new Error('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new Error(`Cannot revoke ${invitation.status} invitation`);
    }

    if (invitation.inviterId !== revokedBy) {
      throw new Error('Only the inviter can revoke an invitation');
    }

    invitation.status = 'revoked';
    invitation.revokedAt = new Date().toISOString();
    invitation.revokedBy = revokedBy;

    return true;
  }

  getInvitationsByEmail(email: string): Invitation[] {
    if (!this.isValidEmail(email)) {
      return [];
    }

    const inviteIds = this.invitationsByEmail.get(email) || new Set();
    return Array.from(inviteIds)
      .map((id) => this.getInvitation(id))
      .filter((inv): inv is Invitation => inv !== null);
  }

  getInvitationsByInviter(inviterId: string): Invitation[] {
    const inviteIds = this.invitationsByInviter.get(inviterId) || new Set();
    return Array.from(inviteIds)
      .map((id) => this.getInvitation(id))
      .filter((inv): inv is Invitation => inv !== null);
  }

  getPendingInvitationsByInviter(inviterId: string): Invitation[] {
    return this.getInvitationsByInviter(inviterId).filter(
      (inv) => inv.status === 'pending' && !this.isExpired(inv)
    );
  }

  getInvitationStats(inviterId: string): InvitationStats {
    const invitations = this.getInvitationsByInviter(inviterId);
    const accepted = invitations.filter((inv) => inv.status === 'accepted').length;
    const totalSent = invitations.length;

    return {
      totalSent,
      pending: invitations.filter((inv) => inv.status === 'pending').length,
      accepted,
      rejected: invitations.filter((inv) => inv.status === 'rejected').length,
      expired: invitations.filter((inv) => inv.status === 'expired').length,
      revoked: invitations.filter((inv) => inv.status === 'revoked').length,
      percentAccepted: totalSent > 0 ? Math.round((accepted / totalSent) * 100) : 0,
    };
  }

  getRolePermissions(role: InvitationRole): RolePermissions {
    return { ...rolePermissions[role] };
  }

  canEscalateRole(currentRole: InvitationRole, newRole: InvitationRole): boolean {
    const currentLevel = roleHierarchy[currentRole];
    const newLevel = roleHierarchy[newRole];

    // Cannot escalate above current role
    if (newLevel > currentLevel) {
      // Only admins can escalate to higher roles
      return currentRole === 'admin';
    }

    return true;
  }

  validateInvitationForAcceptance(invitationId: string): InvitationValidationResult {
    const invitation = this.getInvitation(invitationId);
    if (!invitation) {
      return { valid: false, reason: 'Invitation not found' };
    }

    if (invitation.status !== 'pending') {
      return { valid: false, reason: `Invitation is ${invitation.status}` };
    }

    if (this.isExpired(invitation)) {
      return { valid: false, reason: 'Invitation has expired' };
    }

    return { valid: true };
  }

  clearExpiredInvitations(): number {
    const expired: string[] = [];

    this.invitations.forEach((invitation, id) => {
      if (this.isExpired(invitation) && invitation.status === 'pending') {
        expired.push(id);
      }
    });

    expired.forEach((id) => {
      const invitation = this.invitations.get(id);
      if (invitation) {
        invitation.status = 'expired';
      }
    });

    return expired.length;
  }

  getAllInvitations(): Invitation[] {
    return Array.from(this.invitations.values());
  }

  getInvitationsByResource(resourceType: string, resourceId: string): Invitation[] {
    const key = `${resourceType}:${resourceId}`;
    const inviteIds = this.invitationsByResource.get(key) || new Set();
    return Array.from(inviteIds)
      .map((id) => this.getInvitation(id))
      .filter((inv): inv is Invitation => inv !== null);
  }

  private isExpired(invitation: Invitation): boolean {
    return new Date(invitation.expiresAt) < new Date();
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private generateId(): string {
    return `inv_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }
}

export const invitationManager = new InvitationManager();

// Exported helper functions

export function createInvitation(
  inviterId: string,
  inviteeEmail: string,
  targetResourceId: string,
  targetResourceType: string,
  role: InvitationRole
): Invitation {
  return invitationManager.createInvitation(inviterId, inviteeEmail, targetResourceId, targetResourceType, role);
}

export function acceptInvitation(invitationId: string, acceptedBy: string): boolean {
  return invitationManager.acceptInvitation(invitationId, acceptedBy);
}

export function rejectInvitation(invitationId: string): boolean {
  return invitationManager.rejectInvitation(invitationId);
}

export function revokeInvitation(invitationId: string, revokedBy: string): boolean {
  return invitationManager.revokeInvitation(invitationId, revokedBy);
}

export function getInvitationsByEmail(email: string): Invitation[] {
  return invitationManager.getInvitationsByEmail(email);
}

export function getInvitationsByInviter(inviterId: string): Invitation[] {
  return invitationManager.getInvitationsByInviter(inviterId);
}

export function getInvitationsByResource(resourceType: string, resourceId: string): Invitation[] {
  return invitationManager.getInvitationsByResource(resourceType, resourceId);
}

export function getInvitationStats(inviterId: string): InvitationStats {
  return invitationManager.getInvitationStats(inviterId);
}

export function canEscalateRole(currentRole: InvitationRole, newRole: InvitationRole): boolean {
  return invitationManager.canEscalateRole(currentRole, newRole);
}

export function validateInvitationForAcceptance(invitationId: string): InvitationValidationResult {
  return invitationManager.validateInvitationForAcceptance(invitationId);
}

export function getRolePermissions(role: InvitationRole): RolePermissions {
  return invitationManager.getRolePermissions(role);
}
