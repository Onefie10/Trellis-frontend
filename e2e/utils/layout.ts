import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Shared helpers for the cross-browser / cross-viewport matrix.
 *
 * Two behaviours cause most of the drift between engines and viewports and are
 * therefore centralised here instead of being re-implemented per spec:
 *
 * * **Activation** — a touch context answers `tap()`, a pointer context answers
 *   `click()`. Engine-specific input handling only shows up when the wrong one
 *   is used.
 * * **Navigation** — below the `md` breakpoint (900px, see `Navigation.tsx`)
 *   the header links live in a MUI drawer behind an `aria-label="menu"` button,
 *   so a plain `getByRole('link')` click is unavailable on mobile and tablet.
 */

/** True when the current project emulates a touch device. */
export function isTouchProject(): boolean {
  return test.info().project.use.hasTouch === true;
}

export function viewportSize(): { width: number; height: number } {
  return test.info().project.use.viewport ?? { width: 1280, height: 720 };
}

export function projectName(): string {
  return test.info().project.name;
}

/** Activate a control the way the current project's input model does. */
export async function activate(locator: Locator): Promise<void> {
  if (isTouchProject()) {
    await locator.tap();
    return;
  }

  await locator.click();
}

/**
 * Open the header drawer when the inline menu is not available, then wait for
 * `linkName` to be reachable. Returns whether the drawer had to be opened.
 */
export async function openNavigationIfNeeded(page: Page, linkName: string): Promise<boolean> {
  const menuButton = page.getByRole('button', { name: 'menu' });

  if (!(await menuButton.isVisible())) {
    return false;
  }

  await activate(menuButton);

  // The drawer is the only place these links exist below the md breakpoint, so
  // their visibility doubles as the "drawer is open" signal.
  await expect(page.getByRole('link', { name: linkName })).toBeVisible();

  return true;
}

/**
 * Column count of a card grid, derived from the rendered positions of its
 * cards — the same thing a user sees, and independent of the markup used to
 * express the grid.
 */
export async function countColumns(cards: Locator): Promise<number> {
  const boxes = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect()),
  );

  const offsets = boxes.map((box) => Math.round(box.x / 2) * 2);

  return new Set(offsets).size;
}

/**
 * Expected marketplace column count for a viewport width, following
 * `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` (sm = 600px, lg = 1200px).
 */
export function expectedMarketplaceColumns(width: number): number {
  if (width >= 1200) {
    return 3;
  }

  if (width >= 600) {
    return 2;
  }

  return 1;
}

/**
 * No element may stick out horizontally: a page that scrolls sideways is broken
 * on every device, and the decorative blurred glows are the usual culprit.
 */
export async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const { overflow, offenders } = await page.evaluate(() => {
    const doc = document.documentElement;
    const limit = window.innerWidth + 2;

    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((element) => element.getBoundingClientRect().right > limit)
        .slice(0, 5)
        .map((element) => {
          const className =
            typeof element.className === 'string' ? element.className : '';
          return `${element.tagName.toLowerCase()}.${className.trim().slice(0, 80)}`;
        }),
    };
  });

  expect(
    overflow,
    `horizontal overflow of ${overflow}px on ${label}${offenders.length ? ` — past the viewport: ${offenders.join(', ')}` : ''}`,
  ).toBeLessThanOrEqual(2);
}

/** Rendered height of a control, used for touch-target assertions. */
export async function renderedHeight(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();

  expect(box, 'element has no layout box').not.toBeNull();

  return box?.height ?? 0;
}
