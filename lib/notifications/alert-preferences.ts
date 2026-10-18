import {
  LifecycleEventType,
  NotificationSeverity,
} from "./lifecycle-types";

/**
 * Pure alert-delivery policy: audio chimes, quiet hours and per-category mutes.
 *
 * Kept free of React and of the Web Audio API so the scheduling rules can be
 * unit tested directly, and so both `NotificationCenter` and
 * `NotificationManager` share exactly one source of truth for "should this
 * notification make a sound right now?".
 */

export type NotificationCategory = "trading" | "governance" | "security" | "system";

/** Reasons a chime was suppressed; surfaced so the UI can explain a silent alert. */
export type AlertSuppressionReason = "audio_disabled" | "category_muted" | "quiet_hours";

export interface QuietHoursSchedule {
  enabled: boolean;
  /** `HH:MM`, local time. */
  start: string;
  /** `HH:MM`, local time. `start > end` means the window crosses midnight. */
  end: string;
  /** Weekdays the window *starts* on, `0` = Sunday. Empty means every day. */
  days: number[];
  /** When true, even `critical` alerts are silenced during quiet hours. */
  muteCritical: boolean;
}

export interface AlertPreferences {
  audioEnabled: boolean;
  /** Chime volume, `0`..`1`. */
  volume: number;
  /** `true` means "muted" for that category. */
  mutedCategories: Record<NotificationCategory, boolean>;
  quietHours: QuietHoursSchedule;
}

export const ALERT_PREFERENCES_KEY = "Trellis-alert-preferences";

export const NOTIFICATION_CATEGORIES: ReadonlyArray<{
  id: NotificationCategory;
  label: string;
  description: string;
}> = [
  { id: "trading", label: "Trading", description: "Trades, simulations and transaction results" },
  { id: "governance", label: "Governance", description: "Proposals and approvals that need a vote" },
  { id: "security", label: "Security", description: "Audit alerts and recovery actions" },
  { id: "system", label: "System", description: "Agent lifecycle and platform status" },
];

export const DEFAULT_QUIET_HOURS: QuietHoursSchedule = {
  enabled: false,
  start: "22:00",
  end: "08:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  muteCritical: false,
};

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  audioEnabled: true,
  volume: 0.6,
  mutedCategories: {
    trading: false,
    governance: false,
    security: false,
    system: false,
  },
  quietHours: { ...DEFAULT_QUIET_HOURS, days: [...DEFAULT_QUIET_HOURS.days] },
};

/** Lifecycle event type -> the category a user can mute independently. */
export const CATEGORY_BY_EVENT_TYPE: Record<LifecycleEventType, NotificationCategory> = {
  agent_minted: "system",
  agent_upgraded: "system",
  agent_deprecated: "system",
  simulation_completed: "trading",
  simulation_failed: "trading",
  transaction_failed: "trading",
  recovery_action_required: "security",
  approval_required: "governance",
  governance_proposal_active: "governance",
  rate_limit_warning: "system",
  security_audit_alert: "security",
};

export function categoryForEventType(type: LifecycleEventType): NotificationCategory {
  return CATEGORY_BY_EVENT_TYPE[type] ?? "system";
}

/** Parse `HH:MM` into minutes since midnight; `null` when malformed. */
export function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

export function formatMinutesToTime(minutes: number): string {
  const normalised = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalised / 60);
  const mins = normalised % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Whether `now` falls inside the quiet-hours window.
 *
 * Handles windows that cross midnight (22:00 -> 08:00), where the early-morning
 * part belongs to the *previous* day's window: with `days: [5]` (Friday), a
 * Saturday 02:00 alert is inside Friday's window.
 */
export function isWithinQuietHours(now: Date, schedule: QuietHoursSchedule): boolean {
  if (!schedule.enabled) {
    return false;
  }

  const start = parseTimeToMinutes(schedule.start);
  const end = parseTimeToMinutes(schedule.end);

  // A malformed or zero-length window would otherwise silence everything.
  if (start === null || end === null || start === end) {
    return false;
  }

  const days = schedule.days.length > 0 ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const current = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();

  if (start < end) {
    return days.includes(day) && current >= start && current < end;
  }

  if (current >= start) {
    return days.includes(day);
  }

  if (current < end) {
    // Early morning belongs to the window that started the previous evening.
    return days.includes((day + 6) % 7);
  }

  return false;
}

export interface AlertDecisionInput {
  severity: NotificationSeverity;
  eventType?: LifecycleEventType;
  now?: Date;
}

export interface AlertDecision {
  play: boolean;
  reason: AlertSuppressionReason | null;
  /** True when the alert fell inside quiet hours, whether or not it played. */
  duringQuietHours: boolean;
}

/**
 * Decide whether a notification should play its chime.
 *
 * Order matters: audio must be on, the category must not be muted, and quiet
 * hours only silence non-critical alerts unless `quietHours.muteCritical`.
 */
export function evaluateAlert(
  preferences: AlertPreferences,
  input: AlertDecisionInput,
): AlertDecision {
  const now = input.now ?? new Date();
  const duringQuietHours = isWithinQuietHours(now, preferences.quietHours);

  if (!preferences.audioEnabled) {
    return { play: false, reason: "audio_disabled", duringQuietHours };
  }

  if (input.eventType && preferences.mutedCategories[categoryForEventType(input.eventType)]) {
    return { play: false, reason: "category_muted", duringQuietHours };
  }

  if (duringQuietHours && (input.severity !== "critical" || preferences.quietHours.muteCritical)) {
    return { play: false, reason: "quiet_hours", duringQuietHours };
  }

  return { play: true, reason: null, duringQuietHours };
}

/** The subset of the Web Storage API needed here (mockable in tests). */
export interface PreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: PreferencesStorage | null): PreferencesStorage | null {
  if (storage) {
    return storage;
  }

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage can be unavailable (SSR, private mode); fall back to defaults.
  }

  return null;
}

/** `HH:MM` in range; used to reject a malformed stored schedule. */
function isTimeString(value: unknown): boolean {
  return typeof value === "string" && parseTimeToMinutes(value) !== null;
}

/** Merge a stored (possibly partial or stale) payload over the defaults. */
export function normaliseAlertPreferences(value: unknown): AlertPreferences {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_ALERT_PREFERENCES,
      mutedCategories: { ...DEFAULT_ALERT_PREFERENCES.mutedCategories },
      quietHours: { ...DEFAULT_QUIET_HOURS, days: [...DEFAULT_QUIET_HOURS.days] },
    };
  }

  const raw = value as Partial<AlertPreferences>;
  const quietHours = (raw.quietHours ?? {}) as Partial<QuietHoursSchedule>;

  return {
    audioEnabled: raw.audioEnabled !== false,
    volume:
      typeof raw.volume === "number" && Number.isFinite(raw.volume)
        ? Math.min(1, Math.max(0, raw.volume))
        : DEFAULT_ALERT_PREFERENCES.volume,
    mutedCategories: (() => {
      const result: Record<NotificationCategory, boolean> = {
        ...DEFAULT_ALERT_PREFERENCES.mutedCategories,
      };
      if (raw.mutedCategories && typeof raw.mutedCategories === 'object') {
        for (const cat of NOTIFICATION_CATEGORIES) {
          if (typeof (raw.mutedCategories as any)[cat.id] === 'boolean') {
            result[cat.id] = (raw.mutedCategories as any)[cat.id];
          }
        }
      }
      return result;
    })(),
    quietHours: {
      enabled: quietHours.enabled === true,
      start: isTimeString(quietHours.start) ? (quietHours.start as string) : DEFAULT_QUIET_HOURS.start,
      end: isTimeString(quietHours.end) ? (quietHours.end as string) : DEFAULT_QUIET_HOURS.end,
      days: Array.isArray(quietHours.days)
        ? quietHours.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
        : [...DEFAULT_QUIET_HOURS.days],
      muteCritical: quietHours.muteCritical === true,
    },
  };
}

export function loadAlertPreferences(storage?: PreferencesStorage | null): AlertPreferences {
  const target = resolveStorage(storage);

  try {
    const stored = target?.getItem(ALERT_PREFERENCES_KEY);
    return stored ? normaliseAlertPreferences(JSON.parse(stored)) : normaliseAlertPreferences(null);
  } catch {
    return normaliseAlertPreferences(null);
  }
}

export function saveAlertPreferences(
  preferences: AlertPreferences,
  storage?: PreferencesStorage | null,
): void {
  try {
    resolveStorage(storage)?.setItem(ALERT_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Quota or a denied storage API: the in-memory preferences still apply.
  }
}

export function updateAlertPreferences(
  patch: Partial<AlertPreferences>,
  storage?: PreferencesStorage | null,
): AlertPreferences {
  const current = loadAlertPreferences(storage);
  const next = normaliseAlertPreferences({
    ...current,
    ...patch,
    mutedCategories: { ...current.mutedCategories, ...(patch.mutedCategories ?? {}) },
    quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
  });

  saveAlertPreferences(next, storage);
  return next;
}
