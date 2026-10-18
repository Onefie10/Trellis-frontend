import {
  LifecycleEventType,
  NotificationSeverity,
  LifecycleNotification,
} from './lifecycle-types';
import {
  categoryForEventType,
  isWithinQuietHours,
} from './alert-preferences';
import {
  DurableNotificationPreferences,
  DEFAULT_DURABLE_PREFERENCES,
} from './durable-preferences';

/**
 * Event types that represent lifecycle-critical or security-critical events.
 * Alerts with these event types are ALWAYS mandatory and can never be
 * suppressed by optional category mutes, quiet hours, or user toggles.
 */
export const MANDATORY_EVENT_TYPES: ReadonlySet<LifecycleEventType> = new Set<LifecycleEventType>([
  'recovery_action_required',
  'security_audit_alert',
  'approval_required',
]);

export type RoutingOutcome = 'delivered' | 'suppressed' | 'mandatory_delivered';

export type ExtendedSuppressionReason =
  | 'audio_disabled'
  | 'category_muted'
  | 'quiet_hours'
  | 'notifications_disabled'
  | 'channel_disabled';

export interface NotificationAuditRecord {
  id: string;
  notificationId: string;
  dedupKey: string;
  eventType: LifecycleEventType;
  severity: NotificationSeverity;
  isMandatory: boolean;
  timestamp: string;
  routingDecision: RoutingOutcome;
  suppressionReasons: ExtendedSuppressionReason[];
  channelsDelivered: Array<'in_app' | 'audio' | 'webhook'>;
  recipientWallet?: string;
  duringQuietHours: boolean;
}

export interface RoutingDecision {
  shouldDeliver: boolean;
  isMandatory: boolean;
  routingDecision: RoutingOutcome;
  suppressionReasons: ExtendedSuppressionReason[];
  channels: {
    inApp: boolean;
    audio: boolean;
    webhook: boolean;
  };
  duringQuietHours: boolean;
  auditRecord: NotificationAuditRecord;
}

/**
 * Classify whether an incoming alert is mandatory.
 *
 * Rules:
 * 1. An explicit `isMandatory: true` flag.
 * 2. Critical severity (`severity === 'critical'`).
 * 3. Dedicated security/recovery event types (`recovery_action_required`, `security_audit_alert`, `approval_required`).
 */
export function isMandatoryAlert(
  notification: Partial<LifecycleNotification> & {
    type: LifecycleEventType;
    severity?: NotificationSeverity;
  }
): boolean {
  if (notification.isMandatory === true) {
    return true;
  }

  if (notification.severity === 'critical') {
    return true;
  }

  return MANDATORY_EVENT_TYPES.has(notification.type);
}

export interface EvaluateRoutingOptions {
  now?: Date;
  preferences?: DurableNotificationPreferences;
}

/**
 * Evaluates the routing decision for a notification against user durable preferences.
 *
 * GUARANTEES:
 * 1. Optional notifications respect user mutes, quiet hours, and channel toggles.
 * 2. Mandatory alerts ALWAYS bypass optional category mutes and quiet hours for in-app delivery.
 * 3. Every single evaluation produces an auditable NotificationAuditRecord.
 */
export function evaluateRoutingDecision(
  notification: LifecycleNotification,
  options: EvaluateRoutingOptions = {}
): RoutingDecision {
  const prefs = options.preferences ?? DEFAULT_DURABLE_PREFERENCES;
  const now = options.now ?? new Date();
  const mandatory = isMandatoryAlert(notification);
  const duringQuietHours = isWithinQuietHours(now, prefs.quietHours);
  const category = categoryForEventType(notification.type);

  const suppressionReasons: ExtendedSuppressionReason[] = [];
  const channelsDelivered: Array<'in_app' | 'audio' | 'webhook'> = [];

  // Mandatory routing pathway
  if (mandatory) {
    // Audio chime decision for mandatory alert:
    // Plays unless audio is globally disabled or quietHours explicitly has muteCritical
    let audioDelivered = false;
    if (prefs.audioEnabled) {
      if (!duringQuietHours || !prefs.quietHours.muteCritical) {
        audioDelivered = true;
        channelsDelivered.push('audio');
      } else {
        suppressionReasons.push('quiet_hours');
      }
    } else {
      suppressionReasons.push('audio_disabled');
    }

    // In-app delivery is ALWAYS guaranteed for mandatory alerts
    channelsDelivered.push('in_app');

    // Webhook delivery for mandatory alert:
    const webhookDelivered = prefs.channels.webhook;
    if (webhookDelivered) {
      channelsDelivered.push('webhook');
    }

    const auditRecord: NotificationAuditRecord = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      notificationId: notification.id,
      dedupKey: notification.dedupKey,
      eventType: notification.type,
      severity: notification.severity,
      isMandatory: true,
      timestamp: new Date().toISOString(),
      routingDecision: 'mandatory_delivered',
      suppressionReasons,
      channelsDelivered,
      recipientWallet: notification.recipientWallet,
      duringQuietHours,
    };

    return {
      shouldDeliver: true,
      isMandatory: true,
      routingDecision: 'mandatory_delivered',
      suppressionReasons,
      channels: {
        inApp: true,
        audio: audioDelivered,
        webhook: webhookDelivered,
      },
      duringQuietHours,
      auditRecord,
    };
  }

  // Optional notification routing pathway
  if (!prefs.enabled) {
    suppressionReasons.push('notifications_disabled');
  }

  if (prefs.mutedCategories[category]) {
    suppressionReasons.push('category_muted');
  }

  if (duringQuietHours) {
    suppressionReasons.push('quiet_hours');
  }

  const shouldDeliver = suppressionReasons.length === 0;

  if (shouldDeliver) {
    if (prefs.channels.inApp) {
      channelsDelivered.push('in_app');
    }
    if (prefs.audioEnabled && prefs.channels.audio) {
      channelsDelivered.push('audio');
    }
    if (prefs.channels.webhook) {
      channelsDelivered.push('webhook');
    }
  }

  const routingDecision: RoutingOutcome = shouldDeliver ? 'delivered' : 'suppressed';

  const auditRecord: NotificationAuditRecord = {
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    notificationId: notification.id,
    dedupKey: notification.dedupKey,
    eventType: notification.type,
    severity: notification.severity,
    isMandatory: false,
    timestamp: new Date().toISOString(),
    routingDecision,
    suppressionReasons,
    channelsDelivered,
    recipientWallet: notification.recipientWallet,
    duringQuietHours,
  };

  return {
    shouldDeliver,
    isMandatory: false,
    routingDecision,
    suppressionReasons,
    channels: {
      inApp: shouldDeliver && prefs.channels.inApp,
      audio: shouldDeliver && prefs.audioEnabled && prefs.channels.audio,
      webhook: shouldDeliver && prefs.channels.webhook,
    },
    duringQuietHours,
    auditRecord,
  };
}
