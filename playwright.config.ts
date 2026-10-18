import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT || '3000';
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT}`;

/**
 * Viewports every page is expected to hold its layout at.
 * Kept in sync with `tailwind.config.cjs` (sm 600 / md 900 / lg 1200) and with
 * `e2e/viewport.spec.ts`, which asserts the layout at each of these sizes.
 */
export const VIEWPORTS = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
} as const;

/** Layout assertions belong to the viewport projects only. */
const LAYOUT_SPEC = /viewport\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : 'list',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    /**
     * Visual regression defaults.
     *
     * `threshold` is the per-pixel colour tolerance (anti-aliasing differs
     * slightly between GPU/CPU rasterisers) and `maxDiffPixelRatio` caps how much
     * of the image may differ before the comparison fails — a drifted layout
     * moves far more than 2% of the pixels, while sub-pixel font hinting noise
     * stays underneath it.
     */
    toHaveScreenshot: {
      threshold: 0.2,
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  // One canonical location for baselines: e2e/__screenshots__/<project>/...
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // A fixed viewport keeps visual comparisons stable across runners.
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    // ── Engine matrix: the functional flows on every engine we support. ──────
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run start',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
