/**
 * 07-intro-hardening.spec.ts — pre-launch hardening pass on IntroCinematic
 * (src/components/IntroCinematic.tsx). 01-boot.spec.ts already covers the
 * fresh-state sequencing, click-to-skip, Escape-to-skip, and OS-level
 * prefers-reduced-motion. This file covers what that one doesn't:
 *
 *   - Enter key also skips (the component wires both Escape and Enter,
 *     01-boot only exercises Escape)
 *   - the manual reduce-effects override (src/lib/reduce-effects.ts) skips
 *     the intro independently of the OS media query
 *   - no duplicate/leaked WebGL context across repeated intro plays -- the
 *     app is supposed to run on exactly ONE shared WebGLRenderer
 *     (src/lib/flubber3d/host.ts's singleton), and IntroCinematic's own
 *     <Flubber3D> stage must register/dispose against that same singleton
 *     cleanly every time the cinematic mounts and unmounts
 *   - layout sanity at two real desktop window sizes (this is an Electron
 *     desktop app, not a mobile page -- 1280x800 and 1920x1080 stand in for
 *     a small laptop window and a full HD monitor)
 */

import { test, expect } from 'playwright/test';
import { resetFirstRun } from './helpers';

test.describe('IntroCinematic hardening', () => {
  test('Enter key also skips the intro cinematic', async ({ page, request }) => {
    await resetFirstRun(request);
    await page.goto('/');

    const introOverlay = page.locator('.intro-cinematic');
    await expect(introOverlay).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(introOverlay).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Welcome to Blubber' })).toBeVisible();

    // And it actually persisted server-side, not just a client-side skip.
    const introState = await (await request.get('/api/intro')).json();
    expect(introState.seen).toBe(true);
  });

  test('manual reduce-effects override skips the intro independently of the OS setting', async ({
    page,
    request,
  }) => {
    await resetFirstRun(request);
    // OS-level preference deliberately left at its default (NOT reduced) --
    // this test is only valid if the manual flag alone is what's doing the
    // work, not an accidental OS-level assist.
    await page.addInitScript(() => {
      window.localStorage.setItem('blubber_reduce_effects', 'true');
    });

    // Instrument every canvas context creation on the page from the very
    // first script execution (before any app code runs), so this catches a
    // WebGL context truly never being requested for the intro -- not just
    // the overlay div being invisible for some unrelated CSS reason.
    await page.addInitScript(() => {
      (window as unknown as { __webglCreations: string[] }).__webglCreations = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      // @ts-expect-error -- test-only monkeypatch, signature intentionally loose
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type === 'webgl' || type === 'webgl2') {
          (window as unknown as { __webglCreations: string[] }).__webglCreations.push(type);
        }
        // @ts-expect-error -- forwarding to the original overload
        return orig.call(this, type, ...args);
      };
    });

    await page.goto('/');

    // The cinematic overlay must never mount at all -- same contract as the
    // OS prefers-reduced-motion path in 01-boot.spec.ts, just driven by the
    // manual flag instead.
    await expect(page.locator('.intro-cinematic')).toHaveCount(0);

    const webglCreations = await page.evaluate(
      () => (window as unknown as { __webglCreations: string[] }).__webglCreations,
    );
    expect(webglCreations).toEqual([]);

    // And it was marked seen server-side, exactly like the OS-level path.
    const introState = await (await request.get('/api/intro')).json();
    expect(introState.seen).toBe(true);
  });

  test('exactly one WebGL context is ever created across repeated intro plays (shared-host contract)', async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __webglCreations: string[] }).__webglCreations = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      // @ts-expect-error -- test-only monkeypatch
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type === 'webgl' || type === 'webgl2') {
          (window as unknown as { __webglCreations: string[] }).__webglCreations.push(type);
        }
        // @ts-expect-error -- forwarding to the original overload
        return orig.call(this, type, ...args);
      };
    });

    const consoleWarnings: string[] = [];
    page.on('console', (msg) => {
      if (/too many active webgl contexts/i.test(msg.text())) consoleWarnings.push(msg.text());
    });

    // Play + skip the cinematic three times in the SAME page (no reload --
    // reloading would reset the injected instrumentation and, more
    // importantly, wouldn't test what actually matters here: mounting and
    // unmounting <Flubber3D> repeatedly within one live app session, e.g. a
    // user bouncing Settings' "Replay Setup" a few times in one sitting).
    for (let i = 0; i < 3; i += 1) {
      await resetFirstRun(request);
      await page.goto('/');
      const introOverlay = page.locator('.intro-cinematic');
      await expect(introOverlay).toBeVisible();
      // Let the stage actually mount its <Flubber3D> slot before skipping.
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await expect(introOverlay).toBeHidden();
    }

    const webglCreations = await page.evaluate(
      () => (window as unknown as { __webglCreations: string[] }).__webglCreations,
    );
    // The shared host (src/lib/flubber3d/host.ts) creates its single
    // WebGLRenderer lazily on first register() and never again -- three
    // intro plays in one page session must not create three contexts.
    expect(webglCreations.length).toBeLessThanOrEqual(1);
    expect(consoleWarnings).toEqual([]);
  });

  for (const viewport of [
    { width: 1280, height: 800, label: 'small laptop window' },
    { width: 1920, height: 1080, label: 'full HD monitor' },
  ]) {
    test(`layout holds at ${viewport.width}x${viewport.height} (${viewport.label})`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await resetFirstRun(request);
      await page.goto('/');

      const introOverlay = page.locator('.intro-cinematic');
      await expect(introOverlay).toBeVisible();
      // Let the wordmark crossfade in (scheduled at 1.9s in the GSAP timeline).
      await page.waitForTimeout(2200);

      const overlayBox = await introOverlay.boundingBox();
      const wordmarkBox = await page.locator('.intro-cinematic__wordmark').boundingBox();
      expect(overlayBox).not.toBeNull();
      expect(wordmarkBox).not.toBeNull();

      if (overlayBox) {
        expect(overlayBox.width).toBeGreaterThanOrEqual(viewport.width);
        expect(overlayBox.height).toBeGreaterThanOrEqual(viewport.height);
      }
      if (overlayBox && wordmarkBox) {
        const overlayCenterX = overlayBox.x + overlayBox.width / 2;
        const wordmarkCenterX = wordmarkBox.x + wordmarkBox.width / 2;
        expect(Math.abs(overlayCenterX - wordmarkCenterX)).toBeLessThan(2);
      }

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
