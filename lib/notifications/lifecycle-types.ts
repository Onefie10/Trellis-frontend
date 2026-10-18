export type LifecycleEventType =
  | 'agent_minted'
  | 'agent_upgraded'
  | 'agent_deprecated'
  | 'simulation_completed'
  | 'simulation_failed'
  | 'transaction_failed'
  | 'recovery_action_required'
  | 'approval_required'
  | 'governance_proposal_active'
  | 'rate_limit_warning'
  | 'security_audit_alert';

export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'success';

export interface RecoveryAction {
  label: string;
  actionId: string;
  href?: string;
  isDestructive?: boolean;
}

export interface LifecycleNotification {
  id: string;
  dedupKey: string;
  type: LifecycleEventType;
  title: string;
  message: string;
  severity: NotificationSeverity;
  recipientWallet?: string; // If set, only visible to this wallet
  audience: 'user' | 'admin' | 'all';
  deepLink?: string;
  recoveryAction?: RecoveryAction;
  isRead: boolean;
  readAt?: string;
  dismissed: boolean;
  createdAt: string;
  metadata?: Record<string, any>;
  /** Whether this alert is mandatory (bypasses optional mutes and quiet hours). */
  isMandatory?: boolean;
  /** Routing outcome determined by the mandatory routing engine. */
  routingDecision?: 'delivered' | 'suppressed' | 'mandatory_delivered';
  /** Suppression reasons if optional notification was silenced. */
  suppressionReasons?: string[];
}

export interface NotificationFilterOptions {
  unreadOnly?: boolean;
  severity?: NotificationSeverity;
  type?: LifecycleEventType;
  limit?: number;
  /** If set to true, only returns mandatory alerts. */
  mandatoryOnly?: boolean;
}
