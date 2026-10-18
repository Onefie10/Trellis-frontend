import {
  LifecycleNotification,
  LifecycleEventType,
  NotificationSeverity,
  NotificationFilterOptions,
} from './lifecycle-types';
import {
  NotificationAuditRecord,
  RoutingOutcome,
  evaluateRoutingDecision,
  isMandatoryAlert,
} from './routing-model';
import {
  DurableNotificationPreferences,
  loadDurablePreferences,
} from './durable-preferences';

export interface DispatchOptions {
  preferences?: DurableNotificationPreferences;
  now?: Date;
  /** Force bypass preference evaluation if explicitly desired. */
  bypassPreferences?: boolean;
}

export interface DispatchResult {
  notification: LifecycleNotification | null;
  isDuplicate: boolean;
  routingDecision?: RoutingOutcome;
  auditRecord?: NotificationAuditRecord;
}

export interface AuditLogFilterOptions {
  walletAddress?: string;
  mandatoryOnly?: boolean;
  routingDecision?: RoutingOutcome;
  limit?: number;
}

export type LifecycleDispatchEvent = Omit<
  LifecycleNotification,
  'id' | 'isRead' | 'dismissed' | 'createdAt' | 'dedupKey' | 'audience'
> & {
  dedupKey?: string;
  isMandatory?: boolean;
  audience?: 'user' | 'admin' | 'all';
};

class LifecycleNotificationManager {
  private notifications: Map<string, LifecycleNotification> = new Map();
  private dedupKeys: Set<string> = new Set();
  private auditLog: NotificationAuditRecord[] = [];
  private readonly maxAuditLogSize = 1000;

  /**
   * Dispatch a lifecycle notification.
   *
   * Enforces:
   * 1. Deduplication using dedupKey so retries never create duplicate alerts.
   * 2. Mandatory vs Optional routing:
   *    - Mandatory alerts (critical severity, security/recovery events) are ALWAYS delivered.
   *    - Optional alerts respect durable user preferences, quiet hours, and channel toggles.
   * 3. Complete auditable delivery log recording all routing decisions.
   */
  dispatch(
    event: LifecycleDispatchEvent,
    options: DispatchOptions = {}
  ): DispatchResult {
    const dedupKey =
      event.dedupKey ||
      `${event.type}_${event.recipientWallet || 'all'}_${event.title}_${JSON.stringify(event.metadata || {})}`;

    if (this.dedupKeys.has(dedupKey)) {
      return { notification: null, isDuplicate: true };
    }

    const id = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const mandatory = isMandatoryAlert(event);

    const baseNotification: LifecycleNotification = {
      ...event,
      id,
      dedupKey,
      audience: event.audience || 'user',
      isRead: false,
      dismissed: false,
      createdAt: new Date().toISOString(),
      isMandatory: mandatory,
    };

    if (options.bypassPreferences) {
      this.notifications.set(id, baseNotification);
      this.dedupKeys.add(dedupKey);
      return {
        notification: baseNotification,
        isDuplicate: false,
        routingDecision: mandatory ? 'mandatory_delivered' : 'delivered',
      };
    }

    const preferences = options.preferences ?? loadDurablePreferences();
    const decision = evaluateRoutingDecision(baseNotification, {
      preferences,
      now: options.now,
    });

    // Record audit trail
    this.recordAudit(decision.auditRecord);

    const finalNotification: LifecycleNotification = {
      ...baseNotification,
      isMandatory: decision.isMandatory,
      routingDecision: decision.routingDecision,
      suppressionReasons: decision.suppressionReasons,
    };

    if (decision.shouldDeliver) {
      this.notifications.set(id, finalNotification);
      this.dedupKeys.add(dedupKey);
      return {
        notification: finalNotification,
        isDuplicate: false,
        routingDecision: decision.routingDecision,
        auditRecord: decision.auditRecord,
      };
    }

    // Suppressed optional notification: record dedupKey so duplicate triggers are caught
    this.dedupKeys.add(dedupKey);
    return {
      notification: null,
      isDuplicate: false,
      routingDecision: decision.routingDecision,
      auditRecord: decision.auditRecord,
    };
  }

  /**
   * Retrieve notifications targeted to a specific wallet (or broadcast audience).
   * Ensures private notifications are never leaked to the wrong user.
   */
  getForUser(
    walletAddress?: string,
    options: NotificationFilterOptions = {}
  ): LifecycleNotification[] {
    const all = Array.from(this.notifications.values());

    let filtered = all.filter((n) => {
      if (n.dismissed) return false;

      // Privacy / Targeting filtering
      if (n.audience === 'all') return true;
      if (n.recipientWallet) {
        if (!walletAddress) return false;
        return n.recipientWallet.toLowerCase() === walletAddress.toLowerCase();
      }
      return true;
    });

    if (options.unreadOnly) {
      filtered = filtered.filter((n) => !n.isRead);
    }

    if (options.severity) {
      filtered = filtered.filter((n) => n.severity === options.severity);
    }

    if (options.type) {
      filtered = filtered.filter((n) => n.type === options.type);
    }

    if (options.mandatoryOnly) {
      filtered = filtered.filter((n) => n.isMandatory === true);
    }

    // Sort newest first
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (options.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  markAsRead(id: string): boolean {
    const notif = this.notifications.get(id);
    if (!notif) return false;
    notif.isRead = true;
    notif.readAt = new Date().toISOString();
    return true;
  }

  markAllAsRead(walletAddress?: string): number {
    const notifs = this.getForUser(walletAddress, { unreadOnly: true });
    notifs.forEach((n) => {
      n.isRead = true;
      n.readAt = new Date().toISOString();
    });
    return notifs.length;
  }

  dismiss(id: string): boolean {
    const notif = this.notifications.get(id);
    if (!notif) return false;
    notif.dismissed = true;
    return true;
  }

  /**
   * Access the full audit log of all notification routing decisions.
   */
  getAuditLog(options: AuditLogFilterOptions = {}): NotificationAuditRecord[] {
    let records = [...this.auditLog];

    if (options.walletAddress) {
      const lower = options.walletAddress.toLowerCase();
      records = records.filter(
        (r) => !r.recipientWallet || r.recipientWallet.toLowerCase() === lower
      );
    }

    if (options.mandatoryOnly) {
      records = records.filter((r) => r.isMandatory);
    }

    if (options.routingDecision) {
      records = records.filter((r) => r.routingDecision === options.routingDecision);
    }

    // Sort newest first
    records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (options.limit && options.limit > 0) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /**
   * Export the audit log as a JSON string for diagnostics or compliance export.
   */
  exportAuditLogJson(): string {
    return JSON.stringify(this.auditLog, null, 2);
  }

  /**
   * Record a new audit entry into the buffer with bounded memory management.
   */
  private recordAudit(record: NotificationAuditRecord): void {
    this.auditLog.push(record);
    if (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog.splice(0, this.auditLog.length - this.maxAuditLogSize);
    }
  }

  clearAuditLog(): void {
    this.auditLog = [];
  }

  clear(): void {
    this.notifications.clear();
    this.dedupKeys.clear();
    this.auditLog = [];
  }
}

export const lifecycleNotifications = new LifecycleNotificationManager();
