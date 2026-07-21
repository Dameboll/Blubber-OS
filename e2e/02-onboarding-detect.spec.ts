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

  test("detect 'not-found' renders the two-button no-Claude-Code branch", async ({ page }) => {
    await mockDetect(page, 'not-found');
    await page.goto('/');

    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'No Claude Code detected' })).toBeVisible();
    const installLink = page.getByRole('link', { name: 'Install Claude Code' });
    await expect(installLink).toBeVisible();
    await expect(installLink).toHaveAttribute('href', 'https://claude.com/claude-code');
    await expect(page.getByRole('button', { name: 'Try Demo Mode' })).toBeVisible();
  });

  test("detect 'empty' renders the clean-slate branch and completes onboarding", async ({ page }) => {
    await mockDetect(page, 'empty');
    await page.goto('/');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Clean slate' })).toBeVisible();

    await page.getByRole('button', { name: 'Enter Blubber OS' }).click();

    // Onboarding overlay is gone, the real app shell is mounted.
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
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

    await page.getByRole('button', { name: 'Continue' }).click();
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
