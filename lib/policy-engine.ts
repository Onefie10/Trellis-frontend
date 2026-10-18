import { z } from 'zod';

/**
 * Policy Engine for configurable business rules
 * Centralizes hard-coded business logic into a tested, maintainable policy layer
 *
 * Features:
 * - Centralized business rule evaluation
 * - Typed policy contexts and decisions
 * - Priority-based rule evaluation (deny first, then allow)
 * - Rate limiting with time windows
 * - Pluggable rule system
 * - Comprehensive error handling
 */

export type PolicyAction =
  | 'create_agent'
  | 'transfer_funds'
  | 'invite_collaborator'
  | 'escalate_role'
  | 'retry_operation'
  | 'impersonate_user';

export type ActorRole = 'admin' | 'maintainer' | 'user' | 'guest';

export interface PolicyActor {
  id: string;
  role: ActorRole;
  permissions: string[];
}

export interface PolicyResource {
  id: string;
  type: string;
  owner: string;
}

export interface PolicyContext {
  actor: PolicyActor;
  resource: PolicyResource;
  action: PolicyAction;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  requiresConfirmation?: boolean;
  rateLimitRemaining?: number;
  metadata?: Record<string, unknown>;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  condition: (context: PolicyContext) => boolean;
  action: PolicyAction;
  effect: 'allow' | 'deny';
  priority: number;
  enabled: boolean;
}

export interface BusinessPolicy {
  maxAgentsPerUser: number;
  maxTransferAmount: string;
  maxInvitesPerDay: number;
  inviteExpiryHours: number;
  impersonationMaxDurationMinutes: number;
  retryAttemptsMax: number;
  roleEscalationRequiresConfirmation: boolean;
}

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  reason: string;
  timestamp: number;
}

export const defaultBusinessPolicy: BusinessPolicy = {
  maxAgentsPerUser: 10,
  maxTransferAmount: '1000000', // XLM stroops
  maxInvitesPerDay: 50,
  inviteExpiryHours: 24 * 7, // 7 days
  impersonationMaxDurationMinutes: 30,
  retryAttemptsMax: 3,
  roleEscalationRequiresConfirmation: true,
};

export const PolicyActorSchema = z.object({
  id: z.string().min(1, 'Actor ID required'),
  role: z.enum(['admin', 'maintainer', 'user', 'guest']),
  permissions: z.array(z.string()).default([]),
});

export const PolicyResourceSchema = z.object({
  id: z.string().min(1, 'Resource ID required'),
  type: z.string().min(1, 'Resource type required'),
  owner: z.string().min(1, 'Resource owner required'),
});

export const PolicyContextSchema = z.object({
  actor: PolicyActorSchema,
  resource: PolicyResourceSchema,
  action: z.enum([
    'create_agent',
    'transfer_funds',
    'invite_collaborator',
    'escalate_role',
    'retry_operation',
    'impersonate_user',
  ]),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.number().optional(),
});

export const BusinessPolicySchema = z.object({
  maxAgentsPerUser: z.number().positive(),
  maxTransferAmount: z.string(),
  maxInvitesPerDay: z.number().positive(),
  inviteExpiryHours: z.number().positive(),
  impersonationMaxDurationMinutes: z.number().positive(),
  retryAttemptsMax: z.number().positive(),
  roleEscalationRequiresConfirmation: z.boolean(),
});

/**
 * Core policy engine implementation
 * Handles rule evaluation, rate limiting, and policy decisions
 */
class PolicyEngine {
  private policy: BusinessPolicy;
  private rules: Map<string, PolicyRule> = new Map();
  private rateLimits: Map<string, { count: number; resetTime: number }> = new Map();
  private violationLog: PolicyViolation[] = [];
  private maxViolationLogSize: number = 10000;

  constructor(policy: BusinessPolicy = defaultBusinessPolicy) {
    this.policy = policy;
    this.validatePolicy(policy);
    this.initializeDefaultRules();
  }

  private validatePolicy(policy: BusinessPolicy): void {
    try {
      BusinessPolicySchema.parse(policy);
    } catch (error) {
      throw new Error(`Invalid business policy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private initializeDefaultRules(): void {
    // Rule: Only admins can impersonate
    this.addRule({
      id: 'impersonation_admin_only',
      name: 'Impersonation requires admin role',
      description: 'Only administrators can impersonate users',
      action: 'impersonate_user',
      effect: 'deny',
      priority: 100,
      enabled: true,
      condition: (ctx) => ctx.actor.role !== 'admin',
    });

    // Rule: Role escalation requires confirmation
    this.addRule({
      id: 'role_escalation_confirmation',
      name: 'Role escalation requires confirmation',
      description: 'Escalating roles to higher privileges requires explicit confirmation',
      action: 'escalate_role',
      effect: 'deny',
      priority: 90,
      enabled: true,
      condition: (ctx) => {
        const isEscalation = ['admin', 'maintainer'].includes(ctx.resource.type);
        return isEscalation && !ctx.metadata?.confirmed;
      },
    });

    // Rule: Rate limit invitations
    this.addRule({
      id: 'invite_rate_limit',
      name: 'Invitation rate limiting',
      description: `Maximum ${this.policy.maxInvitesPerDay} invitations per day`,
      action: 'invite_collaborator',
      effect: 'deny',
      priority: 80,
      enabled: true,
      condition: (ctx) => {
        const key = `invites:${ctx.actor.id}`;
        const limit = this.rateLimits.get(key);
        return limit && limit.count >= this.policy.maxInvitesPerDay;
      },
    });

    // Rule: Guests cannot create agents
    this.addRule({
      id: 'guest_no_create',
      name: 'Guests cannot create agents',
      description: 'Guest accounts are not permitted to create new agents',
      action: 'create_agent',
      effect: 'deny',
      priority: 70,
      enabled: true,
      condition: (ctx) => ctx.actor.role === 'guest',
    });

    // Rule: Max agents per user
    this.addRule({
      id: 'max_agents_per_user',
      name: 'Maximum agents per user',
      description: `Each user can create at most ${this.policy.maxAgentsPerUser} agents`,
      action: 'create_agent',
      effect: 'deny',
      priority: 60,
      enabled: true,
      condition: (ctx) => {
        const agentCount = (ctx.metadata?.agentCount as number) || 0;
        return agentCount >= this.policy.maxAgentsPerUser;
      },
    });

    // Rule: Transfer amount limits
    this.addRule({
      id: 'transfer_amount_limit',
      name: 'Transfer amount limit',
      description: `Maximum transfer amount is ${this.policy.maxTransferAmount} stroops`,
      action: 'transfer_funds',
      effect: 'deny',
      priority: 50,
      enabled: true,
      condition: (ctx) => {
        try {
          const amount = (ctx.metadata?.amount as string) || '0';
          return BigInt(amount) > BigInt(this.policy.maxTransferAmount);
        } catch {
          return false;
        }
      },
    });
  }

  addRule(rule: PolicyRule): void {
    try {
      // Validate rule structure
      if (!rule.id || !rule.name || !rule.action) {
        throw new Error('Rule must have id, name, and action');
      }
      this.rules.set(rule.id, rule);
    } catch (error) {
      throw new Error(`Failed to add rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  disableRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    rule.enabled = false;
    return true;
  }

  enableRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    rule.enabled = true;
    return true;
  }

  getRule(ruleId: string): PolicyRule | undefined {
    return this.rules.get(ruleId);
  }

  updatePolicy(updates: Partial<BusinessPolicy>): void {
    try {
      const newPolicy = { ...this.policy, ...updates };
      this.validatePolicy(newPolicy);
      this.policy = newPolicy;
    } catch (error) {
      throw new Error(`Failed to update policy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getPolicy(): Readonly<BusinessPolicy> {
    return Object.freeze({ ...this.policy });
  }

  evaluate(context: PolicyContext): PolicyDecision {
    // Validate context
    try {
      PolicyContextSchema.parse(context);
    } catch (error) {
      return {
        allowed: false,
        reason: 'Invalid policy context',
        metadata: {
          validationError: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const timestamp = context.timestamp || Date.now();
    const contextWithTimestamp = { ...context, timestamp };

    // Sort rules by priority (higher first)
    const sortedRules = Array.from(this.rules.values())
      .filter((r) => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    // Evaluate deny rules first (fail-secure)
    const denyRules = sortedRules.filter((r) => r.effect === 'deny' && r.action === context.action);
    for (const rule of denyRules) {
      if (rule.condition(contextWithTimestamp)) {
        this.logViolation(rule.id, rule.name, rule.description);
        return {
          allowed: false,
          reason: rule.description,
          metadata: { violatedRuleId: rule.id },
        };
      }
    }

    // Evaluate allow rules
    const allowRules = sortedRules.filter((r) => r.effect === 'allow' && r.action === context.action);
    const allowed = allowRules.length === 0 || allowRules.some((r) => r.condition(contextWithTimestamp));

    if (!allowed) {
      return {
        allowed: false,
        reason: 'Action not permitted by policy',
      };
    }

    // Check if confirmation required
    const requiresConfirmation =
      context.action === 'escalate_role' && this.policy.roleEscalationRequiresConfirmation
      && !context.metadata?.confirmed;

    const rateLimitKey = `${context.action}:${context.actor.id}`;
    const rateLimitInfo = this.rateLimits.get(rateLimitKey);
    const rateLimitRemaining = this.getActionLimit(context.action) - (rateLimitInfo?.count || 0);

    return {
      allowed: true,
      reason: 'Policy allows this action',
      requiresConfirmation,
      rateLimitRemaining: Math.max(0, rateLimitRemaining),
    };
  }

  recordRateLimitedAction(actorId: string, action: PolicyAction): void {
    const key = `${action}:${actorId}`;
    const now = Date.now();
    const limit = this.rateLimits.get(key);

    if (!limit || now >= limit.resetTime) {
      // New window
      this.rateLimits.set(key, {
        count: 1,
        resetTime: now + 24 * 60 * 60 * 1000, // 24 hours
      });
    } else {
      // Update existing window
      limit.count += 1;
    }
  }

  getRateLimitStatus(
    actorId: string,
    action: PolicyAction
  ): { remaining: number; resetTime: number; isLimited: boolean } {
    const key = `${action}:${actorId}`;
    const limit = this.rateLimits.get(key);
    const now = Date.now();

    if (!limit || now >= limit.resetTime) {
      return {
        remaining: this.getActionLimit(action),
        resetTime: now + 24 * 60 * 60 * 1000,
        isLimited: false,
      };
    }

    const remaining = this.getActionLimit(action) - limit.count;
    return {
      remaining: Math.max(0, remaining),
      resetTime: limit.resetTime,
      isLimited: remaining <= 0,
    };
  }

  private getActionLimit(action: PolicyAction): number {
    const limits: Record<PolicyAction, number> = {
      create_agent: this.policy.maxAgentsPerUser,
      transfer_funds: 1, // Per transaction
      invite_collaborator: this.policy.maxInvitesPerDay,
      escalate_role: 10,
      retry_operation: this.policy.retryAttemptsMax,
      impersonate_user: 5,
    };
    return limits[action] || 0;
  }

  private logViolation(ruleId: string, ruleName: string, reason: string): void {
    const violation: PolicyViolation = {
      ruleId,
      ruleName,
      reason,
      timestamp: Date.now(),
    };

    this.violationLog.push(violation);

    // Keep log bounded
    if (this.violationLog.length > this.maxViolationLogSize) {
      this.violationLog = this.violationLog.slice(-this.maxViolationLogSize);
    }
  }

  getViolationLog(): PolicyViolation[] {
    return [...this.violationLog];
  }

  clearViolationLog(): void {
    this.violationLog = [];
  }

  getRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }
}

// Export singleton instance
export const policyEngine = new PolicyEngine();

export function evaluatePolicy(context: PolicyContext): PolicyDecision {
  return policyEngine.evaluate(context);
}

export function updateBusinessPolicy(updates: Partial<BusinessPolicy>): void {
  policyEngine.updatePolicy(updates);
}

export function getBusinessPolicy(): Readonly<BusinessPolicy> {
  return policyEngine.getPolicy();
}

export function recordRateLimitedAction(actorId: string, action: PolicyAction): void {
  policyEngine.recordRateLimitedAction(actorId, action);
}

export function getRateLimitStatus(
  actorId: string,
  action: PolicyAction
): { remaining: number; resetTime: number; isLimited: boolean } {
  return policyEngine.getRateLimitStatus(actorId, action);
}
