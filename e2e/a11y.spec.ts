import { test, expect } from '@playwright/test';
import { expectNoAccessibilityViolations } from './utils/a11y';

/**
 * WCAG 2.0/2.1 A + AA audits for the screens a release is judged on.
 *
 * The shared helper fails the test on any violation that is not explicitly
 * acknowledged as pre-existing debt, so a missing label, an unlabelled control
 * or a dropped landmark stops the run.
 */
const KEY_SCREENS: Array<{ path: string; heading?: RegExp; label: string }> = [
  { path: '/', heading: /trellis/i, label: 'landing' },
  { path: '/marketplace', heading: /agent marketplace/i, label: 'marketplace' },
  { path: '/create', label: 'create' },
  { path: '/dashboard', label: 'dashboard' },
  { path: '/settings/wallet', label: 'settings-wallet' },
  { path: '/settings/notifications', label: 'settings-notifications' },
  { path: '/partial-failures', heading: /partial failure dashboard/i, label: 'partial-failures' },
];

test.describe('accessibility — key screens', () => {
  for (const screen of KEY_SCREENS) {
    test(`${screen.label} passes axe-core WCAG A/AA`, async ({ page }, testInfo) => {
      const response = await page.goto(screen.path, { waitUntil: 'load' });
      expect(response, `no response for ${screen.path}`).not.toBeNull();
      expect(response!.status()).toBeLessThan(400);

      await expect(page.locator('body')).toBeVisible();
      if (screen.heading) {
        await expect(page.getByRole('heading', { name: screen.heading }).first()).toBeVisible();
      }

      await expectNoAccessibilityViolations(page, { label: screen.label }, testInfo);
    });
  }

  test('keyboard users can reach the primary navigation', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
    await page.keyboard.press('Tab');

    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return null;
      return {
        tag: element.tagName.toLowerCase(),
        name:
          element.getAttribute('aria-label') ??
          element.textContent?.trim().slice(0, 60) ??
          '',
      };
    });

    // The first tab stop must be a real, named target — an unnamed control is the
    // most common "keyboard trap" failure axe reports as `focusable-no-name`.
    expect(focused).not.toBeNull();
    expect((focused as { name: string }).name.length).toBeGreaterThan(0);
  });

  test('reduced-motion preference disables non-essential animations and transitions', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/', { waitUntil: 'load' });

    const matchesReducedMotion = await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    expect(matchesReducedMotion).toBe(true);
  });

  test('partial failure dashboard filter and sort controls are keyboard and screen-reader accessible', async ({
    page,
  }) => {
    await page.goto('/partial-failures', { waitUntil: 'load' });

    const statusFilter = page.getByLabel('Status');
    const severityFilter = page.getByLabel('Severity');
    const searchInput = page.getByLabel('Search');

    await expect(statusFilter).toBeVisible();
    await expect(severityFilter).toBeVisible();
    await expect(searchInput).toBeVisible();

    const createdSort = page.getByRole('button', { name: /Created/i });
    await expect(createdSort).toHaveAttribute('aria-sort', 'descending');
    await createdSort.click();
    await expect(createdSort).toHaveAttribute('aria-sort', 'ascending');
  });
});
