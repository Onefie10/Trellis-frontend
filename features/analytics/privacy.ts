export const DEFAULT_EPSILON = 0.5;
export const DEFAULT_DAILY_PRIVACY_BUDGET = 2;
export const MIN_EPSILON = 0.1;
export const MAX_EPSILON = 10;
export const MAX_RELEASED_COUNT = 1_000_000;
export const PRIVACY_AUDIT_STORAGE_KEY = "trellis-analytics-privacy-audit";

export type PrivacyAuditEntry = {
  timestamp: number;
  status: "released" | "budget_exhausted";
  epsilon: number;
  metricGroups: number;
};

export type PrivacyAuditState = {
  day: string;
  spent: number;
  entries: PrivacyAuditEntry[];
};

export type PrivacyAuditSnapshot = PrivacyAuditState & {
  enabled: boolean;
  epsilon: number;
  dailyBudget: number;
  remaining: number;
  mechanism: "Laplace";
};

export type RandomSource = () => number;

function secureRandom(): number {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("A cryptographically secure random source is required for analytics privacy noise");
  }

  const sample = new Uint32Array(1);
  cryptoApi.getRandomValues(sample);
  return sample[0] / 0x1_0000_0000;
}

export function validateEpsilon(epsilon: number): number {
  if (!Number.isFinite(epsilon) || epsilon < MIN_EPSILON || epsilon > MAX_EPSILON) {
    throw new RangeError(`epsilon must be between ${MIN_EPSILON} and ${MAX_EPSILON}`);
  }
  return epsilon;
}

export function validatePrivacyBudget(budget: number): number {
  if (!Number.isFinite(budget) || budget < MIN_EPSILON || budget > MAX_EPSILON) {
    throw new RangeError(`daily privacy budget must be between ${MIN_EPSILON} and ${MAX_EPSILON}`);
  }
  return budget;
}

/** Draws Laplace(0, sensitivity / epsilon) noise using the inverse CDF. */
export function sampleLaplaceNoise(
  epsilon: number,
  sensitivity = 1,
  random: RandomSource = secureRandom,
): number {
  validateEpsilon(epsilon);
  if (!Number.isFinite(sensitivity) || sensitivity <= 0) {
    throw new RangeError("sensitivity must be a finite positive number");
  }

  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError("random source must return a number between 0 and 1");
  }

  // Keep the inverse-CDF input away from the endpoints, where the theoretical
  // Laplace tail is infinite.
  const centered = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, sample)) - 0.5;
  const scale = sensitivity / epsilon;
  return -scale * Math.sign(centered) * Math.log1p(-2 * Math.abs(centered));
}

/** Clamping is post-processing; it does not weaken the DP guarantee. */
export function privatizeCount(
  count: number,
  epsilon: number,
  random: RandomSource = secureRandom,
): number {
  if (!Number.isFinite(count) || count < 0) {
    throw new RangeError("count must be a finite non-negative number");
  }
  const noisy = Math.round(count + sampleLaplaceNoise(epsilon, 1, random));
  return Math.min(MAX_RELEASED_COUNT, Math.max(0, noisy));
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function browserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readPrivacyAuditState(
  now = Date.now(),
  storage = browserStorage(),
): PrivacyAuditState {
  const day = utcDay(now);
  if (!storage) return { day, spent: 0, entries: [] };

  try {
    const raw = storage.getItem(PRIVACY_AUDIT_STORAGE_KEY);
    if (!raw) return { day, spent: 0, entries: [] };
    const parsed = JSON.parse(raw) as PrivacyAuditState;
    if (parsed.day !== day || !Number.isFinite(parsed.spent) || !Array.isArray(parsed.entries)) {
      return { day, spent: 0, entries: [] };
    }
    return { day, spent: Math.max(0, parsed.spent), entries: parsed.entries.slice(-30) };
  } catch {
    return { day, spent: 0, entries: [] };
  }
}

export function writePrivacyAuditState(
  state: PrivacyAuditState,
  storage = browserStorage(),
): void {
  try {
    storage?.setItem(PRIVACY_AUDIT_STORAGE_KEY, JSON.stringify({
      day: state.day,
      spent: state.spent,
      entries: state.entries.slice(-30),
    }));
  } catch {
    // Privacy accounting still functions for this page lifetime when storage is unavailable.
  }
}

export function createPrivacyAuditSnapshot(
  epsilon: number,
  dailyBudget: number,
  enabled = true,
  now = Date.now(),
): PrivacyAuditSnapshot {
  const state = readPrivacyAuditState(now);
  return {
    ...state,
    enabled,
    epsilon,
    dailyBudget,
    remaining: Math.max(0, dailyBudget - state.spent),
    mechanism: "Laplace",
  };
}

export function makeAuditEntry(
  status: PrivacyAuditEntry["status"],
  epsilon: number,
  metricGroups: number,
  timestamp = Date.now(),
): PrivacyAuditEntry {
  return { timestamp, status, epsilon, metricGroups };
}
