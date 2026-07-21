/**
 * playwright.config.ts
 *
 * QA suite for Stage B (onboarding, intro cinematic, Academy waitlist, demo
 * mode, Settings "Replay Setup", master-reset regression). Runs against the
 * REAL local dev server (`node server.js`, see package.json's "dev" script)
 * and the REAL local SQLite files under data/ -- there is no separate test
 * database. That's deliberate: this is a single-user desktop tool, and the
 * things under test (onboarding_seen_v1 / intro_seen_v1 flags in app_meta,
 * the waitlist table, the demo-mode cookie) are exactly the same state a
 * real user's machine carries. Each spec resets only the state it owns via
 * the app's own real API routes (see e2e/helpers.ts) rather than wiping
 * everything, and the one spec that DOES wipe everything (POST /api/reset)
 * runs last (06-master-reset.spec.ts) so it never disturbs an earlier spec.
 *
 * SERIAL BY DESIGN: workers is pinned to 1 and fullyParallel is off. This
 * app's "state" is one shared SQLite file behind one shared dev server --
 * two tests mutating onboarding/intro/demo state at the same time would race
 * each other. Spec files are numbered (01-06) so they also run in a stable,
 * predictable order (master reset last).
 */

import { defineConfig, devices } from 'playwright/test';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Starts the exact same server a developer runs locally. reuseExistingServer
  // is true outside CI so an already-running `npm run dev` on this port is
  // reused instead of failing with EADDRINUSE (see server.js's own handling
  // of that error).
  webServer: {
    command: 'node server.js',
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
