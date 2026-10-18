import {
  ALERT_PREFERENCES_KEY,
  AlertPreferences,
  DEFAULT_ALERT_PREFERENCES,
  categoryForEventType,
  evaluateAlert,
  formatMinutesToTime,
  isWithinQuietHours,
  loadAlertPreferences,
  normaliseAlertPreferences,
  parseTimeToMinutes,
  saveAlertPreferences,
  updateAlertPreferences,
  type PreferencesStorage,
  type QuietHoursSchedule,
} from '../../lib/notifications/alert-preferences';
import {
  AudioContextLike,
  CHIME_PATTERNS,
  GainNodeLike,
  OscillatorNodeLike,
  playAlertChime,
  playChime,
} from '../../lib/notifications/chime';

/** September 2026: the 25th is a Friday, the 27th a Sunday. */
const FRIDAY_2330 = new Date(2026, 8, 25, 23, 30);
const SATURDAY_0200 = new Date(2026, 8, 26, 2, 0);
const SATURDAY_2230 = new Date(2026, 8, 26, 22, 30);
const SUNDAY_0200 = new Date(2026, 8, 27, 2, 0);
const MONDAY_0200 = new Date(2026, 8, 28, 2, 0);

function quietHours(overrides: Partial<QuietHoursSchedule> = {}): QuietHoursSchedule {
  return { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6], muteCritical: false, ...overrides };
}

function preferences(overrides: Partial<AlertPreferences> = {}): AlertPreferences {
  return {
    ...DEFAULT_ALERT_PREFERENCES,
    mutedCategories: { ...DEFAULT_ALERT_PREFERENCES.mutedCategories },
    quietHours: quietHours({ enabled: false }),
    ...overrides,
  };
}

function memoryStorage(): PreferencesStorage {
  const map = new Map<string, string>();

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

// --- Web Audio fakes -------------------------------------------------------

class FakeParam {
  value = 0;
  setCalls: Array<{ value: number; time: number }> = [];
  rampCalls: Array<{ value: number; time: number }> = [];

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.setCalls.push({ value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.rampCalls.push({ value, time });
  }
}

class FakeOscillator implements OscillatorNodeLike {
  type: OscillatorType = 'sine';
  frequency = new FakeParam();
  startedAt: number | undefined;
  stoppedAt: number | undefined;
  connectedTo: unknown;

  constructor(log: FakeOscillator[]) {
    log.push(this);
  }

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

  start(when?: number): void {
    this.startedAt = when;
  }

  stop(when?: number): void {
    this.stoppedAt = when;
  }
}

class FakeGain implements GainNodeLike {
  gain = new FakeParam();
  connectedTo: unknown;

  constructor(log: FakeGain[]) {
    log.push(this);
  }

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 5;
  state = 'running';
  destination = { id: 'destination' };
  resumeCalls = 0;
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];

  createOscillator(): OscillatorNodeLike {
    return new FakeOscillator(this.oscillators);
  }

  createGain(): GainNodeLike {
    return new FakeGain(this.gains);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    return Promise.resolve();
  }
}

describe('parseTimeToMinutes / formatMinutesToTime', () => {
  it('parses HH:MM and pads single-digit hours', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('8:05')).toBe(485);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('rejects malformed or out-of-range values', () => {
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('12:60')).toBeNull();
    expect(parseTimeToMinutes('noon')).toBeNull();
    expect(parseTimeToMinutes('')).toBeNull();
  });

  it('formats minutes back to HH:MM and wraps around midnight', () => {
    expect(formatMinutesToTime(485)).toBe('08:05');
    expect(formatMinutesToTime(1440)).toBe('00:00');
    expect(formatMinutesToTime(-60)).toBe('23:00');
  });
});

describe('isWithinQuietHours', () => {
  it('is inactive while disabled', () => {
    expect(isWithinQuietHours(FRIDAY_2330, quietHours({ enabled: false }))).toBe(false);
  });

  it('handles a same-day window', () => {
    const schedule = quietHours({ start: '09:00', end: '17:00' });

    expect(isWithinQuietHours(new Date(2026, 8, 25, 12, 0), schedule)).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 8, 25, 17, 0), schedule)).toBe(false);
    expect(isWithinQuietHours(new Date(2026, 8, 25, 8, 59), schedule)).toBe(false);
  });

  it('handles a window that crosses midnight', () => {
    const schedule = quietHours();

    expect(isWithinQuietHours(FRIDAY_2330, schedule)).toBe(true);
    expect(isWithinQuietHours(SATURDAY_0200, schedule)).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 8, 25, 12, 0), schedule)).toBe(false);
    expect(isWithinQuietHours(new Date(2026, 8, 25, 8, 0), schedule)).toBe(false);
  });

  it('attributes the early-morning part of an overnight window to the previous day', () => {
    const schedule = quietHours({ days: [5] });

    expect(isWithinQuietHours(FRIDAY_2330, schedule)).toBe(true);
    // Saturday 02:00 belongs to Friday's window...
    expect(isWithinQuietHours(SATURDAY_0200, schedule)).toBe(true);
    // ...but Saturday 22:30 and Monday 02:00 do not.
    expect(isWithinQuietHours(SATURDAY_2230, schedule)).toBe(false);
    expect(isWithinQuietHours(MONDAY_0200, schedule)).toBe(false);
  });

  it('treats an empty day list as every day', () => {
    const schedule = quietHours({ days: [] });

    expect(isWithinQuietHours(FRIDAY_2330, schedule)).toBe(true);
    expect(isWithinQuietHours(SUNDAY_0200, schedule)).toBe(true);
  });

  it('ignores malformed or zero-length windows instead of silencing everything', () => {
    expect(isWithinQuietHours(new Date(), quietHours({ start: 'nope' }))).toBe(false);
    expect(isWithinQuietHours(new Date(), quietHours({ start: '10:00', end: '10:00' }))).toBe(false);
  });
});

describe('evaluateAlert', () => {
  it('blocks every alert when audio is disabled', () => {
    const decision = evaluateAlert(preferences({ audioEnabled: false }), { severity: 'success' });

    expect(decision).toEqual({ play: false, reason: 'audio_disabled', duringQuietHours: false });
  });

  it('blocks alerts from a muted category', () => {
    const muted = preferences({
      mutedCategories: { ...DEFAULT_ALERT_PREFERENCES.mutedCategories, governance: true },
    });

    expect(evaluateAlert(muted, { severity: 'warning', eventType: 'governance_proposal_active' })).toMatchObject({
      play: false,
      reason: 'category_muted',
    });

    // A different category is unaffected.
    expect(evaluateAlert(muted, { severity: 'warning', eventType: 'security_audit_alert' }).play).toBe(true);
  });

  it('silences non-critical alerts inside quiet hours but lets critical ones through', () => {
    const schedule = preferences({ quietHours: quietHours() });

    expect(evaluateAlert(schedule, { severity: 'info', now: SATURDAY_0200 })).toMatchObject({
      play: false,
      reason: 'quiet_hours',
      duringQuietHours: true,
    });

    expect(evaluateAlert(schedule, { severity: 'critical', now: SATURDAY_0200 })).toMatchObject({
      play: true,
      reason: null,
      duringQuietHours: true,
    });
  });

  it('also silences critical alerts when the user opted in', () => {
    const schedule = preferences({ quietHours: quietHours({ muteCritical: true }) });

    expect(evaluateAlert(schedule, { severity: 'critical', now: SATURDAY_0200 })).toMatchObject({
      play: false,
      reason: 'quiet_hours',
    });
  });

  it('plays normally outside quiet hours', () => {
    const schedule = preferences({ quietHours: quietHours() });

    expect(evaluateAlert(schedule, { severity: 'success', now: new Date(2026, 8, 25, 12, 0) })).toMatchObject({
      play: true,
      duringQuietHours: false,
    });
  });

  it('maps lifecycle events onto mailable categories', () => {
    expect(categoryForEventType('governance_proposal_active')).toBe('governance');
    expect(categoryForEventType('security_audit_alert')).toBe('security');
    expect(categoryForEventType('simulation_failed')).toBe('trading');
    expect(categoryForEventType('agent_minted')).toBe('system');
  });
});

describe('alert preferences storage', () => {
  it('round-trips through a partial stored payload', () => {
    const storage = memoryStorage();

    saveAlertPreferences(
      preferences({
        audioEnabled: false,
        volume: 0.25,
        quietHours: quietHours({ days: [1, 2] }),
      }),
      storage,
    );

    const loaded = loadAlertPreferences(storage);

    expect(loaded.audioEnabled).toBe(false);
    expect(loaded.volume).toBe(0.25);
    expect(loaded.quietHours.enabled).toBe(true);
    expect(loaded.quietHours.days).toEqual([1, 2]);
    expect(loaded.mutedCategories.security).toBe(false);
  });

  it('falls back to defaults for missing, corrupt or invalid payloads', () => {
    const storage = memoryStorage();

    expect(loadAlertPreferences(storage)).toEqual(DEFAULT_ALERT_PREFERENCES);

    storage.setItem(ALERT_PREFERENCES_KEY, '{oops');
    expect(loadAlertPreferences(storage)).toEqual(DEFAULT_ALERT_PREFERENCES);
  });

  it('normalises out-of-range volume and unknown fields', () => {
    const normalised = normaliseAlertPreferences({
      volume: 42,
      audioEnabled: 'yes',
      quietHours: { enabled: true, start: '25:00', days: [9, 2] },
      mutedCategories: { trading: true, nonsense: true },
    });

    expect(normalised.volume).toBe(1);
    expect(normalised.audioEnabled).toBe(true);
    expect(normalised.quietHours.start).toBe('22:00');
    expect(normalised.quietHours.days).toEqual([2]);
    expect(normalised.mutedCategories.trading).toBe(true);
    expect(normalised.mutedCategories).not.toHaveProperty('nonsense');
  });

  it('merges a patch without dropping the other settings', () => {
    const storage = memoryStorage();
    saveAlertPreferences(preferences({ volume: 0.3 }), storage);

    const updated = updateAlertPreferences(
      { mutedCategories: { ...DEFAULT_ALERT_PREFERENCES.mutedCategories, system: true } },
      storage,
    );

    expect(updated.volume).toBe(0.3);
    expect(updated.mutedCategories.system).toBe(true);
    expect(loadAlertPreferences(storage).mutedCategories.system).toBe(true);
  });
});

describe('playChime', () => {
  it('schedules the success pattern on the shared volume', () => {
    const context = new FakeAudioContext();

    expect(playChime('success', { context, volume: 0.5 })).toBe(true);
    expect(context.oscillators).toHaveLength(CHIME_PATTERNS.success.length);
    expect(context.oscillators.map((oscillator) => oscillator.frequency.setCalls[0].value)).toEqual([660, 880]);
    expect(context.oscillators[0].startedAt).toBeCloseTo(5);
    expect(context.oscillators[1].startedAt).toBeCloseTo(5.11);

    // Each tone fades from near-silence up to the requested volume.
    for (const gain of context.gains) {
      expect(gain.gain.setCalls[0].value).toBeCloseTo(0.0001);
      expect(gain.gain.rampCalls[0].value).toBe(0.5);
      expect(gain.gain.rampCalls[1].value).toBeCloseTo(0.0001);
    }

    expect(context.oscillators[0].connectedTo).toBe(context.gains[0]);
    expect(context.gains[0].connectedTo).toBe(context.destination);
  });

  it('uses the three-tone square pattern for critical alerts', () => {
    const context = new FakeAudioContext();

    playChime('critical', { context });

    expect(context.oscillators).toHaveLength(3);
    expect(context.oscillators.map((oscillator) => oscillator.frequency.setCalls[0].value)).toEqual([880, 660, 880]);
    expect(context.oscillators.map((oscillator) => oscillator.type)).toEqual(['square', 'square', 'square']);
    expect(context.oscillators[2].stoppedAt).toBeCloseTo(5 + 0.28 + 0.2 + 0.02);
  });

  it('stays silent at zero volume', () => {
    const context = new FakeAudioContext();

    expect(playChime('success', { context, volume: 0 })).toBe(false);
    expect(context.oscillators).toHaveLength(0);
  });

  it('stays silent without an AudioContext and never throws', () => {
    expect(playChime('warning', { contextFactory: () => null })).toBe(false);

    const exploding: AudioContextLike = {
      currentTime: 0,
      destination: {},
      createOscillator() {
        throw new Error('audio blocked');
      },
      createGain: () => new FakeGain([]),
    };

    expect(playChime('critical', { context: exploding })).toBe(false);
  });

  it('resumes a suspended context first', () => {
    const context = new FakeAudioContext();
    context.state = 'suspended';

    playChime('info', { context });

    expect(context.resumeCalls).toBe(1);
  });
});

describe('playAlertChime', () => {
  it('combines the policy and the audio layer', () => {
    const context = new FakeAudioContext();
    const muted = preferences({
      mutedCategories: { ...DEFAULT_ALERT_PREFERENCES.mutedCategories, trading: true },
    });

    const suppressed = playAlertChime(muted, { severity: 'success', eventType: 'simulation_completed' }, { context });

    expect(suppressed).toMatchObject({ played: false });
    expect(suppressed.decision.reason).toBe('category_muted');
    expect(context.oscillators).toHaveLength(0);

    const played = playAlertChime(preferences(), { severity: 'critical' }, { context });

    expect(played).toMatchObject({ played: true });
    expect(played.decision.reason).toBeNull();
    expect(context.oscillators).toHaveLength(3);
  });

  it('applies the preference volume when none is supplied', () => {
    const context = new FakeAudioContext();

    playAlertChime(preferences({ volume: 0.2 }), { severity: 'info' }, { context });

    expect(context.gains[0].gain.rampCalls[0].value).toBe(0.2);
  });
});
