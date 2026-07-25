/**
 * playwright.config.ts
 *
 * QA suite for Stage B (onboarding, intro cinematic, Academy waitlist,
 * placeholder shell, Settings "Replay Setup", master-reset regression). Runs against the
 * REAL local dev server (`node server.js`, see package.json's "dev" script)
 * and an isolated disposable profile under test-results/runtime-profile.
 * The suite exercises the same SQLite/JSON stores and API routes as the app,
 * but it must never mutate the developer's repo-local ./data state. See
 * e2e/start-server.mjs for the isolation boundary.
 *
 * SERIAL BY DESIGN: workers is pinned to 1 and fullyParallel is off. This
 * app's "state" is one shared SQLite file behind one shared dev server --
 * two tests mutating onboarding/intro/demo state at the same time would race
 * each other. Spec files are numbered (00-07) so they also run in a stable,
 * predictable order: 00-warmup FIRST (pre-compiles every dev-mode route so
 * the app's SSE streams + poll burst can't starve Chromium's 6-connection
 * pool while routes cold-compile -- see e2e/00-warmup.spec.ts's header for
 * the full mechanism), master reset LAST.
 */

import { defineConfig, devices } from 'playwright/test';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// BUDGETS ARE SIZED FOR A CONTENDED MACHINE, NOT AN IDLE ONE. This suite
// runs on a real dev box that legitimately also carries a dev server and a
// long-running soak harness (its headless browser alone can pin a core, and
// the box has been observed at 100% CPU during runs). Under that load a
// dev-mode route compile that takes 1-3s idle can take 30s+, and every
// assertion that waits on a round trip inherits that. The old idle-machine
// budgets (10s expect / 15s action / 30s nav) were the single biggest source
// of "pre-existing failures" that had nothing wrong under them — the same
// specs pass with room to spare once budgets fit the environment. These
// numbers change WHEN a run fails, never WHAT is asserted.
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 45_000,
    navigationTimeout: 90_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Starts the exact same server code against an isolated disposable profile.
  // Never reuse an existing server: it might be attached to a developer's
  // real local data, and the master-reset spec is intentionally destructive.
  webServer: {
    command: 'node e2e/start-server.mjs',
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
