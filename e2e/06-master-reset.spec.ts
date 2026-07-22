/**
 * 06-master-reset.spec.ts — Settings' master reset (POST /api/reset)
 * regression check. This endpoint existed before Stage B; Stage B only
 * ADDED calls to resetOnboardingState()/resetIntroState()/
 * resetKitInstallState() alongside it (see src/app/api/reset/route.ts).
 * This spec confirms it still returns 200 and the app still comes back up
 * cleanly afterward.
 *
 * Runs LAST (numeric filename + workers:1, see playwright.config.ts) because
 * POST /api/reset wipes onboarding/intro/pet/quests/stats-baseline state
 * that earlier specs (01, 02, 05) depend on being in a known condition.
 */

import { test, expect } from 'playwright/test';
import { markIntroSeen, markOnboardingSeen } from './helpers';

test.describe('Master reset — regression check', () => {
  test('POST /api/reset returns 200 with a fresh baseline, and the app boots cleanly after it', async ({
    page,
    request,
  }) => {
    const res = await request.post('/api/reset');
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { ok: boolean; baseline: string };
    expect(body.ok).toBe(true);
    expect(typeof body.baseline).toBe('string');
    expect(Number.isNaN(Date.parse(body.baseline))).toBe(false);

    // The app must still come up cleanly right after a master reset. Reduced
    // motion so the one-time intro cinematic (unseen again post-reset)
    // doesn't gate this assertion -- its own behavior is already covered by
    // 01-boot.spec.ts.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    // Onboarding is unseen again post-reset -- confirm the whole first-run
    // pipeline still renders (no 500, no blank page, no crash) immediately
    // after a master reset.
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Meet Blubber' })).toBeVisible();

    await page.getByRole('button', { name: 'Scan my workspace' }).click();
    await expect(page.getByText('Looking for Claude Code on this machine')).toBeVisible();

    // Cleanup: leave the app in a normal, usable state for whoever opens the
    // real dev server after this suite runs, rather than stranding it behind
    // a half-finished onboarding overlay.
    await markIntroSeen(request);
    await markOnboardingSeen(request);
  });
});
