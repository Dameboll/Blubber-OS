'use client';

/**
 * reduce-effects — a user-controlled "turn down the visual noise" flag,
 * separate from (and layered on top of) the OS-level `prefers-reduced-motion`
 * media query that globals.css / useAgentSpawn.ts / etc. already respect.
 *
 * `prefers-reduced-motion` is an accessibility signal Blubber OS should
 * always honor and can't override. This flag is the opt-in complement: some
 * users just want a calmer dashboard (fewer glows/animations) without
 * actually setting the OS-level accessibility preference. It's a plain
 * localStorage-backed toggle that also stamps a `reduce-effects` class onto
 * <html>, mirroring how `:root` already keys off
 * `@media (prefers-reduced-motion: reduce)` in globals.css — CSS elsewhere in
 * the app can add `:root.reduce-effects { ... }` overrides the same way it
 * already adds `@media (prefers-reduced-motion: reduce) { ... }` blocks.
 *
 * FOLLOW-UP (closed): this module now also exports `isReduceEffectsActive()`
 * (a synchronous, non-React read of the live `<html>` class — safe to call
 * from a one-off effect or event handler) and `onReduceEffectsChange()` (a
 * MutationObserver-based subscription for components that stay mounted
 * across a screen switch and need to react live when a *different* mounted
 * component — e.g. the Settings toggle — flips the flag; the two hook
 * instances have independent React state and don't otherwise know about each
 * other). Consumers: AmbientGlow.tsx (live), IntroCinematic.tsx and
 * OnboardingOverlay.tsx (one-off reads), plus the `:root.reduce-effects`
 * CSS overrides in globals.css and AgentPoolWorld.css. Not every animated
 * component in the app consumes this yet — see those files' own comments for
 * what's covered vs. still outstanding.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'blubber_reduce_effects';
const HTML_CLASS = 'reduce-effects';

function readStoredValue(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage can throw in locked-down/private-browsing contexts —
    // fail closed (effects stay on) rather than crash the settings screen.
    return false;
  }
}

function applyHtmlClass(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(HTML_CLASS, enabled);
}

/** Synchronous, non-React read of the live `<html class="reduce-effects">`
 *  marker. Use this in one-off checks (a gate that only runs once, or a
 *  `useLayoutEffect` that already reruns per relevant event) where mounting
 *  the full `useReduceEffects()` hook would be overkill. Always reflects the
 *  current DOM state, regardless of which component last changed it.
 *
 *  FIX (hardening pass, verified via e2e/07-intro-hardening.spec.ts): the
 *  `<html>` class is only ever APPLIED by `useReduceEffects()`'s own effect,
 *  which is only mounted inside the Settings screen
 *  (OnboardingSettingsSection.tsx). A one-off reader that runs before the
 *  user has ever opened Settings in this session -- which is exactly what
 *  IntroCinematic's and OnboardingOverlay's gate checks do, on the very
 *  first paint of a fresh boot -- would read `false` even when a PREVIOUS
 *  session's toggle is sitting in localStorage as `true`, because nothing
 *  has had a chance to sync it onto the DOM yet. Falling back to the
 *  persisted value directly closes that gap: the class stays the fast path
 *  for the common case (already synced this session), and storage is the
 *  authoritative source of truth underneath it either way. */
export function isReduceEffectsActive(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.classList.contains(HTML_CLASS)) return true;
  return readStoredValue();
}

/** Subscribes to changes in the manual reduce-effects flag by watching the
 *  `<html>` element's `class` attribute directly — the actual source of
 *  truth once `applyHtmlClass()` has run — rather than relying on React
 *  state from a particular `useReduceEffects()` instance. This is what lets
 *  a long-lived component (mounted once at the page root, e.g. AmbientGlow)
 *  react live when a completely different mounted component (e.g. the
 *  Settings toggle, in another part of the tree) flips the flag. Calls back
 *  immediately with the current value, then on every subsequent change.
 *  Returns an unsubscribe function. */
export function onReduceEffectsChange(callback: (enabled: boolean) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    callback(false);
    return () => {};
  }
  callback(isReduceEffectsActive());
  const observer = new MutationObserver(() => {
    callback(isReduceEffectsActive());
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export interface ReduceEffectsControls {
  /** Whether the user has opted into the reduced-effects mode. */
  reduceEffects: boolean;
  /** Flip the flag, persist it, and update the <html> class immediately. */
  setReduceEffects: (enabled: boolean) => void;
  /** Convenience toggle — flips the current value. */
  toggleReduceEffects: () => void;
}

/** Reads/writes the `blubber_reduce_effects` localStorage flag and keeps the
 *  `<html class="reduce-effects">` marker in sync with it. Safe to call from
 *  multiple components — each mount reads the same localStorage key and
 *  re-applies the same class, so there's no divergent state between callers. */
export function useReduceEffects(): ReduceEffectsControls {
  // Lazy initializer so SSR and the first client render both start from
  // `false` (matches readStoredValue()'s SSR branch) and the real stored
  // value is picked up in the effect below — avoids a hydration mismatch.
  const [reduceEffects, setReduceEffectsState] = useState(false);

  useEffect(() => {
    const stored = readStoredValue();
    setReduceEffectsState(stored);
    applyHtmlClass(stored);
  }, []);

  const setReduceEffects = useCallback((enabled: boolean) => {
    setReduceEffectsState(enabled);
    applyHtmlClass(enabled);
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // See readStoredValue() — ignore write failures, the in-memory/class
      // state for this session is still correct even if it won't persist.
    }
  }, []);

  const toggleReduceEffects = useCallback(() => {
    setReduceEffects(!reduceEffects);
  }, [reduceEffects, setReduceEffects]);

  return { reduceEffects, setReduceEffects, toggleReduceEffects };
}
