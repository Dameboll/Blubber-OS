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
 * SCOPE NOTE (from the Settings lane's build pass): this module only owns the
 * flag + the `reduce-effects` class infrastructure. It does NOT yet chase
 * down every animated component in the app to make it consume the class —
 * that's real follow-up work once this lands. See OnboardingSettingsSection's
 * file header for the current list of what still needs wiring.
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
