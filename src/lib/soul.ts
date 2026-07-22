// soul — tiny client helper for launching the Soul Interview (see
// src/components/soul/SoulInterview.tsx) from anywhere, without prop-drilling
// or a new API route. Mirrors src/lib/tour.ts's requestTour/consumeTourPending
// pair exactly — same pending-flag-plus-live-event shape, same reasoning.
//
// Three launch paths, one destination (SoulInterview in page.tsx):
//   1. DashboardTour finishes (the user clicked through every step, not
//      "Skip tour") → requestSoulInterview(). page.tsx's live event listener
//      is already attached (it mounts as soon as onboardingSeen is true, the
//      same gate the tour itself is under), so this shows the interview the
//      moment the tour closes, no reload needed.
//   2. OnboardingOverlay's 'starterKit' step: the user declines the guided
//      tour ("No thanks, I'll explore") → requestSoulInterview() before
//      finish(). The pending flag bridges this across the onboarding→app
//      remount exactly like the tour's own pending flag does.
//   3. Settings → "Retake soul interview" (RetakeSoulInterview.tsx), fired
//      while the app is already mounted → the live event covers it directly,
//      same as KitInstaller re-firing requestTour().
//
// Never fired for both tour-completion AND tour-decline at once — those are
// mutually exclusive branches of the same starterKit offer, so there's no
// double-mount race to guard against here.

export const SOUL_PENDING_KEY = 'blubber_soul_pending';
export const SOUL_EVENT = 'blubber:start-soul';

/** Ask for the Soul Interview to run. Persists a pending flag (for the
 * onboarding→app remount) AND fires a live event (for an already-mounted app). */
export function requestSoulInterview(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUL_PENDING_KEY, '1');
  } catch {
    // localStorage unavailable — the event below still covers the live case.
  }
  window.dispatchEvent(new CustomEvent(SOUL_EVENT));
}

/** Read-and-clear the pending flag. Returns true at most once per request. */
export function consumeSoulPending(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(SOUL_PENDING_KEY) === '1') {
      window.localStorage.removeItem(SOUL_PENDING_KEY);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}
