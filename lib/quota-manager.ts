export type QuotaResource = 'storage' | 'compute' | 'external_api' | 'indexing' | string;

export interface QuotaConfig {
  defaultLimit: number;
  // A limit reset window in milliseconds (optional, defaults to no reset/infinite window in this basic impl, 
  // but we can support daily/hourly).
  resetWindowMs?: number; 
}

export interface QuotaUsage {
  used: number;
  limit: number;
  resetAt?: number;
}

export class QuotaExceededError extends Error {
  constructor(public actor: string, public resource: string, public limit: number) {
    super(`Quota exceeded for actor ${actor} on resource ${resource}. Limit is ${limit}.`);
    this.name = 'QuotaExceededError';
  }
}

export class QuotaManager {
  // resource => config
  private configs = new Map<string, QuotaConfig>();
  
  // resource => actor => usage
  private usageData = new Map<string, Map<string, { used: number; resetAt?: number }>>();
  
  // resource => actor => override limit
  private overrides = new Map<string, Map<string, number>>();

  /** Define default limits for a resource */
  public defineResource(resource: QuotaResource, config: QuotaConfig) {
    this.configs.set(resource, config);
  }

  /** Gets the applicable limit for an actor (accounting for overrides) */
  public getLimit(actor: string, resource: QuotaResource): number {
    const override = this.overrides.get(resource)?.get(actor);
    if (override !== undefined) {
      return override;
    }
    const config = this.configs.get(resource);
    if (!config) {
      // If resource not defined, assume no limit (or strict limit? let's assume Infinity if not configured)
      return Infinity;
    }
    return config.defaultLimit;
  }

  /** Explicitly override a limit for a specific actor */
  public setOverride(actor: string, resource: QuotaResource, limit: number) {
    if (!this.overrides.has(resource)) {
      this.overrides.set(resource, new Map());
    }
    this.overrides.get(resource)!.set(actor, limit);
  }

  /** Clear an override */
  public clearOverride(actor: string, resource: QuotaResource) {
    this.overrides.get(resource)?.delete(actor);
  }

  private ensureReset(actor: string, resource: QuotaResource, config: QuotaConfig | undefined, now: number) {
    let resourceUsage = this.usageData.get(resource);
    if (!resourceUsage) {
      resourceUsage = new Map();
      this.usageData.set(resource, resourceUsage);
    }
    
    let actorUsage = resourceUsage.get(actor);
    if (!actorUsage) {
      actorUsage = { used: 0, resetAt: config?.resetWindowMs ? now + config.resetWindowMs : undefined };
      resourceUsage.set(actor, actorUsage);
    } else if (actorUsage.resetAt && now >= actorUsage.resetAt) {
      // Window expired, reset usage
      actorUsage.used = 0;
      actorUsage.resetAt = config?.resetWindowMs ? now + config.resetWindowMs : undefined;
    }
    return actorUsage;
  }

  /**
   * Check if operation is allowed without consuming it.
   */
  public check(actor: string, resource: QuotaResource, amount: number = 1): boolean {
    const config = this.configs.get(resource);
    const limit = this.getLimit(actor, resource);
    const now = Date.now();

    const actorUsage = this.ensureReset(actor, resource, config, now);
    return actorUsage.used + amount <= limit;
  }

  /**
   * Consume quota. Throws QuotaExceededError if limit is breached.
   */
  public consume(actor: string, resource: QuotaResource, amount: number = 1): void {
    if (!this.check(actor, resource, amount)) {
      throw new QuotaExceededError(actor, resource, this.getLimit(actor, resource));
    }
    
    const config = this.configs.get(resource);
    const now = Date.now();
    const actorUsage = this.ensureReset(actor, resource, config, now);
    
    actorUsage.used += amount;
  }

  /** Inspect current usage (for maintainer diagnostics) */
  public inspect(actor: string, resource: QuotaResource): QuotaUsage {
    const config = this.configs.get(resource);
    const now = Date.now();
    const actorUsage = this.ensureReset(actor, resource, config, now);
    
    return {
      used: actorUsage.used,
      limit: this.getLimit(actor, resource),
      resetAt: actorUsage.resetAt
    };
  }

  /** Reset a specific actor's usage immediately */
  public reset(actor: string, resource: QuotaResource) {
    const resourceUsage = this.usageData.get(resource);
    if (resourceUsage) {
      resourceUsage.delete(actor);
    }
  }

  /** Clear all usage data */
  public clearAll() {
    this.usageData.clear();
    this.overrides.clear();
  }
}

export const quotaManager = new QuotaManager();

// Setup some sensible default resources for Trellis
quotaManager.defineResource('compute', { defaultLimit: 1000, resetWindowMs: 3600 * 1000 }); // 1000 per hour
quotaManager.defineResource('storage', { defaultLimit: 50 * 1024 * 1024 }); // 50MB no reset
quotaManager.defineResource('external_api', { defaultLimit: 500, resetWindowMs: 3600 * 1000 }); // 500 calls per hour
quotaManager.defineResource('indexing', { defaultLimit: 10000, resetWindowMs: 24 * 3600 * 1000 }); // 10k items per day
