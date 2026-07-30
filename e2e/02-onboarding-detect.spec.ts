/**
 * 02-onboarding-detect.spec.ts — onboarding's real-filesystem detect branch
 * (src/app/api/onboarding/detect/route.ts), intercepted so the test result
 * never depends on whether THIS machine happens to have ~/.claude/projects
 * history. Intro is pre-marked-seen (see helpers.markIntroSeen) so only the
 * onboarding overlay itself is under test here.
 *
 * The spec explicitly asked for the 'not-found' path; 'found' and 'empty'
 * are included too since they're the same mechanism and cost nothing extra
 * to verify for real.
 *
 * Raw-shell pass (Lane C): welcome's action button is 'Scan my workspace'
 * (was 'Continue'), and there's no demo-mode escape hatch anywhere in the
 * flow anymore.
 *
 * The notfound branch now leads with a real in-app installer ("Install it for
 * me" → POST /api/onboarding/install-claude, NDJSON progress stream). That
 * POST is intercepted in the install tests below so no test ever runs the
 * actual Claude Code installer on the machine running the suite.
 */

import { test, expect } from 'playwright/test';
import { markIntroSeen, resetOnboarding } from './helpers';

async function mockDetect(page: import('playwright/test').Page, status: 'found' | 'empty' | 'not-found') {
  await page.route('**/api/onboarding/detect', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status }),
    }),
  );
}

test.describe('Onboarding — detect branches', () => {
  test.beforeEach(async ({ request }) => {
    await markIntroSeen(request);
    await resetOnboarding(request);
  });

  test("detect 'not-found' renders the terse not-found branch with a re-scan + manual link", async ({ page }) => {
    await mockDetect(page, 'not-found');
    await page.goto('/');

    await page.getByRole('button', { name: 'Scan my workspace' }).click();

    await expect(page.getByRole('heading', { name: 'No Claude Code workspace found at ~/.claude.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan again' })).toBeVisible();
    // Quiet text link out to install it manually — never forced.
    const installLink = page.getByRole('link', { name: 'claude.com/claude-code' });
    await expect(installLink).toBeVisible();
    await expect(installLink).toHaveAttribute('href', 'https://claude.com/claude-code');
  });

  // Regression guard. This branch shipped as a modal cage: scan-again (which
  // fails forever on a machine with no Claude Code) or a link out, and nothing
  // else. A fresh-box smoke test in Windows Sandbox walled the app off at first
  // launch. The escape hatch is the fix — do not remove it.
  test("detect 'not-found' lets the user into the app without installing Claude Code", async ({ page }) => {
    await mockDetect(page, 'not-found');
    await page.goto('/');

    await page.getByRole('button', { name: 'Scan my workspace' }).click();
    await expect(page.getByRole('heading', { name: 'No Claude Code workspace found at ~/.claude.' })).toBeVisible();

    await page.getByRole('button', { name: 'Look around first' }).click();

    // Overlay is gone and the dashboard is behind it.
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeHidden();
  });

  // The in-app installer must be reachable from THIS branch by everyone. It
  // was previously written as Starter-Kit-gated and wired to no UI at all,
  // which is unreachable twice over: the kit marker lives inside ~/.claude
  // (server/kit-marker.ts), the very directory whose absence defines this
  // branch, so `kit` is always false here. Kit buyers got the same
  // link-and-good-luck screen as free users.
  test("detect 'not-found' offers a real in-app install and advances on success", async ({ page }) => {
    await mockDetect(page, 'not-found');

    // Stand in for the installer child process: the same NDJSON shapes
    // stream-command.ts emits, ending in a successful `done`.
    let installCalls = 0;
    await page.route('**/api/onboarding/install-claude', (route) => {
      installCalls += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          JSON.stringify({ type: 'step', label: 'Installing Claude Code (official Windows installer)' }) + '\n' +
          JSON.stringify({ type: 'stdout', data: 'Downloading claude 2.1.219...\n' }) + '\n' +
          JSON.stringify({ type: 'exit', label: 'Installing Claude Code', code: 0 }) + '\n' +
          JSON.stringify({ type: 'done', ok: true }) + '\n',
      });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Scan my workspace' }).click();
    await expect(page.getByRole('heading', { name: 'No Claude Code workspace found at ~/.claude.' })).toBeVisible();

    // After a successful install the re-scan sees an installed-but-never-run
    // binary, so the user lands on 'empty' — NOT back on this same screen,
    // which is what the old ~/.claude-only detect would have done.
    await mockDetect(page, 'empty');
    await page.getByRole('button', { name: 'Install it for me' }).click();

    // Deliberately NOT asserting the streamed stdout here: on a mocked stream
    // the install finishes instantly and the log unmounts with the step change,
    // so that assertion races the transition. That the real output renders is
    // covered by the failure test below, where the log persists.
    await expect(page.getByRole('heading', { name: 'Clean slate' })).toBeVisible();
    expect(installCalls).toBe(1);
  });

  test("detect 'not-found' surfaces a failed install and stays recoverable", async ({ page }) => {
    await mockDetect(page, 'not-found');
    await page.route('**/api/onboarding/install-claude', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          JSON.stringify({ type: 'step', label: 'Installing Claude Code' }) + '\n' +
          JSON.stringify({ type: 'stderr', data: 'curl: (6) Could not resolve host: claude.ai\n' }) + '\n' +
          JSON.stringify({ type: 'exit', label: 'Installing Claude Code', code: 1 }) + '\n' +
          JSON.stringify({ type: 'done', ok: false }) + '\n',
      }),
    );

    await page.goto('/');
    await page.getByRole('button', { name: 'Scan my workspace' }).click();
    await page.getByRole('button', { name: 'Install it for me' }).click();

    // The real error text is shown — never swallowed into a generic message.
    await expect(page.getByText('Could not resolve host: claude.ai')).toBeVisible();
    // Retry is offered, and the way into the app is still there.
    await expect(page.getByRole('button', { name: 'Try install again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Look around first' })).toBeVisible();
  });

  test("detect 'empty' renders the clean-slate branch and completes onboarding", async ({ page }) => {
    await mockDetect(page, 'empty');
    let injectCalls = 0;
    await page.route('**/api/onboarding/inject', (route) => {
      injectCalls += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Scan my workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Clean slate' })).toBeVisible();

    await page.getByRole('button', { name: 'Enter Blubber OS' }).click();

    // Onboarding overlay is gone, the real app shell is mounted.
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    expect(injectCalls).toBe(1);
  });

  test("detect 'found' renders the inject branch and shows a real stats summary", async ({ page }) => {
    await mockDetect(page, 'found');
    await page.route('**/api/system', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ cpu: 11, mem: 22, proc: 33 }),
      }),
    );
    await page.goto('/');

    await page.getByRole('button', { name: 'Scan my workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Found your setup' })).toBeVisible();

    await page.getByRole('button', { name: 'Inject my setup' }).click();

    await expect(page.getByRole('heading', { name: "You're live" })).toBeVisible();
    await expect(page.getByText('11%')).toBeVisible();
    await expect(page.getByText('22%')).toBeVisible();
    await expect(page.getByText('33%')).toBeVisible();

    await page.getByRole('button', { name: "Let's go" }).click();
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toHaveCount(0);
  });
});
