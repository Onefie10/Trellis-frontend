import { test, expect } from '@playwright/test';

/**
 * Pixel-level visual regression for the marketplace.
 *
 * Baselines live in `e2e/__screenshots__/chromium/` (see `snapshotPathTemplate`
 * in `playwright.config.ts`) and are committed to the repository. Generate or
 * refresh them with:
 *
 *   npm run test:e2e:visual:update
 *
 * Anything that is personalised or time-dependent is masked rather than asserted,
 * so the comparison only fails on layout changes the team actually controls.
 */
test.describe('visual regression — marketplace', () => {
  test('marketplace page matches its baseline', async ({ page }) => {
    await page.goto('/marketplace', { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: /agent marketplace/i })).toBeVisible();

    await expect(page).toHaveScreenshot('marketplace-full.png', {
      fullPage: true,
      // Recommendations are personalised per visitor, so they are excluded.
      mask: [page.locator('section').first()],
    });
  });

  test('agent catalogue grid matches its baseline', async ({ page }) => {
    await page.goto('/marketplace', { waitUntil: 'load' });

    const grid = page.locator('div.grid').first();
    await expect(grid).toBeVisible();
    await grid.scrollIntoViewIfNeeded();

    await expect(grid).toHaveScreenshot('marketplace-grid.png');
  });

  test('landing page matches its baseline', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('body')).toBeVisible();

    await expect(page).toHaveScreenshot('landing-full.png', { fullPage: true });
  });

  test('wallet settings page matches its baseline', async ({ page }) => {
    await page.goto('/settings/wallet', { waitUntil: 'load' });
    await expect(page.locator('body')).toBeVisible();

    await expect(page).toHaveScreenshot('settings-wallet-full.png', { fullPage: true });
  });
});
