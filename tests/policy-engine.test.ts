import {
  evaluatePolicy,
  updateBusinessPolicy,
  getBusinessPolicy,
  PolicyContext,
  policyEngine,
  type PolicyRule,
} from '@/lib/policy-engine';

describe('Policy Engine', () => {
  beforeEach(() => {
    // Reset to default policy
    updateBusinessPolicy({
      maxAgentsPerUser: 10,
      maxTransferAmount: '1000000',
      maxInvitesPerDay: 50,
      inviteExpiryHours: 168,
      impersonationMaxDurationMinutes: 30,
      retryAttemptsMax: 3,
      roleEscalationRequiresConfirmation: true,
    });
  });

  describe('Impersonation Policy', () => {
    it('should deny impersonation for non-admin users', () => {
      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'user2',
          type: 'user',
          owner: 'system',
        },
        action: 'impersonate_user',
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('admin');
    });

    it('should allow impersonation for admin users', () => {
      const context: PolicyContext = {
        actor: {
          id: 'admin1',
          role: 'admin',
          permissions: ['impersonate'],
        },
        resource: {
          id: 'user2',
          type: 'user',
          owner: 'system',
        },
        action: 'impersonate_user',
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('Invitation Policy', () => {
    it('should track invitation rate limits', () => {
      const actorId = 'user1';
      const action = 'invite_collaborator';

      // Record rate limited actions
      policyEngine.recordRateLimitedAction(actorId, action);
      policyEngine.recordRateLimitedAction(actorId, action);

      const status = policyEngine.getRateLimitStatus(actorId, action);
      expect(status.remaining).toBe(48); // 50 - 2
      expect(status.resetTime).toBeGreaterThan(Date.now());
    });

    it('should deny invitations when rate limit exceeded', () => {
      const actorId = 'user1';

      // Set a low limit for testing
      updateBusinessPolicy({ maxInvitesPerDay: 2 });

      // Record 2 invitations
      policyEngine.recordRateLimitedAction(actorId, 'invite_collaborator');
      policyEngine.recordRateLimitedAction(actorId, 'invite_collaborator');

      const context: PolicyContext = {
        actor: {
          id: actorId,
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'user2',
          type: 'user',
          owner: 'system',
        },
        action: 'invite_collaborator',
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('Role Escalation Policy', () => {
    it('should require confirmation for role escalation', () => {
      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'user1',
          type: 'admin',
          owner: 'system',
        },
        action: 'escalate_role',
        metadata: { confirmed: false },
      };

      const decision = evaluatePolicy(context);
      expect(decision.requiresConfirmation).toBe(true);
    });

    it('should allow role escalation with confirmation', () => {
      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'user1',
          type: 'admin',
          owner: 'system',
        },
        action: 'escalate_role',
        metadata: { confirmed: true },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
    });
  });

  describe('Agent Creation Policy', () => {
    it('should deny agent creation for guests', () => {
      const context: PolicyContext = {
        actor: {
          id: 'guest1',
          role: 'guest',
          permissions: [],
        },
        resource: {
          id: 'agent1',
          type: 'agent',
          owner: 'guest1',
        },
        action: 'create_agent',
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);
    });

    it('should enforce max agents per user', () => {
      updateBusinessPolicy({ maxAgentsPerUser: 2 });

      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'agent3',
          type: 'agent',
          owner: 'user1',
        },
        action: 'create_agent',
        metadata: { agentCount: 2 },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);
    });

    it('should allow agent creation within limits', () => {
      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'agent1',
          type: 'agent',
          owner: 'user1',
        },
        action: 'create_agent',
        metadata: { agentCount: 2 },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('Transfer Policy', () => {
    it('should enforce transfer amount limits', () => {
      updateBusinessPolicy({ maxTransferAmount: '1000' });

      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'wallet1',
          type: 'wallet',
          owner: 'user1',
        },
        action: 'transfer_funds',
        metadata: { amount: '2000' },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);
    });

    it('should allow transfer within limits', () => {
      updateBusinessPolicy({ maxTransferAmount: '1000' });

      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'wallet1',
          type: 'wallet',
          owner: 'user1',
        },
        action: 'transfer_funds',
        metadata: { amount: '500' },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('Boundary Conditions', () => {
    it('should handle zero amounts correctly', () => {
      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'wallet1',
          type: 'wallet',
          owner: 'user1',
        },
        action: 'transfer_funds',
        metadata: { amount: '0' },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);
    });

    it('should handle exactly max amount', () => {
      updateBusinessPolicy({ maxTransferAmount: '1000' });

      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'wallet1',
          type: 'wallet',
          owner: 'user1',
        },
        action: 'transfer_funds',
        metadata: { amount: '1000' },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);
    });

    it('should handle large numbers correctly', () => {
      const largeAmount = '999999999999999999999';
      updateBusinessPolicy({ maxTransferAmount: '1000000000000' });

      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'wallet1',
          type: 'wallet',
          owner: 'user1',
        },
        action: 'transfer_funds',
        metadata: { amount: largeAmount },
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('Policy Configuration', () => {
    it('should update business policy', () => {
      updateBusinessPolicy({ maxAgentsPerUser: 20 });
      const policy = getBusinessPolicy();
      expect(policy.maxAgentsPerUser).toBe(20);
    });

    it('should return readonly policy', () => {
      const policy = getBusinessPolicy();
      expect(Object.isFrozen(policy)).toBe(true);
    });

    it('should not affect original policy on partial updates', () => {
      const original = getBusinessPolicy();
      updateBusinessPolicy({ maxAgentsPerUser: 5 });
      const updated = getBusinessPolicy();

      expect(original.maxTransferAmount).toBe(updated.maxTransferAmount);
      expect(updated.maxAgentsPerUser).toBe(5);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid context', () => {
      const invalidContext = {
        actor: { id: 'user1', role: 'invalid' as any },
        resource: { id: 'res1', type: 'type', owner: 'owner' },
        action: 'create_agent',
      };

      const decision = evaluatePolicy(invalidContext as any);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Invalid');
    });

    it('should handle invalid policy updates', () => {
      expect(() => {
        updateBusinessPolicy({ maxAgentsPerUser: 0 });
      }).toThrow();
    });
  });

  describe('Rule Management', () => {
    it('should add custom rules', () => {
      const customRule: PolicyRule = {
        id: 'custom_rule_1',
        name: 'Custom Rule',
        description: 'A custom policy rule',
        action: 'create_agent',
        effect: 'deny',
        priority: 120,
        enabled: true,
        condition: () => true,
      };

      policyEngine.addRule(customRule);
      const rule = policyEngine.getRule('custom_rule_1');
      expect(rule).toBeDefined();
      expect(rule?.name).toBe('Custom Rule');
    });

    it('should disable and enable rules', () => {
      const customRule: PolicyRule = {
        id: 'test_rule',
        name: 'Test Rule',
        description: 'A test rule',
        action: 'create_agent',
        effect: 'deny',
        priority: 50,
        enabled: true,
        condition: () => true,
      };

      policyEngine.addRule(customRule);
      expect(policyEngine.disableRule('test_rule')).toBe(true);

      // Disabled rule shouldn't affect policy
      const context: PolicyContext = {
        actor: {
          id: 'user1',
          role: 'user',
          permissions: [],
        },
        resource: {
          id: 'agent1',
          type: 'agent',
          owner: 'user1',
        },
        action: 'create_agent',
      };

      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(true);

      // Re-enable the rule
      expect(policyEngine.enableRule('test_rule')).toBe(true);
    });

    it('should remove rules', () => {
      const customRule: PolicyRule = {
        id: 'removable_rule',
        name: 'Removable Rule',
        description: 'A rule to remove',
        action: 'create_agent',
        effect: 'deny',
        priority: 50,
        enabled: true,
        condition: () => false,
      };

      policyEngine.addRule(customRule);
      expect(policyEngine.removeRule('removable_rule')).toBe(true);
      expect(policyEngine.getRule('removable_rule')).toBeUndefined();
    });

    it('should list all rules', () => {
      const rules = policyEngine.getRules();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    });
  });

  describe('Rate Limiting', () => {
    it('should track rate limit status', () => {
      const actorId = 'user1';
      const action = 'invite_collaborator';

      const status = policyEngine.getRateLimitStatus(actorId, action);
      expect(status.remaining).toBe(50); // Default max
      expect(status.isLimited).toBe(false);
      expect(status.resetTime).toBeGreaterThan(Date.now());
    });

    it('should update remaining count after actions', () => {
      const actorId = 'user2';
      const action = 'invite_collaborator';

      policyEngine.recordRateLimitedAction(actorId, action);
      policyEngine.recordRateLimitedAction(actorId, action);

      const status = policyEngine.getRateLimitStatus(actorId, action);
      expect(status.remaining).toBe(48);
      expect(status.isLimited).toBe(false);
    });

    it('should mark as limited when threshold exceeded', () => {
      updateBusinessPolicy({ maxInvitesPerDay: 2 });

      const actorId = 'user3';
      const action = 'invite_collaborator';

      policyEngine.recordRateLimitedAction(actorId, action);
      policyEngine.recordRateLimitedAction(actorId, action);

      const status = policyEngine.getRateLimitStatus(actorId, action);
      expect(status.isLimited).toBe(true);
      expect(status.remaining).toBeLessThanOrEqual(0);
    });
  });

  describe('Violation Logging', () => {
    it('should log policy violations', () => {
      const context: PolicyContext = {
        actor: {
          id: 'guest1',
          role: 'guest',
          permissions: [],
        },
        resource: {
          id: 'agent1',
          type: 'agent',
          owner: 'guest1',
        },
        action: 'create_agent',
      };

      policyEngine.clearViolationLog();
      const decision = evaluatePolicy(context);
      expect(decision.allowed).toBe(false);

      const violations = policyEngine.getViolationLog();
      expect(violations.length).toBeGreaterThan(0);
    });

    it('should clear violation log', () => {
      policyEngine.clearViolationLog();
      const violations = policyEngine.getViolationLog();
      expect(violations.length).toBe(0);
    });
  });
});
