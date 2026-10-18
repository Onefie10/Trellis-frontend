export const FEATURE_FLAGS = {
  stableBugReportPagination: {
    env: "TRELLIS_FEATURE_STABLE_BUG_REPORT_PAGINATION",
    defaultValue: true,
  },
  securityReportExport: {
    env: "TRELLIS_FEATURE_SECURITY_REPORT_EXPORT",
    defaultValue: false,
  },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export interface RemoteFeatureFlagConfig {
  enabled: boolean;
  rolloutPercentage?: number;
}

export type RemoteFeatureFlags = Partial<
  Record<FeatureFlag, boolean | RemoteFeatureFlagConfig>
>;

interface NormalizedFeatureFlagConfig {
  enabled: boolean;
  rolloutPercentage?: number;
}

export interface FeatureFlagPollingOptions {
  url?: string;
  intervalMs?: number;
  fetcher?: typeof fetch;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

const OVERRIDE_STORAGE_PREFIX = "trellis.feature-flags.override.";
const FEATURE_FLAG_POLL_INTERVAL_MS = 30_000;
const featureFlagListeners = new Set<() => void>();
let remoteFeatureFlags: Partial<
  Record<FeatureFlag, NormalizedFeatureFlagConfig>
> = {};
let stopActivePolling: (() => void) | undefined;
let storageListenerRegistered = false;

function notifyFeatureFlagListeners(): void {
  for (const listener of featureFlagListeners) listener();
}

function normalizeConfig(
  config: boolean | RemoteFeatureFlagConfig,
): NormalizedFeatureFlagConfig | undefined {
  if (typeof config === "boolean") return { enabled: config };
  if (typeof config !== "object" || config === null) return undefined;
  if (typeof config.enabled !== "boolean") return undefined;

  if (
    config.rolloutPercentage !== undefined &&
    (typeof config.rolloutPercentage !== "number" ||
      !Number.isFinite(config.rolloutPercentage) ||
      config.rolloutPercentage < 0 ||
      config.rolloutPercentage > 100)
  ) {
    return undefined;
  }

  return {
    enabled: config.enabled,
    ...(config.rolloutPercentage === undefined
      ? {}
      : { rolloutPercentage: config.rolloutPercentage }),
  };
}

function encodeUtf8(value: string): number[] {
  const bytes: number[] = [];

  for (const character of value) {
    let codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return bytes;
}

function murmurHash3(value: string): number {
  const bytes = encodeUtf8(value);
  const blockCount = Math.floor(bytes.length / 4);
  let hash = 0;

  for (let block = 0; block < blockCount; block += 1) {
    const offset = block * 4;
    let key =
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24);

    key = Math.imul(key, 0xcc9e2d51);
    key = (key << 15) | (key >>> 17);
    key = Math.imul(key, 0x1b873593);
    hash ^= key;
    hash = (hash << 13) | (hash >>> 19);
    hash = Math.imul(hash, 5) + 0xe6546b64;
  }

  const tailOffset = blockCount * 4;
  const remainingBytes = bytes.length & 3;
  let tail = 0;
  if (remainingBytes >= 3) tail ^= bytes[tailOffset + 2] << 16;
  if (remainingBytes >= 2) tail ^= bytes[tailOffset + 1] << 8;
  if (remainingBytes >= 1) {
    tail ^= bytes[tailOffset];
    tail = Math.imul(tail, 0xcc9e2d51);
    tail = (tail << 15) | (tail >>> 17);
    tail = Math.imul(tail, 0x1b873593);
    hash ^= tail;
  }

  hash ^= bytes.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function getStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function getFeatureFlagOverride(flag: FeatureFlag): boolean | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(`${OVERRIDE_STORAGE_PREFIX}${flag}`);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    return null;
  }
  return null;
}

export function setFeatureFlagOverride(
  flag: FeatureFlag,
  enabled: boolean | null,
): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    const key = `${OVERRIDE_STORAGE_PREFIX}${flag}`;
    if (enabled === null) storage.removeItem(key);
    else storage.setItem(key, String(enabled));
  } catch {
    return;
  }
  notifyFeatureFlagListeners();
}

export function subscribeToFeatureFlagChanges(
  listener: () => void,
): () => void {
  featureFlagListeners.add(listener);

  if (typeof window !== "undefined" && !storageListenerRegistered) {
    window.addEventListener("storage", (event) => {
      if (
        event.key === null ||
        event.key.startsWith(OVERRIDE_STORAGE_PREFIX)
      ) {
        notifyFeatureFlagListeners();
      }
    });
    storageListenerRegistered = true;
  }

  return () => featureFlagListeners.delete(listener);
}

export function updateRemoteFeatureFlags(
  configuration: RemoteFeatureFlags,
): void {
  const updatedFlags: Partial<
    Record<FeatureFlag, NormalizedFeatureFlagConfig>
  > = {};

  for (const flag of Object.keys(FEATURE_FLAGS) as FeatureFlag[]) {
    const value = configuration[flag];
    if (value === undefined) continue;
    const normalized = normalizeConfig(value);
    if (normalized) updatedFlags[flag] = normalized;
  }

  if (JSON.stringify(updatedFlags) === JSON.stringify(remoteFeatureFlags)) return;
  remoteFeatureFlags = updatedFlags;
  notifyFeatureFlagListeners();
}

function getConfiguredPollingUrl(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_TRELLIS_FEATURE_FLAGS_URL ||
    process.env.TRELLIS_FEATURE_FLAGS_URL
  );
}

export function startFeatureFlagPolling(
  options: FeatureFlagPollingOptions = {},
): () => void {
  if (stopActivePolling) return stopActivePolling;

  const url = options.url ?? getConfiguredPollingUrl();
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (!url || typeof fetcher !== "function") return () => undefined;

  const controller = new AbortController();
  let isRunning = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    isRunning = false;
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    if (stopActivePolling === stop) stopActivePolling = undefined;
  };
  stopActivePolling = stop;

  const poll = async () => {
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (
          typeof payload === "object" &&
          payload !== null &&
          "flags" in payload &&
          typeof payload.flags === "object" &&
          payload.flags !== null
        ) {
          updateRemoteFeatureFlags(payload.flags as RemoteFeatureFlags);
        }
      }
    } catch {
      // Keep the last known configuration and retry on the next interval.
    } finally {
      if (isRunning) {
        timer = setTimeout(
          () => void poll(),
          options.intervalMs ?? FEATURE_FLAG_POLL_INTERVAL_MS,
        );
        (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      }
    }
  };

  void poll();
  return stop;
}

export function isFeatureEnabled(
  flag: FeatureFlag,
  environment: NodeJS.ProcessEnv = process.env,
  userId?: string,
): boolean {
  if (getConfiguredPollingUrl()) startFeatureFlagPolling();

  const override = getFeatureFlagOverride(flag);
  if (override !== null) return override;

  const definition = FEATURE_FLAGS[flag];
  const config =
    remoteFeatureFlags[flag] ??
    normalizeConfig(parseBoolean(environment[definition.env], definition.defaultValue));
  if (!config?.enabled) return false;
  if (config.rolloutPercentage === undefined) return true;
  if (userId === undefined || userId.length === 0) return false;

  return (murmurHash3(userId) / 0x1_0000_0000) * 100 < config.rolloutPercentage;
}

export function getFeatureFlags(
  environment: NodeJS.ProcessEnv = process.env,
  userId?: string,
): Record<FeatureFlag, boolean> {
  return {
    stableBugReportPagination: isFeatureEnabled("stableBugReportPagination", environment, userId),
    securityReportExport: isFeatureEnabled("securityReportExport", environment, userId),
  };
}
