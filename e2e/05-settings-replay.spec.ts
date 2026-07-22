/**
 * 05-settings-replay.spec.ts — Settings -> "Replay Setup"
 * (src/components/settings/OnboardingSettingsSection.tsx): resets the
 * persisted onboarding + intro flow state (POST /api/onboarding/reset +
 * POST /api/intro/reset) and reloads, so both re-show from the start on
 * next load.
 */

import { test, expect } from 'playwright/test';
import { markIntroSeen, markOnboardingSeen } from './helpers';

test.describe('Settings — Replay Setup', () => {
  test.beforeEach(async ({ request, page }) => {
    await markIntroSeen(request);
    await markOnboardingSeen(request);
    // Reduced motion so the intro cinematic that reappears after reload
    // (it's marked unseen again by Replay Setup) skips straight through
    // instead of needing a manual skip click here -- that behavior is
    // already covered by 01-boot.spec.ts.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings' }).click();
    // Settings is tabbed now (General/Appearance/…/Advanced) and
    // OnboardingSettingsSection moved under the Advanced tab — see
    // SettingsScreen.tsx's activeTab === 'advanced' block.
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Advanced' })
      .click();
  });

  test('Replay Setup resets onboarding + intro so both re-show on next load', async ({ page, request }) => {
    await expect(page.getByRole('heading', { name: 'Onboarding & Accessibility' })).toBeVisible();

    const replayButton = page.getByRole('button', { name: 'Replay Setup' });
    await expect(replayButton).toBeVisible();

    // Wait for BOTH resets the component fires (Promise.all in
    // handleReplaySetup) before it calls window.location.reload() -- this is
    // the real moment to check server-side state, not after the reload.
    // (After reload, reduced-motion's OWN separate contract -- see
    // IntroCinematic.tsx -- immediately re-marks intro "seen" again as soon
    // as the fresh page mounts, which is correct, unrelated behavior already
    // covered by 01-boot.spec.ts; asserting intro is still unseen AFTER the
    // reload would be checking the wrong feature.)
    const [onboardingResetRes, introResetRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/onboarding/reset') && res.request().method() === 'POST'),
      page.waitForResponse((res) => res.url().includes('/api/intro/reset') && res.request().method() === 'POST'),
      replayButton.click(),
    ]);
    expect(onboardingResetRes.status()).toBe(200);
    expect(introResetRes.status()).toBe(200);

    // The real regression this test guards: server-side state actually
    // flipped, not just a client-side illusion of "replaying" -- checked
    // right here, before the reload the component fires next has a chance to
    // change anything again.
    const introState = await (await request.get('/api/intro')).json();
    const onboardingState = await (await request.get('/api/onboarding')).json();
    expect(introState.seen).toBe(false);
    expect(onboardingState.seen).toBe(false);

    // The component reloads the page itself on success -- wait for that, then
    // confirm onboarding (which nothing auto-completes) actually shows again.
    await page.waitForLoadState('load');
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Meet Blubber' })).toBeVisible();
  });
});
