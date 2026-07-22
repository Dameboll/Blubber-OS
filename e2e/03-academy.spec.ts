/**
 * 03-academy.spec.ts — the locked "Blubber Academy" nav tab
 * (src/components/screens/AcademyScreen.tsx): locked course outline +
 * waitlist form, backed by POST /api/waitlist (src/app/api/waitlist/
 * route.ts).
 *
 * WAITLIST TEST STRATEGY (deliberate, don't "simplify" it away):
 * /api/waitlist is cloud-first — with real Supabase creds in .env.local
 * (which every dev machine here has) a valid submit inserts a REAL row into
 * the production waitlist table. A test suite must never grow that table on
 * every run, and the anon key can't delete rows afterward (the edge
 * function is insert-only by design). So:
 *
 *   - The VALID-email test intercepts POST /api/waitlist in the browser via
 *     page.route() and fulfills the documented `{ ok: true }` contract —
 *     asserting the UI flow and the exact payload the client sends, with
 *     zero production writes. The route handler itself stays untouched.
 *   - The MALFORMED-email test goes through to the real server on purpose:
 *     the 400 comes from the route's own EMAIL_RE check, before any
 *     Supabase call, so it exercises the real endpoint and inserts nothing.
 *     (00-warmup.spec.ts pins that same server contract via the request
 *     fixture too.)
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

  test('shows the coming-soon key art and the waitlist form', async ({ page }) => {
    // The Academy takeover pass replaced the locked course-outline panels with
    // the full-bleed key art + a compact coming-soon waitlist overlay.
    await expect(page.locator('.academy-hero__img')).toBeVisible();
    await expect(page.getByText('Coming soon')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join waitlist' })).toBeVisible();
  });

  test('submitting a valid email succeeds', async ({ page }) => {
    const unique = `qa-${Date.now()}@example.com`;

    // Intercept in the browser (see header comment): fulfill the documented
    // success contract so no real row ever lands in the production Supabase
    // waitlist table, while still verifying the client sends the right
    // request and renders the right success state.
    let sentBody: unknown = null;
    await page.route('**/api/waitlist', async (route) => {
      sentBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.getByRole('textbox', { name: 'Email address' }).fill(unique);
    await page.getByRole('button', { name: 'Join waitlist' }).click();

    await expect(page.getByText("You're on the list")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Joined' })).toBeDisabled();
    expect(sentBody).toEqual({ email: unique });
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
