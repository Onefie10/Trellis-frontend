'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { notificationManager } from '@/lib/notifications';
import {
  AlertPreferences,
  DEFAULT_QUIET_HOURS,
  NOTIFICATION_CATEGORIES,
  NotificationCategory,
  QuietHoursSchedule,
  isWithinQuietHours,
  loadAlertPreferences,
  updateAlertPreferences,
} from '@/lib/notifications/alert-preferences';
import { playChime } from '@/lib/notifications/chime';
import { NotificationSeverity } from '@/lib/notifications/lifecycle-types';

export interface AlertPreferencesPanelProps {
  className?: string;
}

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

const TEST_SEVERITIES: NotificationSeverity[] = ['success', 'warning', 'critical'];

/**
 * Alert settings: audio chimes, quiet hours scheduling and per-category mutes.
 *
 * Preferences are persisted locally (`Trellis-alert-preferences`) and mirrored
 * onto `NotificationManager` so both the in-app chimes and the push/service
 * worker notifications respect the same quiet-hours window and sound switch.
 */
export const AlertPreferencesPanel: React.FC<AlertPreferencesPanelProps> = ({ className }) => {
  const [preferences, setPreferences] = useState<AlertPreferences>(() =>
    loadAlertPreferences(),
  );
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const quietHoursActive = isWithinQuietHours(new Date(), preferences.quietHours);

  const apply = useCallback((patch: Parameters<typeof updateAlertPreferences>[0]) => {
    const next = updateAlertPreferences(patch);
    setPreferences(next);

    // Keep the existing notification manager in step with the new settings.
    notificationManager.updatePreferences({
      soundEnabled: next.audioEnabled,
      quietHours: {
        enabled: next.quietHours.enabled,
        start: next.quietHours.start,
        end: next.quietHours.end,
      },
    });

    setSavedAt(new Date().toLocaleTimeString());
  }, []);

  const updateQuietHours = useCallback(
    (patch: Partial<QuietHoursSchedule>) => {
      apply({ quietHours: { ...preferences.quietHours, ...patch } });
    },
    [apply, preferences.quietHours],
  );

  const toggleCategory = useCallback(
    (category: NotificationCategory) => {
      apply({
        mutedCategories: {
          ...preferences.mutedCategories,
          [category]: !preferences.mutedCategories[category],
        },
      });
    },
    [apply, preferences.mutedCategories],
  );

  const toggleDay = useCallback(
    (day: number) => {
      const days = preferences.quietHours.days.includes(day)
        ? preferences.quietHours.days.filter((value) => value !== day)
        : [...preferences.quietHours.days, day].sort((a, b) => a - b);

      updateQuietHours({ days });
    },
    [preferences.quietHours.days, updateQuietHours],
  );

  // Read the latest value on mount so a second tab's change is picked up.
  useEffect(() => {
    setPreferences(loadAlertPreferences());
  }, []);

  return (
    <section
      className={`w-full rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-white ${
        className ?? ''
      }`}
      aria-label="Alert preferences"
    >
      <div className="flex items-start justify-between gap-3 border-b border-neutral-800 pb-3">
        <div>
          <h2 className="text-lg font-semibold">Alert Preferences</h2>
          <p className="text-xs text-neutral-400 mt-1">
            Controls the in-app chimes and quiet hours. Saved locally on this device.
          </p>
        </div>
        {savedAt && <span className="text-xs text-emerald-400 shrink-0">Saved {savedAt}</span>}
      </div>

      {/* Audio */}
      <div className="mt-4 space-y-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Audio alerts</span>
          <input
            type="checkbox"
            checked={preferences.audioEnabled}
            onChange={(event) => apply({ audioEnabled: event.target.checked })}
            aria-label="Enable audio alerts"
            className="h-4 w-4 accent-purple-600"
          />
        </label>

        <div className="flex items-center gap-3">
          <label htmlFor="alert-volume" className="text-sm text-neutral-300 w-28">
            Volume
          </label>
          <input
            id="alert-volume"
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(preferences.volume * 100)}
            disabled={!preferences.audioEnabled}
            onChange={(event) => apply({ volume: Number(event.target.value) / 100 })}
            className="flex-1 accent-purple-600 disabled:opacity-40"
          />
          <span className="text-xs text-neutral-400 w-10 text-right">
            {Math.round(preferences.volume * 100)}%
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">Preview:</span>
          {TEST_SEVERITIES.map((severity) => (
            <button
              key={severity}
              type="button"
              disabled={!preferences.audioEnabled}
              onClick={() => playChime(severity, { volume: preferences.volume })}
              className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-200 hover:border-purple-500 hover:text-white transition disabled:opacity-40"
            >
              {severity}
            </button>
          ))}
        </div>
      </div>

      {/* Quiet hours */}
      <div className="mt-6 pt-4 border-t border-neutral-800 space-y-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">
            Quiet hours
            {quietHoursActive && (
              <span className="ml-2 text-xs font-normal text-amber-400">active now</span>
            )}
          </span>
          <input
            type="checkbox"
            checked={preferences.quietHours.enabled}
            onChange={(event) => updateQuietHours({ enabled: event.target.checked })}
            aria-label="Enable quiet hours"
            className="h-4 w-4 accent-purple-600"
          />
        </label>

        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm text-neutral-300">
            <span className="block mb-1 text-xs text-neutral-400">Start</span>
            <input
              type="time"
              value={preferences.quietHours.start}
              disabled={!preferences.quietHours.enabled}
              onChange={(event) => updateQuietHours({ start: event.target.value })}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm disabled:opacity-40"
            />
          </label>
          <label className="text-sm text-neutral-300">
            <span className="block mb-1 text-xs text-neutral-400">End</span>
            <input
              type="time"
              value={preferences.quietHours.end}
              disabled={!preferences.quietHours.enabled}
              onChange={(event) => updateQuietHours({ end: event.target.value })}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm disabled:opacity-40"
            />
          </label>
          <span className="text-xs text-neutral-500">
            {preferences.quietHours.start > preferences.quietHours.end
              ? 'Window crosses midnight'
              : 'Same-day window'}
          </span>
        </div>

        <fieldset
          disabled={!preferences.quietHours.enabled}
          className="flex flex-wrap gap-2 disabled:opacity-40"
        >
          <legend className="sr-only">Days quiet hours start</legend>
          {WEEKDAYS.map((day) => {
            const active = preferences.quietHours.days.includes(day.value);

            return (
              <button
                key={day.value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleDay(day.value)}
                className={`text-xs px-2 py-1 rounded border transition ${
                  active
                    ? 'border-purple-500 bg-purple-600/20 text-white'
                    : 'border-neutral-700 text-neutral-400 hover:text-white'
                }`}
              >
                {day.label}
              </button>
            );
          })}
        </fieldset>

        <label className="flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-400">
            Also silence critical alerts during quiet hours
          </span>
          <input
            type="checkbox"
            checked={preferences.quietHours.muteCritical}
            disabled={!preferences.quietHours.enabled}
            onChange={(event) => updateQuietHours({ muteCritical: event.target.checked })}
            aria-label="Mute critical alerts during quiet hours"
            className="h-4 w-4 accent-purple-600 disabled:opacity-40"
          />
        </label>

        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => updateQuietHours({ ...DEFAULT_QUIET_HOURS, enabled: true, days: [...DEFAULT_QUIET_HOURS.days] })}
            className="px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white transition"
          >
            Reset to 22:00 - 08:00
          </button>
          <button
            type="button"
            onClick={() => updateQuietHours({ days: [0, 1, 2, 3, 4, 5, 6] })}
            className="px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white transition"
          >
            Every day
          </button>
          <button
            type="button"
            onClick={() => updateQuietHours({ days: [1, 2, 3, 4, 5] })}
            className="px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white transition"
          >
            Weekdays
          </button>
        </div>
      </div>

      {/* Category mutes */}
      <div className="mt-6 pt-4 border-t border-neutral-800">
        <h3 className="text-sm font-medium mb-3">Mute categories</h3>
        <ul className="space-y-2">
          {NOTIFICATION_CATEGORIES.map((category) => {
            const muted = preferences.mutedCategories[category.id];

            return (
              <li key={category.id} className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-sm">{category.label}</span>
                  <span className="block text-xs text-neutral-500">{category.description}</span>
                </span>
                <label className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs ${muted ? 'text-amber-400' : 'text-neutral-500'}`}>
                    {muted ? 'Muted' : 'On'}
                  </span>
                  <input
                    type="checkbox"
                    checked={muted}
                    onChange={() => toggleCategory(category.id)}
                    aria-label={`Mute ${category.label} notifications`}
                    className="h-4 w-4 accent-purple-600"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};
