import { test, expect } from '@playwright/test';
import {
  activate,
  assertNoHorizontalOverflow,
  countColumns,
  expectedMarketplaceColumns,
  openNavigationIfNeeded,
  renderedHeight,
  viewportSize,
} from './utils/layout';

/**
 * Layout matrix: these assertions run once per size in the `viewport-*`
 * projects (375x667, 768x1024, 1440x900) and never in the engine projects,
 * which cover behaviour instead.
 */
test.describe('viewport layout matrix', () => {
  test('pages fit the viewport without horizontal scrolling', async ({ page }) => {
    for (const path of ['/', '/marketplace', '/learn', '/governance']) {
      await page.goto(path, { waitUntil: 'load' });
      await expect(page.locator('body')).toBeVisible();

      await assertNoHorizontalOverflow(page, path);
    }
  });

  test('marketplace agent grid adapts its column count to the viewport', async ({ page }) => {
    await page.goto('/marketplace', { waitUntil: 'load' });

    const cards = page.getByRole('button', { name: /view agent/i });
    await expect(cards.first()).toBeVisible();

    const { width } = viewportSize();
    const expected = expectedMarketplaceColumns(width);
    const actual = await countColumns(cards);

    expect(
      actual,
      `expected ${expected} marketplace column(s) at ${width}px, saw ${actual}`,
    ).toBe(expected);
  });

  test('primary marketplace action is reachable at every viewport', async ({ page }) => {
    await page.goto('/marketplace', { waitUntil: 'load' });

    const cards = page.getByRole('button', { name: /view agent/i });
    await expect(cards.first()).toBeVisible();

    const firstCard = cards.first();
    await firstCard.scrollIntoViewIfNeeded();

    // Comfortable target for a finger: 40px is the practical floor, Material
    // and Apple both recommend ~44px.
    expect(await renderedHeight(firstCard)).toBeGreaterThanOrEqual(40);

    // Activating must work with the input model of the current project: touch
    // on the mobile/tablet projects, pointer elsewhere.
    await activate(firstCard);

    await expect(firstCard).toBeVisible();
  });

  test('navigation is reachable: inline menu on desktop, drawer below md', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });

    const drawerOpened = await openNavigationIfNeeded(page, 'Marketplace');
    const { width } = viewportSize();

    if (width >= 900) {
      expect(drawerOpened, 'desktop should use the inline menu').toBe(false);
    } else {
      expect(drawerOpened, `drawer should be available at ${width}px`).toBe(true);
    }

    const marketplaceLink = page.getByRole('link', { name: 'Marketplace' });
    await expect(marketplaceLink).toHaveCount(1);
    await expect(marketplaceLink).toBeVisible();

    await activate(marketplaceLink);

    await expect(page).toHaveURL(/\/marketplace/);
    await expect(page.getByRole('heading', { name: /agent marketplace/i })).toBeVisible();
  });

  test('marketplace sort control renders consistently across viewports', async ({ page }) => {
    await page.goto('/marketplace', { waitUntil: 'load' });

    const sort = page.getByLabel('Sort agents');
    await expect(sort).toBeVisible();

    // Native select chrome differs per engine; the control opts out of it and
    // draws its own indicator so the rendering is identical everywhere.
    const appearance = await sort.evaluate((element) => getComputedStyle(element).appearance);

    expect(appearance).toBe('none');
    expect(await renderedHeight(sort)).toBeGreaterThanOrEqual(40);

    // Custom indicator (no engine-provided arrow to rely on).
    await expect(sort.locator('xpath=following-sibling::span[@aria-hidden="true"]')).toBeVisible();

    // Still a real select: choosing an option updates its value.
    await sort.selectOption('Newest');
    await expect(sort).toHaveValue('Newest');
  });
});
