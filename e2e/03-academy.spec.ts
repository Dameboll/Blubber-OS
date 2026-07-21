/**
 * 03-academy.spec.ts — the locked "Blubber Academy" nav tab
 * (src/components/screens/AcademyScreen.tsx): locked course outline +
 * waitlist form, wired to the one real endpoint behind this screen
 * (POST /api/waitlist -> src/server/waitlist-store.ts).
 */

import { test, expect } from 'playwright/test';
import { markIntroSeen, markOnboardingSeen } from './helpers';

test.describe('Academy tab', () => {
  test.beforeEach(async ({ request, page }) => {
    await markIntroSeen(request);
    await markOnboardingSeen(request);
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Academy' }).click();
    await expect(page.getByRole('heading', { name: 'Blubber Academy' })).toBeVisible();
  });

  test('shows the locked course outline and the waitlist form', async ({ page }) => {
    await expect(page.locator('.academy-module--locked')).toHaveCount(5);
    await expect(page.getByRole('heading', { name: 'Getting Started with Claude Code' })).toBeVisible();
    await expect(page.getByText('Bundled with All Access')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join waitlist' })).toBeVisible();
  });

  test('submitting a valid email succeeds', async ({ page }) => {
    const unique = `qa-${Date.now()}@example.com`;

    await page.getByRole('textbox', { name: 'Email address' }).fill(unique);
    await page.getByRole('button', { name: 'Join waitlist' }).click();

    await expect(page.getByText("You're on the list")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Joined' })).toBeDisabled();
  });

  test('submitting a malformed email is rejected by the server', async ({ page }) => {
    const input = page.getByRole('textbox', { name: 'Email address' });
    await input.fill('not-an-email-address');

    // Bypass the input's native type="email" constraint validation so the
    // click actually reaches handleSubmit() and exercises the SERVER'S
    // EMAIL_RE check (src/app/api/waitlist/route.ts) -- what this test is
    // actually meant to verify -- instead of being silently blocked by the
    // browser before any request is ever sent.
    await page.evaluate(() => {
      const form = document.querySelector('form.academy-waitlist') as HTMLFormElement | null;
      if (form) form.noValidate = true;
    });

    await page.getByRole('button', { name: 'Join waitlist' }).click();

    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    // Never a false "success" -- the button stays actionable, not "Joined".
    await expect(page.getByRole('button', { name: 'Join waitlist' })).toBeVisible();
  });
});
