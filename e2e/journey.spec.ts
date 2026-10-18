import { test, expect } from '@playwright/test';
import { expectNoAccessibilityViolations } from './utils/a11y';

const VALID_WALLET_ADDRESS =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const WALLET_TYPE_KEY = 'stellar_wallet_type';
const WALLET_ADDRESS_KEY = 'stellar_wallet_address';

test.describe('main user journey', () => {
  test('connect wallet state → browse marketplace → open an agent', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      ([address, typeKey, addressKey, walletType]) => {
        window.localStorage.setItem(addressKey, address as string);
        window.localStorage.setItem(typeKey, walletType as string);
        window.localStorage.setItem(
          'stellar_network',
          'TESTNET',
        );
      },
      [
        VALID_WALLET_ADDRESS,
        WALLET_TYPE_KEY,
        WALLET_ADDRESS_KEY,
        'freighter',
      ] as const,
    );

    await page.goto('/', { waitUntil: 'load' });
    await expect(
      page.getByRole('link', { name: /explore marketplace/i }),
    ).toBeVisible();

    // Key workflow screen 1: the connected landing page.
    await expectNoAccessibilityViolations(page, { label: 'landing' }, testInfo);

    await page.getByRole('link', { name: /explore marketplace/i }).click();
    await expect(page).toHaveURL(/\/marketplace/);
    await expect(
      page.getByRole('heading', { name: /agent marketplace/i }),
    ).toBeVisible();

    await expect(page.getByText('DataBot Pro').first()).toBeVisible();

    // Key workflow screen 2: the catalogue the journey has just browsed.
    await expectNoAccessibilityViolations(page, { label: 'marketplace' }, testInfo);

    await page
      .getByRole('button', { name: /view agent/i })
      .first()
      .click();

    await expect(page.getByText('DataBot Pro').first()).toBeVisible();
  });
});
