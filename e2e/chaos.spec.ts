import { test, expect } from '@playwright/test';
import { enableNetworkChaos, expectNoCrash, trackUncaughtErrors } from './utils/chaos';

/**
 * Deterministic chaos suite.
 *
 * All faults are seeded and all waits are driven by explicit conditions
 * (visible text, roles, or intercepted-request counters) rather than wall
 * clock sleeps, so runs are repeatable across machines and CI shards.
 *
 * Operational edge cases covered:
 *  - high latency: loading state must render before content resolves
 *  - HTTP 5xx: error alert with a retry affordance that recovers
 *  - dropped packets: transport failure surfaces as a retryable error
 *  - stale reads: a retry after recovery must not serve a cached failure
 *  - restarts: reloading mid-flight must not crash or blank the page
 *
 * Failure modes / recovery:
 *  - If a route renders a blank page or throws, expectNoCrash fails the test.
 *  - If chaos injection leaks past a test, the fixture disables it on teardown.
 *  - Rollback: remove this spec (and e2e/utils/chaos.ts) to restore prior CI.
 *
 * Replay a failing randomised run with CHAOS_SEED=&lt;seed&gt;.
 */

const BOG_REPORTS_API = /\/api\/bug-reports/;
const OPERATIONS_API = /\/api\/operational-health/;

test.describe('network chaos: targeted scenarios', () => {
  test('high latency shows the loading state, then the content', async ({ page }) => {
    const uncaught = trackUncaughtErrors(page);
    const chaos = await enableNetworkChaos(page, { urlPattern: BOG_REPORTS_API, latencyMs: [2500, 3000], seed: 1 });

    await page.goto('/bug-reports', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Loading bug reports...')).toBeVisible();
    await expect(page.getByRole('heading', { name: /bug reports dashboard/i })).toBeVisible({ timeout: 15_000 });

    expect(chaos.stats.totalDelayMs).toBeGreaterThanOrEqual(2500);
    await expectNoCrash(page, uncaught, '/bug-reports under latency');
  });

  test('HTTP 5xx shows an error with a retry button that recovers', async ({ page }) => {
    const uncaught = trackUncaughtErrors(page);
    const chaos = await enableNetworkChaos(page, {
      urlPattern: BOG_REPORTS_API,
      latencyMs: [500, 800],
      errorRate: 1,
      seed: 2,
    });

    await page.goto('/bug-reports', { waitUntil: 'domcontentloaded' });
    const alert = page.getByRole('alert').filter({ hasText: /error loading reports/i });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    expect(chaos.stats.failed).toBeGreaterThan(0);
    await expectNoCrash(page, uncaught, '/bug-reports under 5xx');

    await chaos.disable();
    await alert.getBuRole('button', { name: /retry/i }).click();
    await expect(page.getByRole('heading', { name: /bug reports dashboard/i })).toBeVisible({ timeout: 15_000 });
    // Stale-read guard: the recovered render must not replay the cached 5xx.
    await expect(alert).toBeHidden();
    await expectNoCrash(page, uncaught, '/bug-reports after retry');
  });

  test('dropped packets show an error with a retry button that recovers', async ({ page }) => {
    const uncaught = trackUncaughtErrors(page);
    const chaos = await enableNetworkChaos(page, { urlPattern: OPERATIONS_API, dropRate: 1, seed: 3 });

    await page.goto('/dashboard/operations', { waitUntil: 'domcontentloaded' });
    const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: /retry/i }) });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    expect(chaos.stats.dropped).toBeGreaterThan(0);
    await expectNoCrash(page, uncaught, '/dashboard/operations with dropped packets');

    await chaos.disable();
    await alert.getByRole('button', { name: /retry/i }).click();
    await expect(page.getByText('Unresolved exceptions')).toBeVisible({ timeout: 15_000 });
    await expect(alert).toBeHidden();
    await expectNoCrash(page, uncaught, '/dashboard/operations after retry');
  });

  test('reload mid-flight (restart) does not crash or blank the page', async ({ page }) => {
    const uncaught = trackUncaughtErrors(page);
    const chaos = await enableNetworkChaos(page, { urlPattern: BOG_REPORTS_API, latencyMs: [1500, 2500], seed: 5 });

    await page.goto('/bug-reports', { waitUntil: 'domcontentloaded' });
    // Restart the document while the delayed API request is still in flight.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /bug reports dashboard/i })).toBeVisible({ timeout: 15_000 });
    expect(chaos.stats.intercepted).toBeGreaterThan(0);
    await expectNoCrash(page, uncaught, '/bug-reports after mid-flight reload');
  });

  test('slow operations API shows the loading state', async ({ page }) => {
    const uncaught = trackUncaughtErrors(page);
    await enableNetworkChaos(page, { urlPattern: OPERATIONS_API, latencyMs: [2000, 3000], seed: 4 });

    await page.goto('/dashboard/operations', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Loading operational health...')).toBeVisible();
    await expect(page.getByText('Unresolved exceptions')).toBeVisible({ timeout: 15_000 });
    await expectNoCrash(page, uncaught, '/dashboard/operations under latency');
  });
});

/**
 * Randomised sweep: every data-driven route under mixed latency, 5xx and
 * packet loss. The only requirement is survival — a handled error state or
 * the route error boundary is fine; an unhandled crash or blank page is not.
 */
const CHAOS_ROUTES = [
  '/',
  '/bug-reports',
  '/dashboard',
  '/dashboard/operations',
  '/governance',
  '/marketplace',
  '/security',
  '/waitlist',
];

test.describe('network chaos: randomised route sweep', () => {
  const baseSeed = Number(process.env.CHAOS_SEED ?? 20260929);

  CHAOS_ROUTES.forEach((route, index) => {
    const seed = baseSeed + index;

    test(`${route} survives latency, 5xx and packet loss (seed ${seed})`, async ({ page }) => {
      test.setTimeout(60_000);
      const uncaught = trackUncaughtErrors(page);
      const chaos = await enableNetworkChaos(page, {
        latencyMs: [500, 3000],
        errorRate: 0.4,
        dropRate: 0.1,
        seed,
      });

      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response?.status() ?? 0, `${route} document request`).toBeLessThan(500);

      // Deterministic settle: wait for the document to finish loading, then
      // for the chaos layer to report no in-flight intercepted requests.
      await page.waitForLoadState('load', { timeout: 25_000 }).catch(() => undefined);
      await expect
        .poll(() => chaos.stats.inFlight, { timeout: 25_000, message: `${route} in-flight requests` })
        .toBe(0);

      test.info().annotations.push({
        type: 'chaos',
        description: `seed=${chaos.seed} intercepted=${chaos.stats.intercepted} failed=${chaos.stats.failed} dropped=${chaos.stats.dropped}`,
      });
      await expectNoCrash(page, uncaught, `${route} under chaos`);
    });
  });
});
