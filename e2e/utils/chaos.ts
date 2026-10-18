import { expect, type Page, type Route } from '@playwright/test';

/**
 * Network chaos for Playwright.
 *
 * `enableNetworkChaos` intercepts matching requests and, per request, adds a
 * random delay, answers with a random HTTP 5xx, or drops the request as if the
 * packet was lost. Randomness comes from a seeded PRNG so a failing run can be
 * replayed exactly by reusing the seed printed in the test title/attachment.
 */

export interface ChaosOptions {
  /** Requests to intercept. Defaults to the app's own API routes. */
  urlPattern: string | RegExp;
  /** Inclusive delay range in ms applied before every intercepted request. */
  latencyMs?: readonly [number, number];
  /** Probability (0-1) that a request is answered with a 5xx instead. */
  errorRate?: number;
  /** Status codes to choose from for injected failures. */
  errorStatuses?: readonly number[];
  /** Probability (0-1) that a request is aborted as a dropped packet. */
  dropRate?: number;
  /** PRNG seed; the same seed yields the same sequence of faults. */
  seed?: number;
}

export interface ChaosStats {
  intercepted: number;
  failed: number;
  dropped: number;
  passedThrough: number;
  totalDelayMs: number;
}

export interface ChaosController {
  readonly seed: number;
  readonly stats: ChaosStats;
  /** Stops injecting faults; later requests reach the server untouched. */
  disable(): Promise<void>;
}

export const DEFAULT_CHAOS_PATTERN = /\/api\//;
export const DEFAULT_ERROR_STATUSES: readonly number[] = [500, 502, 503, 504];

/** mulberry32 — tiny, fast, good enough for fault injection. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function enableNetworkChaos(page: Page, options: ChaosOptions = {}): Promise<ChaosController> {
  const {
    urlPattern = DEFAULT_CHAOS_PATTERN,
    latencyMs = [0, 0],
    errorRate = 0,
    errorStatuses = DEFAULT_ERROR_STATUSES as readonly number[],
    dropRate = 0,
    seed = Number(process.env.CHAOS_SEED ?? Date.now() % 1_000_000),
  } = options;

  const [minDelay, maxDelay] = latencyMs;
  const random = createSeededRandom(seed);
  const stats: ChaosStats = { intercepted: 0, failed: 0, dropped: 0, passedThrough: 0, totalDelayMs: 0 };
  let active = true;

  const handler = async (route: Route) => {
    if (!active) {
      await route.continue();
      return;
    }
    stats.intercepted += 1;

    const delay = Math.round(minDelay + random() * Math.max(0, maxDelay - minDelay));
    if (delay > 0) {
      stats.totalDelayMs += delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const roll = random();
    try {
      if (roll < dropRate) {
        stats.dropped += 1;
        await route.abort('connectionreset');
        return;
      }
      if (roll < dropRate + errorRate) {
        stats.failed += 1;
        const status = errorStatuses[Math.floor(random() * errorStatuses.length)] ?? 500;
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'chaos: injected failure', status }),
        });
        return;
      }
      stats.passedThrough += 1;
      await route.continue();
    } catch {
      // The page navigated away while this request was held; nothing to do.
    }
  };

  await page.route(urlPattern, handler);

  return {
    seed,
    stats,
    async disable() {
      active = false;
      await page.unroute(urlPattern, handler);
    },
  };
}

/** Text Next.js renders when an error escapes every React error boundary. */
export const UNHANDLED_CRASH_TEXT = /Application error: a (client|server)-side exception has occurred/i;

/**
 * Collects uncaught exceptions (`pageerror`) for the lifetime of the page.
 * Console errors are deliberately not collected: a failed fetch logging to the
 * console is the expected, handled outcome of injected chaos.
 */
export function trackUncaughtErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * Asserts the page survived: no unhandled crash screen, no blank body, and no
 * uncaught exception. An in-app fallback (skeleton, error card, route error
 * boundary) all count as surviving.
 */
export async function expectNoCrash(page: Page, uncaughtErrors: readonly string[], label: string): Promise<void> {
  await expect(page.getByText(UNHANDLED_CRASH_TEXT), `${label}: unhandled crash screen`).toHaveCount(0);
  const text = (await page.locator('body').innerText()).trim();
  expect(text.length, `${label}: blank screen`).toBeGreaterThan(0);
  expect(uncaughtErrors, `${label}: uncaught exceptions: ${uncaughtErrors.join(' | ')}`).toEqual([]);
}
