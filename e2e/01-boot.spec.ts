/**
 * 01-boot.spec.ts — fresh-state boot sequence.
 *
 * Covers: IntroCinematic (src/components/IntroCinematic.tsx) plays, then
 * OnboardingOverlay (src/components/onboarding/OnboardingOverlay.tsx) shows
 * once the intro clears; the skip control on the intro (click + keyboard);
 * and prefers-reduced-motion behavior for both layers.
 */

import { test, expect } from 'playwright/test';
import { resetFirstRun } from './helpers';

test.describe('Fresh-state boot', () => {
  test('intro cinematic plays, its skip button dismisses it, onboarding follows in sequence', async ({
    page,
    request,
  }) => {
    await resetFirstRun(request);
    await page.goto('/');

    const introOverlay = page.locator('.intro-cinematic');
    await expect(introOverlay).toBeVisible();

    // Sequencing here is intentionally visual, not mount-order: page.tsx
    // always mounts the app (and OnboardingOverlay, once its own `seen` check
    // resolves) immediately underneath, and IntroCinematic only ever adds a
    // full-viewport, opaque, top-most overlay ON TOP of it (position:fixed,
    // inset:0, z-index:9999, solid --bg-primary -- see IntroCinematic.css and
    // that component's own header comment). So the onboarding dialog can
    // already be present in the DOM here; what must hold is that it is
    // visually covered edge-to-edge by the intro overlay until skip/complete.
    const introBox = await introOverlay.boundingBox();
    const viewport = page.viewportSize();
    expect(introBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (introBox && viewport) {
      expect(introBox.width).toBeGreaterThanOrEqual(viewport.width);
      expect(introBox.height).toBeGreaterThanOrEqual(viewport.height);
    }

    await page.getByRole('button', { name: 'tap / esc to skip' }).click();
    await expect(introOverlay).toBeHidden();

    // Onboarding overlay follows, in sequence.
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Meet Blubber' })).toBeVisible();
  });

  test('Escape key also skips the intro cinematic', async ({ page, request }) => {
    await resetFirstRun(request);
    await page.goto('/');

    const introOverlay = page.locator('.intro-cinematic');
    await expect(introOverlay).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(introOverlay).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeVisible();
  });

  test('prefers-reduced-motion: intro never renders and is marked seen automatically; onboarding still shows', async ({
    page,
    request,
  }) => {
    await resetFirstRun(request);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // The auto-skip fires its POST /api/intro fire-and-forget during page
    // load (best-effort by design — see IntroCinematic.tsx's completeIntro),
    // so arm the wait before goto and await it before asserting persistence.
    const introPost = page.waitForResponse(
      (res) => res.url().includes('/api/intro') && res.request().method() === 'POST',
    );
    await page.goto('/');

    // The cinematic overlay must never mount at all under reduced motion --
    // not "appear then vanish", never present (see IntroCinematic.tsx's own
    // header comment on this exact contract).
    await expect(page.locator('.intro-cinematic')).toHaveCount(0);

    // Onboarding overlay still renders underneath -- reduced motion only
    // skips ITS internal fade transition, never the whole flow (it has no
    // skip-to-end-state behavior of its own; this is a real, deliberate
    // difference from the intro cinematic's behavior, confirmed by reading
    // OnboardingOverlay.tsx -- it has no prefers-reduced-motion gate on
    // whether it renders, only on the GSAP fade between its steps).
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeVisible();

    // And the intro really was marked seen server-side, not just skipped
    // client-side for this one page load.
    expect((await introPost).status()).toBe(200);
    const introState = await (await request.get('/api/intro')).json();
    expect(introState.seen).toBe(true);
  });
});
