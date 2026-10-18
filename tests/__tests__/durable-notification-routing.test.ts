import {
  lifecycleNotifications,
} from '../../lib/notifications/lifecycle-manager';
import {
  isMandatoryAlert,
  MANDATORY_EVENT_TYPES,
} from '../../lib/notifications/routing-model';
import {
  DurableNotificationPreferences,
  DEFAULT_DURABLE_PREFERENCES,
  loadDurablePreferences,
  updateDurablePreferences,
  normaliseDurablePreferences,
  DURABLE_ALERT_PREFERENCES_KEY,
  PreferencesStorage,
} from '../../lib/notifications/durable-preferences';
import {
  ALERT_PREFERENCES_KEY,
  QuietHoursSchedule,
} from '../../lib/notifications/alert-preferences';

describe('Durable Notification Preferences and Mandatory Alert Routing (Issue #278)', () => {
  beforeEach(() => {
    lifecycleNotifications.clear();
  });

  describe('Mandatory Alert Classification', () => {
    it('identifies dedicated lifecycle/security event types as mandatory', () => {
      MANDATORY_EVENT_TYPES.forEach((type) => {
        expect(isMandatoryAlert({ type, severity: 'warning' })).toBe(true);
      });
    });

    it('identifies critical severity as mandatory regardless of event type', () => {
      expect(
        isMandatoryAlert({ type: 'transaction_failed', severity: 'critical' })
      ).toBe(true);
      expect(
        isMandatoryAlert({ type: 'agent_minted', severity: 'critical' })
      ).toBe(true);
    });

    it('identifies explicit isMandatory: true as mandatory', () => {
      expect(
        isMandatoryAlert({
          type: 'simulation_completed',
          severity: 'info',
          isMandatory: true,
        })
      ).toBe(true);
    });

    it('identifies optional events with non-critical severity as non-mandatory', () => {
      expect(
        isMandatoryAlert({ type: 'simulation_completed', severity: 'info' })
      ).toBe(false);
      expect(
        isMandatoryAlert({ type: 'agent_minted', severity: 'info' })
      ).toBe(false);
      expect(
        isMandatoryAlert({ type: 'transaction_failed', severity: 'warning' })
      ).toBe(false);
    });
  });

  describe('Routing Model & Mandatory Delivery Guarantees', () => {
    const userWallet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    it('guarantees mandatory alert delivery even when category is muted', () => {
      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        mutedCategories: {
          ...DEFAULT_DURABLE_PREFERENCES.mutedCategories,
          security: true,
        },
      };

      const result = lifecycleNotifications.dispatch(
        {
          type: 'security_audit_alert',
          title: 'Vulnerability Detected in Vault Contract',
          message: 'Immediate patch required',
          severity: 'critical',
          recipientWallet: userWallet,
          audience: 'user',
        },
        { preferences: prefs }
      );

      expect(result.notification).not.toBeNull();
      expect(result.notification?.isMandatory).toBe(true);
      expect(result.routingDecision).toBe('mandatory_delivered');

      const userNotifs = lifecycleNotifications.getForUser(userWallet);
      expect(userNotifs.length).toBe(1);
      expect(userNotifs[0].title).toBe('Vulnerability Detected in Vault Contract');
    });

    it('guarantees mandatory alert delivery during quiet hours', () => {
      const quietSchedule: QuietHoursSchedule = {
        enabled: true,
        start: '22:00',
        end: '08:00',
        days: [0, 1, 2, 3, 4, 5, 6],
        muteCritical: false,
      };

      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        quietHours: quietSchedule,
      };

      const midnightTime = new Date(2026, 9, 15, 23, 30); // 23:30 (inside quiet hours)

      const result = lifecycleNotifications.dispatch(
        {
          type: 'recovery_action_required',
          title: 'Validator Node Out of Sync',
          message: 'Sign recovery transaction to restore consensus',
          severity: 'critical',
          recipientWallet: userWallet,
          recoveryAction: {
            label: 'Recover Node',
            actionId: 'recover_node',
          },
        },
        { preferences: prefs, now: midnightTime }
      );

      expect(result.notification).not.toBeNull();
      expect(result.notification?.isMandatory).toBe(true);
      expect(result.routingDecision).toBe('mandatory_delivered');

      const userNotifs = lifecycleNotifications.getForUser(userWallet);
      expect(userNotifs.length).toBe(1);
    });

    it('guarantees mandatory alert delivery when notifications are globally disabled', () => {
      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        enabled: false, // master switch OFF
      };

      const result = lifecycleNotifications.dispatch(
        {
          type: 'approval_required',
          title: 'Multi-sig Transaction Pending Signature',
          message: 'Threshold requirement not met without your signature',
          severity: 'warning',
          recipientWallet: userWallet,
        },
        { preferences: prefs }
      );

      expect(result.notification).not.toBeNull();
      expect(result.notification?.isMandatory).toBe(true);
      expect(result.routingDecision).toBe('mandatory_delivered');

      const userNotifs = lifecycleNotifications.getForUser(userWallet);
      expect(userNotifs.length).toBe(1);
    });

    it('suppresses optional notifications when their category is muted', () => {
      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        mutedCategories: {
          ...DEFAULT_DURABLE_PREFERENCES.mutedCategories,
          trading: true,
        },
      };

      const result = lifecycleNotifications.dispatch(
        {
          type: 'simulation_completed',
          title: 'Trade Simulation Succeeded',
          message: 'Yield expected: 4.2%',
          severity: 'info',
          recipientWallet: userWallet,
        },
        { preferences: prefs }
      );

      // Notification is suppressed from user inbox
      expect(result.notification).toBeNull();
      expect(result.routingDecision).toBe('suppressed');
      expect(result.auditRecord?.suppressionReasons).toContain('category_muted');

      // User inbox should be empty
      const userNotifs = lifecycleNotifications.getForUser(userWallet);
      expect(userNotifs.length).toBe(0);
    });

    it('suppresses optional notifications during quiet hours', () => {
      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '08:00',
          days: [0, 1, 2, 3, 4, 5, 6],
          muteCritical: false,
        },
      };

      const midnight = new Date(2026, 9, 15, 23, 0);

      const result = lifecycleNotifications.dispatch(
        {
          type: 'agent_minted',
          title: 'Agent Minted',
          message: 'Agent #42 has been registered',
          severity: 'info',
          recipientWallet: userWallet,
        },
        { preferences: prefs, now: midnight }
      );

      expect(result.notification).toBeNull();
      expect(result.routingDecision).toBe('suppressed');
      expect(result.auditRecord?.suppressionReasons).toContain('quiet_hours');

      const userNotifs = lifecycleNotifications.getForUser(userWallet);
      expect(userNotifs.length).toBe(0);
    });

    it('suppresses optional notifications when global switch is off', () => {
      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        enabled: false,
      };

      const result = lifecycleNotifications.dispatch(
        {
          type: 'agent_upgraded',
          title: 'Agent Upgraded',
          message: 'Version 2.0 deployed',
          severity: 'info',
          recipientWallet: userWallet,
        },
        { preferences: prefs }
      );

      expect(result.notification).toBeNull();
      expect(result.routingDecision).toBe('suppressed');
      expect(result.auditRecord?.suppressionReasons).toContain('notifications_disabled');
    });
  });

  describe('Auditable Delivery Log', () => {
    it('creates structured audit records for both delivered and suppressed alerts', () => {
      const prefs: DurableNotificationPreferences = {
        ...DEFAULT_DURABLE_PREFERENCES,
        mutedCategories: {
          ...DEFAULT_DURABLE_PREFERENCES.mutedCategories,
          trading: true,
        },
      };

      // 1. Mandatory alert -> delivered
      lifecycleNotifications.dispatch(
        {
          type: 'security_audit_alert',
          title: 'Security Notice',
          message: 'Audited successfully',
          severity: 'critical',
        },
        { preferences: prefs }
      );

      // 2. Optional alert -> suppressed
      lifecycleNotifications.dispatch(
        {
          type: 'simulation_completed',
          title: 'Sim Done',
          message: 'Completed',
          severity: 'info',
        },
        { preferences: prefs }
      );

      const auditLog = lifecycleNotifications.getAuditLog();
      expect(auditLog.length).toBe(2);

      const mandatoryRecord = auditLog.find((r) => r.isMandatory);
      expect(mandatoryRecord).toBeDefined();
      expect(mandatoryRecord?.routingDecision).toBe('mandatory_delivered');
      expect(mandatoryRecord?.channelsDelivered).toContain('in_app');

      const suppressedRecord = auditLog.find((r) => !r.isMandatory);
      expect(suppressedRecord).toBeDefined();
      expect(suppressedRecord?.routingDecision).toBe('suppressed');
      expect(suppressedRecord?.suppressionReasons).toContain('category_muted');

      // Export JSON
      const json = lifecycleNotifications.exportAuditLogJson();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });

    it('filters audit log by mandatoryOnly and walletAddress', () => {
      const walletA = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const walletB = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPXRKVKE544EOXY2S';

      lifecycleNotifications.dispatch({
        type: 'recovery_action_required',
        title: 'Action for A',
        message: 'Must recover',
        severity: 'critical',
        recipientWallet: walletA,
      });

      lifecycleNotifications.dispatch({
        type: 'agent_minted',
        title: 'Mint for B',
        message: 'Minted',
        severity: 'info',
        recipientWallet: walletB,
      });

      const auditA = lifecycleNotifications.getAuditLog({ walletAddress: walletA });
      expect(auditA.length).toBe(1);
      expect(auditA[0].recipientWallet).toBe(walletA);

      const mandatoryLog = lifecycleNotifications.getAuditLog({ mandatoryOnly: true });
      expect(mandatoryLog.length).toBe(1);
      expect(mandatoryLog[0].eventType).toBe('recovery_action_required');
    });
  });

  describe('Durable Preferences Persistence & Migration', () => {
    function createMockStorage(): PreferencesStorage {
      const store = new Map<string, string>();
      return {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
      };
    }

    it('saves and reloads durable preferences accurately', () => {
      const storage = createMockStorage();
      const updated = updateDurablePreferences(
        {
          volume: 0.85,
          mutedCategories: {
            trading: true,
            governance: false,
            security: false,
            system: false,
          },
        },
        storage
      );

      expect(updated.volume).toBe(0.85);
      expect(updated.mutedCategories.trading).toBe(true);

      const reloaded = loadDurablePreferences(storage);
      expect(reloaded.volume).toBe(0.85);
      expect(reloaded.mutedCategories.trading).toBe(true);
      expect(reloaded.mandatoryDeliveryEnforced).toBe(true);
    });

    it('migrates from legacy ALERT_PREFERENCES_KEY transparently', () => {
      const storage = createMockStorage();

      // Legacy stored preferences
      const legacy = {
        audioEnabled: true,
        volume: 0.45,
        mutedCategories: { trading: true, governance: false, security: false, system: false },
        quietHours: { enabled: true, start: '23:00', end: '07:00', days: [1, 2, 3], muteCritical: false },
      };
      storage.setItem(ALERT_PREFERENCES_KEY, JSON.stringify(legacy));

      // Load through durable loader
      const loaded = loadDurablePreferences(storage);
      expect(loaded.version).toBe(1);
      expect(loaded.volume).toBe(0.45);
      expect(loaded.mutedCategories.trading).toBe(true);
      expect(loaded.quietHours.start).toBe('23:00');
      expect(loaded.enabled).toBe(true);
      expect(loaded.channels.inApp).toBe(true);
      expect(loaded.mandatoryDeliveryEnforced).toBe(true);

      // Verify that durable key was populated forward
      expect(storage.getItem(DURABLE_ALERT_PREFERENCES_KEY)).not.toBeNull();
    });

    it('normalises corrupted or partial payloads with safe defaults', () => {
      expect(normaliseDurablePreferences(null)).toEqual(DEFAULT_DURABLE_PREFERENCES);
      expect(normaliseDurablePreferences('invalid')).toEqual(DEFAULT_DURABLE_PREFERENCES);

      const clamped = normaliseDurablePreferences({ volume: 999 });
      expect(clamped.volume).toBe(1);

      const negativeVolume = normaliseDurablePreferences({ volume: -5 });
      expect(negativeVolume.volume).toBe(0);
    });
  });
});
