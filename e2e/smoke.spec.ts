import { test, expect, Page } from '@playwright/test';

const ROUTES = [
  '/',
  '/analytics',
  '/bug-report',
  '/bug-reports',
  '/create',
  '/dashboard',
  '/dashboard/referrals',
  '/governance',
  '/learn',
  '/marketplace',
  '/portfolio',
  '/provenance',
  '/security',
  '/settings/notifications',
  '/settings/wallet',
  '/simulations',
  '/staking',
  '/submissions',
  '/telemetry',
  '/testing',
  '/trading',
  '/waitlist',
];

const IGNORED_CONSOLE_PATTERNS = [
  /favicon/i,
  /Download the React DevTools/i,
  /service worker/i,
  /SW registration/i,
  /Manifest/i,
  /apple-touch-icon/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /net::ERR/i,
];

/**
 * Every route is smoke tested on the desktop engines. The touch/mobile projects
 * run the subset that matters on a phone - loading all 22 routes five times
 * would dominate CI without adding much, since rendering differences in the
 * shared layout are covered by `viewport.spec.ts` instead.
 */
const MOBILE_ROUTE_SUBSET = [
  '/',
  '/marketplace',
  '/learn',
  '/governance',
  '/bug-report',
  '/dashboard',
];

function isIgnoredError(message: string): boolean {
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(message));
}

async function collectPageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (!isIgnoredError(text)) {
        errors.push(text);
      }
    }
  });
  return errors;
}

test.describe('route smoke tests', () => {
  for (const route of ROUTES) {
    test(`${route} renders without crashing`, async ({ page }, testInfo) => {
      const isTouchProject = testInfo.project.use.hasTouch === true;

      test.skip(
        isTouchProject && !MOBILE_ROUTE_SUBSET.includes(route),
        `touch projects smoke test ${MOBILE_ROUTE_SUBSET.length} of ${ROUTES.length} routes`,
      );

      const errors = await collectPageErrors(page);
      const response = await page.goto(route, { waitUntil: 'load' });

      expect(response, `no response for ${route}`).not.toBeNull();
      expect(
        response!.status(),
        `${route} returned HTTP ${response!.status()}`,
      ).toBeLessThan(400);

      await expect(page.locator('body')).toBeVisible();
      expect(errors, `console/page errors on ${route}: ${errors.join(' | ')}`).toEqual([]);
    });
  }
});

test.describe('modal and drawer focus trap keyboard navigation', () => {
  test('navigation drawer traps Tab keyboard focus and returns focus on close', async ({ page, isMobile }) => {
    // Open on mobile viewport or when menu button is visible
    if (!isMobile) {
      await page.setViewportSize({ width: 375, height: 667 });
    }

    await page.goto('/', { waitUntil: 'load' });

    const menuButton = page.getByRole('button', { name: /menu/i });
    await expect(menuButton).toBeVisible();

    // Focus and open drawer with keyboard
    await menuButton.focus();
    await page.keyboard.press('Enter');

    const drawer = page.getByRole('dialog', { name: /navigation drawer/i });
    await expect(drawer).toBeVisible();

    // Verify initial focus is within the drawer
    const isFocusInsideInitially = await drawer.evaluate((node) => {
      return node.contains(document.activeElement);
    });
    expect(isFocusInsideInitially).toBe(true);

    // Tab through elements and verify focus never escapes the drawer
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const inside = await drawer.evaluate((node) => {
        return node.contains(document.activeElement);
      });
      expect(inside, `Tab focus escaped drawer on step ${i}`).toBe(true);
    }

    // Shift+Tab backward and verify focus stays inside
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      const inside = await drawer.evaluate((node) => {
        return node.contains(document.activeElement);
      });
      expect(inside, `Shift+Tab focus escaped drawer on step ${i}`).toBe(true);
    }

    // Escape closes drawer and restores focus to menu trigger button
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();

    const isMenuButtonFocused = await menuButton.evaluate((node) => {
      return document.activeElement === node;
    });
    expect(isMenuButtonFocused).toBe(true);
  });

  test('modal dialog traps Tab navigation and restores triggering element focus on close', async ({ page }) => {
    await page.goto('/governance', { waitUntil: 'load' });

    // Look for proposal or modal trigger button
    const openModalTrigger = page.locator('button, [role="button"]').filter({ hasText: /View Proposal|Vote|Details/i }).first();
    const triggerExists = await openModalTrigger.count() > 0;

    if (triggerExists && await openModalTrigger.isVisible()) {
      await openModalTrigger.focus();
      await page.keyboard.press('Enter');

      const dialog = page.getByRole('dialog').first();
      await expect(dialog).toBeVisible();

      // Ensure focus is trapped
      const isInside = await dialog.evaluate((node) => node.contains(document.activeElement));
      expect(isInside).toBe(true);

      // Tab navigation cycles inside modal
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const inside = await dialog.evaluate((node) => node.contains(document.activeElement));
        expect(inside).toBe(true);
      }

      // Close modal with Escape
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();

      // Trigger focus restored
      const isTriggerFocused = await openModalTrigger.evaluate((node) => document.activeElement === node);
      expect(isTriggerFocused).toBe(true);
    }
  });
});

