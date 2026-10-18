import { LifecycleEventType, NotificationSeverity } from "./lifecycle-types";
import {
  AlertDecision,
  AlertPreferences,
  evaluateAlert,
} from "./alert-preferences";

/**
 * Web Audio chimes for notification severities.
 *
 * Synthesised with oscillators instead of shipped audio files: no extra network
 * request, no asset to keep in sync, and severity is expressed by the tone
 * pattern. Every entry point degrades to a silent no-op when the Web Audio API
 * is unavailable or blocked by the browser's autoplay policy.
 */

export interface ChimeTone {
  frequency: number;
  durationMs: number;
  /** Milliseconds after the start of the chime. */
  offsetMs?: number;
  type?: OscillatorType;
}

export const CHIME_PATTERNS: Record<NotificationSeverity, ChimeTone[]> = {
  success: [
    { frequency: 660, durationMs: 110, type: "sine" },
    { frequency: 880, durationMs: 160, offsetMs: 110, type: "sine" },
  ],
  info: [{ frequency: 520, durationMs: 130, type: "sine" }],
  warning: [
    { frequency: 440, durationMs: 140, type: "triangle" },
    { frequency: 440, durationMs: 140, offsetMs: 190, type: "triangle" },
  ],
  critical: [
    { frequency: 880, durationMs: 120, type: "square" },
    { frequency: 660, durationMs: 120, offsetMs: 140, type: "square" },
    { frequency: 880, durationMs: 200, offsetMs: 280, type: "square" },
  ],
};

/** Minimal structural types so tests can pass a fake AudioContext. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

export interface GainNodeLike {
  gain: AudioParamLike;
  connect(destination: unknown): void;
}

export interface OscillatorNodeLike {
  type: OscillatorType;
  frequency: Pick<AudioParamLike, "setValueAtTime">;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  currentTime: number;
  state?: string;
  destination: unknown;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  resume?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export const DEFAULT_CHIME_VOLUME = 0.6;

let sharedContext: AudioContextLike | null = null;
let sharedContextUnavailable = false;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHIME_VOLUME;
  }

  return Math.min(1, Math.max(0, value));
}

type AudioContextConstructor = new () => AudioContextLike;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };

  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export function isAudioSupported(): boolean {
  return getAudioContextConstructor() !== null;
}

/** Lazily created, reused AudioContext (browsers cap how many can exist). */
export function getSharedAudioContext(): AudioContextLike | null {
  if (sharedContext || sharedContextUnavailable) {
    return sharedContext;
  }

  const Constructor = getAudioContextConstructor();

  if (!Constructor) {
    sharedContextUnavailable = true;
    return null;
  }

  try {
    sharedContext = new Constructor();
  } catch {
    // Some browsers throw when constructed without a user gesture.
    sharedContextUnavailable = true;
  }

  return sharedContext;
}

/** Test/teardown hook: forget the memoised context. */
export function resetSharedAudioContext(): void {
  const context = sharedContext;
  sharedContext = null;
  sharedContextUnavailable = false;
  void context?.close?.();
}

export interface PlayChimeOptions {
  volume?: number;
  /** Explicit context (tests); falls back to the shared one. */
  context?: AudioContextLike | null;
  /** Factory used when `context` is not supplied (tests). */
  contextFactory?: () => AudioContextLike | null;
}

/**
 * Play the chime for a severity.
 *
 * Returns whether any tone was scheduled, so callers can distinguish "silent
 * because muted" from "silent because the browser has no audio".
 */
export function playChime(
  severity: NotificationSeverity,
  options: PlayChimeOptions = {},
): boolean {
  const volume = clamp01(options.volume ?? DEFAULT_CHIME_VOLUME);

  if (volume <= 0) {
    return false;
  }

  const context =
    options.context ?? (options.contextFactory ? options.contextFactory() : getSharedAudioContext());

  if (!context) {
    return false;
  }

  const tones = CHIME_PATTERNS[severity] ?? CHIME_PATTERNS.info;

  try {
    if (context.state === "suspended" && context.resume) {
      // Autoplay policy: resume is best-effort, the tones below still queue.
      void Promise.resolve(context.resume()).catch(() => undefined);
    }

    const startAt = context.currentTime;

    for (const tone of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const toneStart = startAt + (tone.offsetMs ?? 0) / 1000;
      const toneEnd = toneStart + tone.durationMs / 1000;

      oscillator.type = tone.type ?? "sine";
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
      // exponentialRamp cannot reach 0, so ramp between tiny values instead.
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(volume, toneStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + 0.02);
    }

    return true;
  } catch {
    // A partially torn-down context must never break notification rendering.
    return false;
  }
}

export interface PlayAlertChimeInput {
  severity: NotificationSeverity;
  eventType?: LifecycleEventType;
  now?: Date;
}

export interface AlertChimeResult {
  decision: AlertDecision;
  played: boolean;
}

/**
 * Apply the alert policy and play the chime in one call.
 *
 * This is the entry point UI code should use: it returns the decision (so a
 * suppression can be explained to the user) and whether audio actually played.
 */
export function playAlertChime(
  preferences: AlertPreferences,
  input: PlayAlertChimeInput,
  options: PlayChimeOptions = {},
): AlertChimeResult {
  const decision = evaluateAlert(preferences, {
    severity: input.severity,
    eventType: input.eventType,
    now: input.now,
  });

  if (!decision.play) {
    return { decision, played: false };
  }

  const played = playChime(input.severity, {
    ...options,
    volume: options.volume ?? preferences.volume,
  });

  return { decision, played };
}
