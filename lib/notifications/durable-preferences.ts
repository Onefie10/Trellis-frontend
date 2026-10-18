import {
  NotificationCategory,
  QuietHoursSchedule,
  DEFAULT_QUIET_HOURS,
  ALERT_PREFERENCES_KEY,
  AlertPreferences,
  normaliseAlertPreferences,
  PreferencesStorage,
} from './alert-preferences';

export type { PreferencesStorage } from './alert-preferences';

export const DURABLE_PREFERENCES_VERSION = 1;
export const DURABLE_ALERT_PREFERENCES_KEY = 'Trellis-durable-alert-preferences-v1';
export const PREFERENCES_CHANGED_EVENT = 'Trellis-durable-preferences-changed';

export interface ChannelDeliveryPreferences {
  inApp: boolean;
  audio: boolean;
  webhook: boolean;
}

export interface DurableNotificationPreferences {
  version: number;
  /** Global master switch for optional notifications. Mandatory alerts ignore this. */
  enabled: boolean;
  /** Audio chime master toggle. */
  audioEnabled: boolean;
  /** Volume for chimes (0.0 - 1.0). */
  volume: number;
  /** Per-category mute toggles for optional notifications. */
  mutedCategories: Record<NotificationCategory, boolean>;
  /** Quiet hours scheduling. */
  quietHours: QuietHoursSchedule;
  /** Per-channel delivery preferences for optional notifications. */
  channels: ChannelDeliveryPreferences;
  /**
   * Immutable guarantee: mandatory lifecycle and security alerts CANNOT be suppressed
   * by user preferences. This property is always true and read-only.
   */
  readonly mandatoryDeliveryEnforced: true;
}

export const DEFAULT_CHANNEL_PREFERENCES: ChannelDeliveryPreferences = {
  inApp: true,
  audio: true,
  webhook: true,
};

export const DEFAULT_DURABLE_PREFERENCES: DurableNotificationPreferences = {
  version: DURABLE_PREFERENCES_VERSION,
  enabled: true,
  audioEnabled: true,
  volume: 0.6,
  mutedCategories: {
    trading: false,
    governance: false,
    security: false,
    system: false,
  },
  quietHours: {
    ...DEFAULT_QUIET_HOURS,
    days: [...DEFAULT_QUIET_HOURS.days],
  },
  channels: { ...DEFAULT_CHANNEL_PREFERENCES },
  mandatoryDeliveryEnforced: true,
};

/** In-memory fallback if localStorage is unavailable (SSR, Safari private mode, quota). */
let memoryStoreFallback: string | null = null;

function resolveStorage(storage?: PreferencesStorage | null): PreferencesStorage | null {
  if (storage) return storage;

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Access denied or unsupported
  }

  return {
    getItem: () => memoryStoreFallback,
    setItem: (_key: string, value: string) => {
      memoryStoreFallback = value;
    },
  };
}

/**
 * Normalise raw input into a safe, valid DurableNotificationPreferences object.
 * Protects against corrupted storage payloads, missing keys, and out-of-range volumes.
 */
export function normaliseDurablePreferences(raw: unknown): DurableNotificationPreferences {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_DURABLE_PREFERENCES,
      mutedCategories: { ...DEFAULT_DURABLE_PREFERENCES.mutedCategories },
      quietHours: { ...DEFAULT_QUIET_HOURS, days: [...DEFAULT_QUIET_HOURS.days] },
      channels: { ...DEFAULT_CHANNEL_PREFERENCES },
      mandatoryDeliveryEnforced: true,
    };
  }

  const data = raw as Partial<DurableNotificationPreferences>;
  const baseAlert = normaliseAlertPreferences(data);
  const rawChannels = (data.channels ?? {}) as Partial<ChannelDeliveryPreferences>;

  return {
    version: DURABLE_PREFERENCES_VERSION,
    enabled: data.enabled !== false,
    audioEnabled: baseAlert.audioEnabled,
    volume: baseAlert.volume,
    mutedCategories: baseAlert.mutedCategories,
    quietHours: baseAlert.quietHours,
    channels: {
      inApp: rawChannels.inApp !== false,
      audio: rawChannels.audio !== false,
      webhook: rawChannels.webhook !== false,
    },
    mandatoryDeliveryEnforced: true,
  };
}

/**
 * Load durable preferences.
 * Seamlessly migrates from legacy AlertPreferences if the durable key is missing.
 */
export function loadDurablePreferences(
  storage?: PreferencesStorage | null
): DurableNotificationPreferences {
  const store = resolveStorage(storage);
  if (!store) return { ...DEFAULT_DURABLE_PREFERENCES };

  try {
    // 1. Try reading the v1 durable key
    const durableRaw = store.getItem(DURABLE_ALERT_PREFERENCES_KEY);
    if (durableRaw) {
      return normaliseDurablePreferences(JSON.parse(durableRaw));
    }

    // 2. Fall back and migrate from legacy ALERT_PREFERENCES_KEY
    const legacyRaw = store.getItem(ALERT_PREFERENCES_KEY);
    if (legacyRaw) {
      const parsedLegacy = JSON.parse(legacyRaw) as Partial<AlertPreferences>;
      const migrated = normaliseDurablePreferences({
        ...parsedLegacy,
        enabled: true,
        channels: DEFAULT_CHANNEL_PREFERENCES,
      });
      // Save forward to durable storage
      try {
        store.setItem(DURABLE_ALERT_PREFERENCES_KEY, JSON.stringify(migrated));
      } catch {
        // Ignore quota/write issues during migration
      }
      return migrated;
    }
  } catch {
    // JSON parse error or security exception -> return safe defaults
  }

  return { ...DEFAULT_DURABLE_PREFERENCES };
}

/**
 * Persist durable preferences to storage and broadcast change notification.
 */
export function saveDurablePreferences(
  preferences: DurableNotificationPreferences,
  storage?: PreferencesStorage | null
): void {
  const store = resolveStorage(storage);
  const validated = normaliseDurablePreferences(preferences);

  try {
    const serialized = JSON.stringify(validated);
    store?.setItem(DURABLE_ALERT_PREFERENCES_KEY, serialized);

    // Keep legacy key in sync for backward compatibility
    store?.setItem(
      ALERT_PREFERENCES_KEY,
      JSON.stringify({
        audioEnabled: validated.audioEnabled,
        volume: validated.volume,
        mutedCategories: validated.mutedCategories,
        quietHours: validated.quietHours,
      })
    );

    // Broadcast across components and tabs
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent(PREFERENCES_CHANGED_EVENT, { detail: validated })
      );
    }
  } catch {
    // Quota exceeded: keep in memory
    memoryStoreFallback = JSON.stringify(validated);
  }
}

/**
 * Apply a partial update to durable preferences and return the normalized result.
 */
export function updateDurablePreferences(
  patch: Partial<DurableNotificationPreferences>,
  storage?: PreferencesStorage | null
): DurableNotificationPreferences {
  const current = loadDurablePreferences(storage);
  const next = normaliseDurablePreferences({
    ...current,
    ...patch,
    mutedCategories: {
      ...current.mutedCategories,
      ...(patch.mutedCategories ?? {}),
    },
    quietHours: {
      ...current.quietHours,
      ...(patch.quietHours ?? {}),
    },
    channels: {
      ...current.channels,
      ...(patch.channels ?? {}),
    },
    mandatoryDeliveryEnforced: true,
  });

  saveDurablePreferences(next, storage);
  return next;
}

/**
 * Subscribe to preference updates (both in-memory and cross-tab storage changes).
 */
export function subscribeToDurablePreferences(
  callback: (prefs: DurableNotificationPreferences) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleCustomEvent = (event: Event) => {
    const custom = event as CustomEvent<DurableNotificationPreferences>;
    if (custom.detail) {
      callback(custom.detail);
    } else {
      callback(loadDurablePreferences());
    }
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (
      event.key === DURABLE_ALERT_PREFERENCES_KEY ||
      event.key === ALERT_PREFERENCES_KEY
    ) {
      callback(loadDurablePreferences());
    }
  };

  window.addEventListener(PREFERENCES_CHANGED_EVENT, handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    window.removeEventListener(PREFERENCES_CHANGED_EVENT, handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}
