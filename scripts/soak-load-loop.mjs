/**
 * soak-load-loop — the browser half of the soak test (see soak-monitor.mjs
 * for the process/memory half).
 *
 * An idle server alone barely exercises anything: no SSE reconnects, no
 * WebGL context creation/teardown, no PTY spawn/kill churn. This module
 * drives a single real Chromium page against the running Blubber server and
 * repeatedly cycles through every nav screen (each one mounts/unmounts its
 * own <Flubber3D> WebGL canvas — see src/components/Flubber3D.tsx — and
 * several screens independently open their own /api/live SSE connection via
 * useLiveUsage(), see src/hooks/useLiveUsage.ts), plus opens and closes a
 * couple of real terminal tabs each cycle (src/components/TabBar.tsx),
 * which spawns and kills a real `claude` PTY process per tab
 * (src/server/pty-manager.ts) — exactly the spawn/kill cycle a leak in
 * that module would show up under.
 *
 * Deliberately NOT a Playwright test file (no `test()`/`expect()`, no
 * playwright.config.ts wiring): this needs to run as a long-lived,
 * continuous loop for hours under an external deadline, self-recovering
 * from a failed cycle rather than failing a single "test" — a shape the
 * Playwright test runner isn't built for. It uses the same `playwright`
 * package directly (chromium.launch()), just driven by hand.
 *
 * Terminal-tab safety note: tabs are opened via the folder picker (default
 * launcher mode — see TabBar.tsx's `launcherMode` state), NEVER the agent
 * picker. Opening a folder tab spawns a real, but IDLE, `claude` REPL with
 * no `initialPrompt` typed into it — it sits at its own prompt and consumes
 * no model tokens. Opening an *agent* tab immediately types and submits a
 * real invocation prompt, which would fire off real agent work every few
 * seconds for hours. That path is intentionally never used here.
 */

const NAV_SCREENS = [
  { label: 'Dashboard' },
  { label: 'Agents' },
  { label: 'Projects' },
  { label: 'Memory' },
  { label: 'Analytics' },
  { label: 'Music Player' },
  { label: 'Virtual Pet' },
  { label: 'Academy' },
  { label: 'Settings' },
];

const TERMINAL_LABEL = 'Terminal';
const SCREEN_DWELL_MS = 1200;
const TERMINAL_TABS_PER_CYCLE = 2;
const PTY_SPAWN_SETTLE_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 5;
const PROGRESS_LOG_EVERY_N_CYCLES = 10;

/**
 * Marks the one-time intro cinematic + first-run onboarding overlay as
 * already seen via the app's own real API routes (same routes
 * e2e/helpers.ts's `skipFirstRun` uses), so the loop never sits behind a
 * modal it doesn't care about. Plain fetch, not the Playwright `request`
 * fixture, since this script runs standalone outside the test runner.
 */
async function skipFirstRun(baseUrl, log) {
  for (const pathName of ['/api/intro', '/api/onboarding']) {
    const res = await fetch(`${baseUrl}${pathName}`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`POST ${pathName} failed: ${res.status} ${res.statusText}`);
    }
  }
  log('[loop] intro + onboarding marked seen via API');
}

/**
 * Runs the continuous nav-cycle + terminal-tab load loop until `deadlineTs`
 * (a Date.now()-comparable timestamp). Resolves once the deadline passes or
 * the loop gives up after too many consecutive failed cycles.
 *
 * @param {object} opts
 * @param {import('playwright').Browser} opts.browser
 * @param {string} opts.baseUrl
 * @param {number} opts.deadlineTs
 * @param {(line: string) => void} opts.log
 */
export async function runLoadLoop({ browser, baseUrl, deadlineTs, log }) {
  await skipFirstRun(baseUrl, log);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') {
      log(`[browser:console:error] ${msg.text()}`);
    } else if (type === 'warning' && /webgl|context|leak|memory/i.test(msg.text())) {
      log(`[browser:console:warn] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    log(`[browser:pageerror] ${err?.stack || err}`);
  });
  page.on('crash', () => {
    log('[browser:CRASH] page crashed (likely renderer OOM or GPU process loss)');
  });

  log(`[loop] loading ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const primaryNav = page.getByRole('navigation', { name: 'Primary' });
  await primaryNav.waitFor({ state: 'visible', timeout: 30_000 });
  log('[loop] initial load complete, primary nav visible');

  async function clickNav(label, timeout = 15_000) {
    await primaryNav.getByRole('button', { name: label, exact: true }).click({ timeout });
  }

  async function openAndCloseTerminalTabs(count, actionTimeout = 10_000) {
    await clickNav(TERMINAL_LABEL, actionTimeout);
    await page.waitForTimeout(SCREEN_DWELL_MS);

    for (let i = 0; i < count; i++) {
      await page.locator('.tab-new').click({ timeout: actionTimeout });

      // Folder mode is the picker's default (see TabBar.tsx launcherMode
      // initial state) -- click the first real folder it finds. This spawns
      // a real, idle `claude` PTY session with no prompt typed into it.
      const firstFolder = page.locator('.folder-picker-item').first();
      await firstFolder.waitFor({ state: 'visible', timeout: actionTimeout });
      await firstFolder.click({ timeout: actionTimeout });

      // Give node-pty a moment to actually finish spawning the process
      // before we kill it -- we want a real spawn-then-kill cycle, not a
      // kill racing an in-flight spawn.
      await page.waitForTimeout(PTY_SPAWN_SETTLE_MS);

      const closeButtons = page.locator('.tab-close');
      if ((await closeButtons.count()) > 0) {
        await closeButtons.first().click();
      }
      await page.waitForTimeout(500);
    }
  }

  // Warm-up pass: Next.js dev mode compiles each route/page ON DEMAND, the
  // FIRST time it's hit (see the "Compiling ..." / "Compiled ..." lines in
  // the server log) -- first hits can take several seconds each, sometimes
  // 10s+ for a route with a heavy dependency graph. Racing that one-time
  // compile storm with the timed loop's normal (tight) action timeouts
  // produces spurious "cycle 1 FAILED" noise that has nothing to do with a
  // real leak or hang. So: touch every screen and one full terminal-tab
  // cycle ONCE up front with generous timeouts and no failure counting,
  // before the timed measurement loop below ever starts. By the time the
  // real loop begins, every route this soak test touches has already been
  // dev-compiled and responds at normal speed.
  const WARMUP_TIMEOUT_MS = 45_000;
  log('[loop] warm-up pass starting (lets Next.js dev-mode finish on-demand compiling every route once)');
  try {
    for (const screen of NAV_SCREENS) {
      await clickNav(screen.label, WARMUP_TIMEOUT_MS);
      await page.waitForTimeout(SCREEN_DWELL_MS);
    }
    await openAndCloseTerminalTabs(TERMINAL_TABS_PER_CYCLE, WARMUP_TIMEOUT_MS);
    log('[loop] warm-up pass complete');
  } catch (err) {
    log(`[loop] warm-up pass hit an error (continuing into the timed loop anyway): ${err?.stack || err}`);
  }

  let cycle = 0;
  let consecutiveFailures = 0;

  while (Date.now() < deadlineTs) {
    cycle += 1;
    const cycleStart = Date.now();
    try {
      for (const screen of NAV_SCREENS) {
        await clickNav(screen.label);
        await page.waitForTimeout(SCREEN_DWELL_MS);
      }
      await openAndCloseTerminalTabs(TERMINAL_TABS_PER_CYCLE);

      consecutiveFailures = 0;
      if (cycle === 1 || cycle % PROGRESS_LOG_EVERY_N_CYCLES === 0) {
        log(`[loop] cycle ${cycle} complete in ${Date.now() - cycleStart}ms`);
      }
    } catch (err) {
      consecutiveFailures += 1;
      log(`[loop] cycle ${cycle} FAILED (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err?.stack || err}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log('[loop] too many consecutive failures -- attempting a full page reload to recover');
        try {
          await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await primaryNav.waitFor({ state: 'visible', timeout: 30_000 });
          consecutiveFailures = 0;
          log('[loop] recovered via reload, resuming cycles');
        } catch (reloadErr) {
          log(`[loop] reload recovery also failed: ${reloadErr?.stack || reloadErr}. Giving up on the loop.`);
          break;
        }
      } else {
        await page.waitForTimeout(3000);
      }
    }
  }

  log(`[loop] deadline reached after ${cycle} completed cycles -- closing browser context`);
  try {
    await context.close();
  } catch (err) {
    log(`[loop] context close error: ${err?.stack || err}`);
  }
}
