/**
 * e2e/helpers.ts — small shared helpers for the Stage B QA suite.
 *
 * These talk to the app's own real API routes (never a test-only backdoor)
 * so every spec exercises the exact same persistence Settings' "Replay
 * Setup" button and the onboarding/intro components themselves use:
 *   - src/app/api/intro/route.ts + /reset
 *   - src/app/api/onboarding/route.ts + /reset
 *
 * `request` here is whatever APIRequestContext the calling test passes in
 * (the `request` fixture, or `page.request` when cookie-sharing with a
 * specific page matters — see 04-demo-mode.spec.ts).
 */

import type { APIRequestContext } from 'playwright/test';

/** Marks the one-time intro cinematic as already seen, so a spec that isn't
 * testing the intro itself never has to sit through / skip it first. */
export async function markIntroSeen(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/intro');
  if (!res.ok()) throw new Error(`POST /api/intro failed: ${res.status()}`);
}

/** Marks first-run onboarding as already seen, same reasoning as above. */
export async function markOnboardingSeen(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/onboarding');
  if (!res.ok()) throw new Error(`POST /api/onboarding failed: ${res.status()}`);
}

/** Clears the persisted intro flag so it plays again on next load. */
export async function resetIntro(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/intro/reset');
  if (!res.ok()) throw new Error(`POST /api/intro/reset failed: ${res.status()}`);
}

/** Clears the persisted onboarding flag so it shows again on next load. */
export async function resetOnboarding(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/onboarding/reset');
  if (!res.ok()) throw new Error(`POST /api/onboarding/reset failed: ${res.status()}`);
}

/** Both flags -> unseen. Used by the one spec that actually wants a
 * true "brand new machine" boot sequence. */
export async function resetFirstRun(request: APIRequestContext): Promise<void> {
  await resetOnboarding(request);
  await resetIntro(request);
}

/** Both flags -> seen. Used by every OTHER spec so the intro cinematic /
 * onboarding overlay never gates the thing that spec actually cares about. */
export async function skipFirstRun(request: APIRequestContext): Promise<void> {
  await markIntroSeen(request);
  await markOnboardingSeen(request);
}
