import {
  createInvitation,
  acceptInvitation,
  rejectInvitation,
  revokeInvitation,
  getInvitationsByEmail,
  getInvitationsByInviter,
  getInvitationsByResource,
  getInvitationStats,
  canEscalateRole,
  validateInvitationForAcceptance,
  getRolePermissions,
  invitationManager,
} from '@/lib/invitations';

describe('Invitation Manager', () => {
  beforeEach(() => {
    invitationManager.setMaxInvitesPerDay(50);
    invitationManager.setInviteExpiryHours(168);
  });

  describe('Invitation Creation', () => {
    it('should create a new invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      expect(invite).toBeDefined();
      expect(invite.inviterId).toBe('user1');
      expect(invite.inviteeEmail).toBe('newuser@example.com');
      expect(invite.role).toBe('contributor');
      expect(invite.status).toBe('pending');
    });

    it('should enforce rate limiting', () => {
      invitationManager.setMaxInvitesPerDay(2);

      createInvitation('user1', 'email1@example.com', 'project1', 'project', 'contributor');
      createInvitation('user1', 'email2@example.com', 'project1', 'project', 'contributor');

      expect(() => {
        createInvitation('user1', 'email3@example.com', 'project1', 'project', 'contributor');
      }).toThrow('rate limit exceeded');
    });

    it('should set expiry time correctly', () => {
      const now = Date.now();
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'viewer'
      );

      const expiryTime = new Date(invite.expiresAt).getTime();
      const expectedExpiry = now + 168 * 60 * 60 * 1000; // 7 days

      expect(Math.abs(expiryTime - expectedExpiry)).toBeLessThan(1000);
    });
  });

  describe('Invitation Acceptance', () => {
    it('should accept a pending invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      const accepted = acceptInvitation(invite.id, 'newuser@example.com');
      expect(accepted).toBe(true);

      const updated = invitationManager.getInvitation(invite.id);
      expect(updated?.status).toBe('accepted');
      expect(updated?.acceptedAt).toBeDefined();
    });

    it('should reject accepting already accepted invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      acceptInvitation(invite.id, 'newuser@example.com');

      expect(() => {
        acceptInvitation(invite.id, 'newuser@example.com');
      }).toThrow('already accepted');
    });

    it('should reject accepting revoked invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      revokeInvitation(invite.id, 'user1');

      expect(() => {
        acceptInvitation(invite.id, 'newuser@example.com');
      }).toThrow('revoked');
    });

    it('should reject accepting expired invitation', () => {
      invitationManager.setInviteExpiryHours(0.001); // ~3.6 seconds
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      expect(() => {
        acceptInvitation(invite.id, 'newuser@example.com');
      }).toThrow('expired');
    });
  });

  describe('Invitation Revocation', () => {
    it('should revoke a pending invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      const revoked = revokeInvitation(invite.id, 'user1');
      expect(revoked).toBe(true);

      const updated = invitationManager.getInvitation(invite.id);
      expect(updated?.status).toBe('revoked');
      expect(updated?.revokedBy).toBe('user1');
    });

    it('should only allow inviter to revoke', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      expect(() => {
        revokeInvitation(invite.id, 'user2');
      }).toThrow('Only the inviter');
    });

    it('should reject revoking already accepted invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      acceptInvitation(invite.id, 'newuser@example.com');

      expect(() => {
        revokeInvitation(invite.id, 'user1');
      }).toThrow('Cannot revoke');
    });
  });

  describe('Invitation Queries', () => {
    it('should retrieve invitations by email', () => {
      const email = 'newuser@example.com';

      createInvitation('user1', email, 'project1', 'project', 'contributor');
      createInvitation('user2', email, 'project2', 'project', 'viewer');

      const invites = getInvitationsByEmail(email);
      expect(invites.length).toBeGreaterThanOrEqual(2);
      expect(invites.every((inv) => inv.inviteeEmail === email)).toBe(true);
    });

    it('should get stats for inviter', () => {
      const inviterId = 'user1';

      createInvitation(inviterId, 'email1@example.com', 'project1', 'project', 'contributor');
      const invite2 = createInvitation(inviterId, 'email2@example.com', 'project1', 'project', 'viewer');

      acceptInvitation(invite2.id, 'email2@example.com');

      const stats = getInvitationStats(inviterId);
      expect(stats.totalSent).toBeGreaterThanOrEqual(2);
      expect(stats.pending).toBeGreaterThanOrEqual(1);
      expect(stats.accepted).toBeGreaterThanOrEqual(1);
    });

    it('should track invitation status distribution', () => {
      const inviterId = 'user1';

      const invite1 = createInvitation(inviterId, 'email1@example.com', 'project1', 'project', 'contributor');
      const invite2 = createInvitation(inviterId, 'email2@example.com', 'project1', 'project', 'viewer');
      const invite3 = createInvitation(inviterId, 'email3@example.com', 'project1', 'project', 'contributor');

      acceptInvitation(invite2.id, 'email2@example.com');
      revokeInvitation(invite3.id, inviterId);

      const stats = getInvitationStats(inviterId);
      expect(stats.pending).toBeGreaterThanOrEqual(1);
      expect(stats.accepted).toBeGreaterThanOrEqual(1);
      expect(stats.revoked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Role Management', () => {
    it('should allow role escalation for admin', () => {
      expect(canEscalateRole('admin', 'maintainer')).toBe(true);
      expect(canEscalateRole('admin', 'contributor')).toBe(true);
      expect(canEscalateRole('admin', 'viewer')).toBe(true);
    });

    it('should prevent role escalation for non-admin', () => {
      expect(canEscalateRole('contributor', 'maintainer')).toBe(false);
      expect(canEscalateRole('viewer', 'admin')).toBe(false);
    });

    it('should allow role demotion', () => {
      expect(canEscalateRole('admin', 'viewer')).toBe(true);
      expect(canEscalateRole('maintainer', 'contributor')).toBe(true);
    });

    it('should provide correct permissions per role', () => {
      const viewerPerms = invitationManager.getRolePermissions('viewer');
      expect(viewerPerms.canRead).toBe(true);
      expect(viewerPerms.canWrite).toBe(false);
      expect(viewerPerms.canInvite).toBe(false);

      const maintainerPerms = invitationManager.getRolePermissions('maintainer');
      expect(maintainerPerms.canRead).toBe(true);
      expect(maintainerPerms.canWrite).toBe(true);
      expect(maintainerPerms.canInvite).toBe(true);
      expect(maintainerPerms.canEscalateRoles).toBe(false);

      const adminPerms = invitationManager.getRolePermissions('admin');
      expect(adminPerms.canEscalateRoles).toBe(true);
    });
  });

  describe('Expiry Handling', () => {
    it('should mark invitation as expired', () => {
      invitationManager.setInviteExpiryHours(0.001);
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      invitationManager.clearExpiredInvitations();
      const retrieved = invitationManager.getInvitation(invite.id);

      expect(retrieved?.status).toBe('expired');
    });

    it('should validate invitation for acceptance', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      const validation = invitationManager.validateInvitationForAcceptance(invite.id);
      expect(validation.valid).toBe(true);
    });

    it('should reject validation for non-pending invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      acceptInvitation(invite.id, 'newuser@example.com');

      const validation = invitationManager.validateInvitationForAcceptance(invite.id);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('accepted');
    });

    it('should reject validation for expired invitation', () => {
      invitationManager.setInviteExpiryHours(0.001);
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      const validation = invitationManager.validateInvitationForAcceptance(invite.id);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('expired');
    });
  });

  describe('Error Handling', () => {
    it('should throw for invalid email in invitation creation', () => {
      expect(() => {
        createInvitation('user1', 'not-an-email', 'project1', 'project', 'contributor');
      }).toThrow();
    });

    it('should throw for non-existent invitation operations', () => {
      expect(() => {
        acceptInvitation('non-existent-id', 'user1');
      }).toThrow('not found');
    });

    it('should handle missing invitation gracefully', () => {
      const result = invitationManager.validateInvitationForAcceptance('non-existent-id');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('should throw for invalid email format', () => {
      expect(() => {
        createInvitation('user1', 'invalid.email', 'project1', 'project', 'contributor');
      }).toThrow();
    });

    it('should throw for missing required fields', () => {
      expect(() => {
        createInvitation('', 'user@example.com', 'project1', 'project', 'contributor');
      }).toThrow();
    });
  });

  describe('Invitation Queries by Inviter', () => {
    it('should retrieve invitations by inviter', () => {
      const inviterId = 'user1';

      createInvitation(inviterId, 'email1@example.com', 'project1', 'project', 'contributor');
      createInvitation(inviterId, 'email2@example.com', 'project1', 'project', 'viewer');
      createInvitation('user2', 'email3@example.com', 'project1', 'project', 'contributor');

      const invites = getInvitationsByInviter(inviterId);
      expect(invites.length).toBeGreaterThanOrEqual(2);
      expect(invites.every((inv) => inv.inviterId === inviterId)).toBe(true);
    });
  });

  describe('Invitation Queries by Resource', () => {
    it('should retrieve invitations by resource', () => {
      createInvitation('user1', 'email1@example.com', 'project1', 'project', 'contributor');
      createInvitation('user2', 'email2@example.com', 'project1', 'project', 'viewer');
      createInvitation('user1', 'email3@example.com', 'project2', 'project', 'contributor');

      const invites = getInvitationsByResource('project', 'project1');
      expect(invites.length).toBeGreaterThanOrEqual(2);
      expect(invites.every((inv) => inv.targetResourceId === 'project1')).toBe(true);
    });
  });

  describe('Invitation Rejection', () => {
    it('should reject a pending invitation', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      const rejected = rejectInvitation(invite.id);
      expect(rejected).toBe(true);

      const updated = invitationManager.getInvitation(invite.id);
      expect(updated?.status).toBe('rejected');
    });

    it('should not allow rejecting non-pending invitations', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      acceptInvitation(invite.id, 'newuser@example.com');

      expect(() => {
        rejectInvitation(invite.id);
      }).toThrow('Cannot reject');
    });
  });

  describe('Exported Helper Functions', () => {
    it('should export validation function', () => {
      const invite = createInvitation(
        'user1',
        'newuser@example.com',
        'project1',
        'project',
        'contributor'
      );

      const result = validateInvitationForAcceptance(invite.id);
      expect(result.valid).toBe(true);
    });

    it('should export role permissions function', () => {
      const viewerPerms = getRolePermissions('viewer');
      expect(viewerPerms.canRead).toBe(true);
      expect(viewerPerms.canWrite).toBe(false);

      const adminPerms = getRolePermissions('admin');
      expect(adminPerms.canEscalateRoles).toBe(true);
    });
  });

  describe('Invitation Statistics', () => {
    it('should calculate percentage accepted', () => {
      const inviterId = 'user1';

      const invite1 = createInvitation(inviterId, 'email1@example.com', 'project1', 'project', 'contributor');
      const invite2 = createInvitation(inviterId, 'email2@example.com', 'project1', 'project', 'viewer');
      const invite3 = createInvitation(inviterId, 'email3@example.com', 'project1', 'project', 'contributor');

      acceptInvitation(invite2.id, 'email2@example.com');

      const stats = getInvitationStats(inviterId);
      expect(stats.percentAccepted).toBeGreaterThanOrEqual(33); // At least 1 out of 3
    });
  });
});
