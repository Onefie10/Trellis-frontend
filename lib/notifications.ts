import { SorobanTransactionResult } from './types';
import {
  AlertPreferences,
  ALERT_PREFERENCES_KEY,
  evaluateAlert,
  isWithinQuietHours,
  loadAlertPreferences as readAlertPreferences,
  updateAlertPreferences as persistAlertPreferences,
} from './notifications/alert-preferences';
import { playChime } from './notifications/chime';
import { LifecycleEventType, NotificationSeverity } from './notifications/lifecycle-types';

export interface NotificationData {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  silent?: boolean;
  /** Drives the chime policy; defaults to `info`. */
  severity?: NotificationSeverity;
  /** When set, the matching alert category can mute this notification. */
  eventType?: LifecycleEventType;
  data?: {
    url?: string;
    transactionHash?: string;
    type?: 'trade' | 'transaction' | 'general';
    amount?: string;
    agentName?: string;
    category?: string;
    [key: string]: any;
  };
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
}

export interface NotificationPreferences {
  enabled: boolean;
  tradeNotifications: boolean;
  transactionNotifications: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  eventCategories: Record<string, boolean>;
  webhooks: WebhookEndpoint[];
  emailDigest: EmailDigestPreferences;
}

interface NotificationSyncMessage {
  type: 'mark_read' | 'dismiss' | 'mark_all_read' | 'notification_created';
  notificationId?: string;
  walletAddress?: string;
  timestamp: number;
  sourceTab: string;
}

const CHANNEL_NAME = 'trellis-notification-sync';
const STORAGE_KEY = 'Trellis-notification-preferences';
const TAB_ID = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

export class NotificationManager {
  private static instance: NotificationManager;
  private subscription: PushSubscription | null = null;
  private isSupported: boolean = false;
  private broadcastChannel: BroadcastChannel | null = null;
  private preferences: NotificationPreferences = {
    enabled: true,
    tradeNotifications: true,
    transactionNotifications: true,
    soundEnabled: true,
    vibrationEnabled: true,
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '08:00'
    },
    eventCategories: {
      proposal_passing: true,
      payout_execution: true,
      agent_error: true,
      governance: true,
      security_alert: true,
      trade_complete: true,
    },
    webhooks: [],
    emailDigest: {
      enabled: false,
      email: '',
      frequency: 'daily',
      triggers: {
        newProposal: true,
        highErrorRate: true,
        payoutExecuted: true,
        agentMinted: true,
      },
    },
  };
  private vapidPublicKey: string = '';
  private isInitialized: boolean = false;

  private constructor() {
    this.isSupported = typeof window !== 'undefined' && 'Notification' in window && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
    if (this.isSupported) {
      this.loadPreferences();
      this.initBroadcastChannel();
      this.initVAPID();
    }
  }

  private initBroadcastChannel(): void {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    try {
      this.broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
      this.broadcastChannel.onmessage = (event: MessageEvent<NotificationSyncMessage>) => {
        this.handleBroadcastMessage(event.data);
      };
    } catch (error) {
      console.warn('[NotificationManager] BroadcastChannel not available:', error);
    }
  }

  private initVAPID(): void {
    if (typeof window === 'undefined') return;
    this.vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
  }

  private handleBroadcastMessage(message: NotificationSyncMessage): void {
    if (message.sourceTab === TAB_ID) return;
    switch (message.type) {
      case 'mark_read':
        if (message.notificationId) {
          // Trigger local update by re-dispatching via lifecycle if needed
          console.log('[NotificationManager] Marked as read via broadcast:', message.notificationId);
        }
        break;
      case 'mark_all_read':
        console.log('[NotificationManager] Mark all read via broadcast');
        break;
      case 'notification_created':
        console.log('[NotificationManager] New notification via broadcast');
        break;
    }
  }

  private broadcastMessage(message: NotificationSyncMessage): void {
    if (this.broadcastChannel) {
      message.sourceTab = TAB_ID;
      this.broadcastChannel.postMessage(message);
    }
  }

  public setVAPIDKey(key: string): void {
    this.vapidPublicKey = key;
  }

  public getVAPIDKey(): string {
    return this.vapidPublicKey || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
  }

  static getInstance(): NotificationManager {
    if (typeof window === 'undefined') {
      // Return a dummy instance for SSR that won't access browser APIs
      return new NotificationManager();
    }
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager();
    }
    return NotificationManager.instance;
  }

  private async loadPreferences(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem('Trellis-notification-preferences');
      if (stored) {
        this.preferences = { ...this.preferences, ...JSON.parse(stored) };
      }

      this.migrateLegacyAlertPreferences();
    } catch (error) {
      console.warn('Failed to load notification preferences:', error);
    }
  }

  /**
   * One-time migration: before alert preferences existed, sound and quiet hours
   * lived only on `NotificationPreferences`. Seed the richer store from them so
   * an existing user's settings are not silently reset.
   */
  private migrateLegacyAlertPreferences(): void {
    if (typeof window === 'undefined') return;

    try {
      if (localStorage.getItem(ALERT_PREFERENCES_KEY)) {
        return;
      }

      persistAlertPreferences({
        audioEnabled: this.preferences.soundEnabled,
        quietHours: {
          ...readAlertPreferences().quietHours,
          enabled: this.preferences.quietHours.enabled,
          start: this.preferences.quietHours.start,
          end: this.preferences.quietHours.end,
        },
      });
    } catch (error) {
      console.warn('Failed to migrate alert preferences:', error);
    }
  }

  private savePreferences(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('Trellis-notification-preferences', JSON.stringify(this.preferences));
    } catch (error) {
      console.warn('Failed to save notification preferences:', error);
    }
  }

  getPreferences(): NotificationPreferences {
    return { ...this.preferences };
  }

  updatePreferences(updates: Partial<NotificationPreferences>): void {
    this.preferences = { ...this.preferences, ...updates };
    this.savePreferences();

    // Keep the alert-preference store in step when the legacy screen is used.
    const patch: Partial<AlertPreferences> = {};

    if (updates.soundEnabled !== undefined) {
      patch.audioEnabled = updates.soundEnabled;
    }

    if (updates.quietHours) {
      patch.quietHours = { ...readAlertPreferences().quietHours, ...updates.quietHours };
    }

    if (Object.keys(patch).length > 0) {
      persistAlertPreferences(patch);
    }
  }

  /** Audio/quiet-hours/category policy shared with `NotificationCenter`. */
  getAlertPreferences(): AlertPreferences {
    return readAlertPreferences();
  }

  updateAlertPreferences(updates: Partial<AlertPreferences>): AlertPreferences {
    const next = persistAlertPreferences(updates);
    this.preferences = {
      ...this.preferences,
      soundEnabled: next.audioEnabled,
      quietHours: {
        enabled: next.quietHours.enabled,
        start: next.quietHours.start,
        end: next.quietHours.end,
      },
    };
    this.savePreferences();
    return next;
  }

  /** Preview a chime regardless of the policy (used by the settings screen). */
  playAlertSound(severity: NotificationSeverity = 'info'): boolean {
    const preferences = this.getAlertPreferences();
    return playChime(severity, { volume: preferences.volume });
  }

  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported) {
      throw new Error('Notifications are not supported in this browser');
    }

    const permission = await Notification.requestPermission();
    return permission;
  }

  async getCurrentPermission(): Promise<NotificationPermission> {
    if (!this.isSupported) {
      return 'denied';
    }
    return Notification.permission;
  }

  /**
   * Quiet hours, evaluated from the shared alert schedule (which supports
   * per-day windows and crossing midnight) rather than from the legacy copy on
   * `NotificationPreferences`. Public so settings UIs can show whether the
   * window is active right now.
   */
  isInQuietHours(now: Date = new Date()): boolean {
    return isWithinQuietHours(now, this.getAlertPreferences().quietHours);
  }

  async subscribeToPush(): Promise<PushSubscription | null> {
    if (!this.isSupported) {
      throw new Error('Push notifications are not supported');
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = this.vapidPublicKey
        ? this.urlBase64ToUint8Array(this.vapidPublicKey)
        : this.urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '');
      
      this.subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      this.broadcastMessage({
        type: 'notification_created',
        timestamp: Date.now(),
        sourceTab: TAB_ID,
      });

      return this.subscription;
    } catch (error) {
      console.error('Failed to subscribe to push notifications:', error);
      return null;
    }
  }

  async unsubscribeFromPush(): Promise<void> {
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
      this.broadcastMessage({
        type: 'notification_created',
        timestamp: Date.now(),
        sourceTab: TAB_ID,
      });
    }
  }

  getSubscription(): PushSubscription | null {
    return this.subscription;
  }

  async updatePreferences(updates: Partial<NotificationPreferences>): void {
    this.preferences = { ...this.preferences, ...updates };
    if (updates.eventCategories) {
      this.preferences.eventCategories = { ...this.preferences.eventCategories, ...updates.eventCategories };
    }
    this.savePreferences();
    this.broadcastMessage({
      type: 'notification_created',
      timestamp: Date.now(),
      sourceTab: TAB_ID,
    });
  }

  isEventCategoryEnabled(category: string): boolean {
    return this.preferences.eventCategories[category] !== false;
  }

  getEventCategories(): Record<string, boolean> {
    return { ...this.preferences.eventCategories };
  }

  getWebhooks(): WebhookEndpoint[] {
    return this.preferences.webhooks || [];
  }

  addWebhook(webhookData: Omit<WebhookEndpoint, 'id' | 'createdAt'>): WebhookEndpoint {
    const newWebhook: WebhookEndpoint = {
      ...webhookData,
      id: `wh_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString(),
    };
    const webhooks = [...(this.preferences.webhooks || []), newWebhook];
    this.updatePreferences({ webhooks });
    return newWebhook;
  }

  updateWebhook(id: string, updates: Partial<WebhookEndpoint>): WebhookEndpoint | null {
    const webhooks = (this.preferences.webhooks || []).map((w) =>
      w.id === id ? { ...w, ...updates } : w
    );
    this.updatePreferences({ webhooks });
    return webhooks.find((w) => w.id === id) || null;
  }

  deleteWebhook(id: string): boolean {
    const initialLen = (this.preferences.webhooks || []).length;
    const webhooks = (this.preferences.webhooks || []).filter((w) => w.id !== id);
    if (webhooks.length !== initialLen) {
      this.updatePreferences({ webhooks });
      return true;
    }
    return false;
  }

  getEmailDigestPreferences(): EmailDigestPreferences {
    return this.preferences.emailDigest || {
      enabled: false,
      email: '',
      frequency: 'daily',
      triggers: {
        newProposal: true,
        highErrorRate: true,
        payoutExecuted: true,
        agentMinted: true,
      },
    };
  }

  updateEmailDigestPreferences(updates: Partial<EmailDigestPreferences>): void {
    const current = this.getEmailDigestPreferences();
    const updated = { ...current, ...updates };
    if (updates.triggers) {
      updated.triggers = { ...current.triggers, ...updates.triggers };
    }
    this.updatePreferences({ emailDigest: updated });
  }

  async triggerWebhooks(
    event: WebhookEventTrigger,
    payloadData: Record<string, any>
  ): Promise<Array<{ endpointId: string; success: boolean; status?: number; error?: string }>> {
    const webhooks = this.getWebhooks().filter((w) => w.enabled && w.triggers.includes(event));
    const results = [];

    for (const endpoint of webhooks) {
      const res = await dispatchWebhookPayload(endpoint, event, payloadData);
      this.updateWebhook(endpoint.id, {
        lastTriggeredAt: new Date().toISOString(),
        lastStatus: res.success ? 'success' : 'failed',
      });
      results.push({
        endpointId: endpoint.id,
        ...res,
      });
    }

    return results;
  }

  async showNotification(data: NotificationData): Promise<void> {
    if (!this.preferences.enabled) {
      return;
    }

    const severity = data.severity ?? 'info';
    const alertPreferences = this.getAlertPreferences();
    // One policy decides both the chime and whether the notification surfaces:
    // category mutes always win, quiet hours only silence non-critical alerts
    // (unless the user opted into muting critical ones too).
    const decision = evaluateAlert(alertPreferences, {
      severity,
      eventType: data.eventType,
    });

    if (decision.reason === 'category_muted') {
      console.log('Notification suppressed by category mute');
      return;
    }

    if (decision.reason === 'quiet_hours') {
      console.log('Notification suppressed due to quiet hours');
      return;
    }

    if (decision.play) {
      playChime(severity, { volume: alertPreferences.volume });
    }

    const permission = await this.getCurrentPermission();
    if (permission !== 'granted') {
      console.log('Notification permission not granted');
      return;
    }

    const type = data.data?.type || 'general';
    const category = data.data?.category || type;
    if (!this.isEventCategoryEnabled(category)) {
      return;
    }
    if (type === 'trade' && !this.preferences.tradeNotifications) {
      return;
    }
    if (type === 'transaction' && !this.preferences.transactionNotifications) {
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      
      const notificationData = {
        title: data.title,
        body: data.body,
        icon: data.icon || '/icons/icon-192x192.png',
        badge: data.badge || '/icons/icon-192x192.png',
        tag: data.tag || 'Trellis',
        requireInteraction: data.requireInteraction || false,
        silent: !this.preferences.soundEnabled,
        vibrate: this.preferences.vibrationEnabled ? [100, 50, 100] : undefined,
        data: {
          ...data.data,
          timestamp: Date.now()
        },
        actions: data.actions || []
      };

      await registration.showNotification(data.title, notificationData as any);

      this.broadcastMessage({
        type: 'notification_created',
        notificationId: data.data?.transactionHash || Date.now().toString(),
        timestamp: Date.now(),
        sourceTab: TAB_ID,
      });
    } catch (error) {
      console.error('Failed to show notification:', error);
      
      if (permission === 'granted') {
        new Notification(data.title, {
          body: data.body,
          icon: data.icon || '/icons/icon-192x192.png',
          badge: data.badge || '/icons/icon-192x192.png',
          tag: data.tag || 'Trellis',
          requireInteraction: data.requireInteraction || false,
          silent: !this.preferences.soundEnabled,
          vibrate: (this.preferences.vibrationEnabled ? [100, 50, 100] : undefined) as any,
          data: data.data
        } as any);
      }
    }
  }

  destroy(): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  async showTradeNotification(
    transactionResult: SorobanTransactionResult,
    agentName: string,
    amount?: string
  ): Promise<void> {
    if (transactionResult.success) {
      await this.showNotification({
        title: 'Trade Successful! 🎉',
        body: `Successfully completed transaction for ${agentName}${amount ? ` (${amount})` : ''}`,
        tag: 'trade-success',
        severity: 'success',
        eventType: 'simulation_completed',
        data: {
          type: 'trade',
          transactionHash: transactionResult.hash,
          agentName,
          amount,
          url: '/portfolio',
          status: 'success'
        },
        actions: [
          {
            action: 'view-transaction',
            title: 'View Details',
            icon: '/icons/icon-192x192.png'
          },
          {
            action: 'view-portfolio',
            title: 'View Portfolio',
            icon: '/icons/icon-192x192.png'
          }
        ]
      });
    } else {
      await this.showNotification({
        title: 'Trade Failed ❌',
        body: `Transaction failed for ${agentName}: ${transactionResult.error}`,
        tag: 'trade-error',
        requireInteraction: true,
        severity: 'critical',
        eventType: 'simulation_failed',
        data: {
          type: 'trade',
          transactionHash: transactionResult.hash,
          agentName,
          error: transactionResult.error,
          url: '/portfolio',
          status: 'failed'
        },
        actions: [
          {
            action: 'retry-transaction',
            title: 'Retry',
            icon: '/icons/icon-192x192.png'
          }
        ]
      });
    }
  }

  async showTransactionNotification(
    transactionResult: SorobanTransactionResult,
    description: string
  ): Promise<void> {
    if (transactionResult.success) {
      await this.showNotification({
        title: 'Transaction Complete ✅',
        body: description,
        tag: 'transaction-success',
        severity: 'success',
        severity: 'success',
        data: {
          type: 'transaction',
          transactionHash: transactionResult.hash,
          url: '/portfolio',
          status: 'success'
        }
      });
    } else {
      await this.showNotification({
        title: 'Transaction Failed ❌',
        body: `${description}: ${transactionResult.error}`,
        tag: 'transaction-error',
        requireInteraction: true,
        severity: 'critical',
        eventType: 'transaction_failed',
        data: {
          type: 'transaction',
          transactionHash: transactionResult.hash,
          error: transactionResult.error,
          url: '/portfolio',
          status: 'failed'
        }
      });
    }
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async clearAllNotifications(): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.ready;
      const notifications = await registration.getNotifications();
      notifications.forEach(notification => notification.close());
    } catch (error) {
      console.error('Failed to clear notifications:', error);
    }
  }

  async getNotificationCount(): Promise<number> {
    try {
      const registration = await navigator.serviceWorker.ready;
      const notifications = await registration.getNotifications();
      return notifications.length;
    } catch (error) {
      console.error('Failed to get notification count:', error);
      return 0;
    }
  }
}

export const notificationManager = NotificationManager.getInstance();

import { LifecycleNotification as LifecycleNotificationType } from './notifications/lifecycle-types';

export interface NotificationThread {
  isThread: true;
  id: string;
  type: string;
  dedupKey: string;
  notifications: LifecycleNotificationType[];
  isRead: boolean;
  severity: 'critical' | 'warning' | 'info' | 'success';
  title: string;
  createdAt: string;
}

export function groupNotificationsIntoThreads(
  notifications: LifecycleNotificationType[]
): (LifecycleNotificationType | NotificationThread)[] {
  // Deduplicate first: rapid event bursts often deliver the exact same alert
  // (same id/content) more than once, which would otherwise flood threads.
  const seen = new Set<string>();
  const deduped: LifecycleNotificationType[] = [];
  for (const n of notifications) {
    const contentKey = `${n.id}|${n.title ?? ''}|${n.message ?? ''}|${n.createdAt ?? ''}`;
    if (seen.has(contentKey)) {
      continue;
    }
    seen.add(contentKey);
    deduped.push(n);
  }

  const groups = new Map<string, LifecycleNotificationType[]>();
  const singletons: LifecycleNotificationType[] = [];

  for (const n of deduped) {
    if (n.type && n.dedupKey) {
      const key = `${n.type}::${n.dedupKey}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(n);
    } else {
      singletons.push(n);
    }
  }

  const allItems: (LifecycleNotificationType | NotificationThread)[] = [];

  for (const [key, group] of groups.entries()) {
    if (group.length > 1) {
      group.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const isRead = group.every(n => n.isRead);
      const severities = group.map(n => n.severity);
      let highestSeverity: 'critical' | 'warning' | 'info' | 'success' = 'info';
      if (severities.includes('critical')) highestSeverity = 'critical';
      else if (severities.includes('warning')) highestSeverity = 'warning';
      else if (severities.includes('success')) highestSeverity = 'success';

      const formattedType = group[0].type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      
      allItems.push({
        isThread: true,
        id: `thread_${key}`,
        type: group[0].type,
        dedupKey: group[0].dedupKey,
        notifications: group,
        isRead,
        severity: highestSeverity,
        title: `${group.length} ${formattedType}`,
        createdAt: group[0].createdAt,
      });
    } else {
      allItems.push(group[0]);
    }
  }

  allItems.push(...singletons);
  allItems.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return allItems;
}
export * from './notifications/durable-preferences';
export * from './notifications/routing-model';
