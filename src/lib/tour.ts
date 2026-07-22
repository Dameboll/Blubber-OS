// tour — tiny client helper for launching the Starter-Kit dashboard walkthrough
// from anywhere, without prop-drilling or a new API route.
//
// Two launch paths, one destination (DashboardTour in page.tsx):
//   1. Onboarding detects the kit → user opts into the tour → requestTour().
//      Onboarding then finishes and the app mounts; page.tsx consumes the
//      pending flag on mount and starts the tour.
//   2. User injects the kit from Settings while already in the app →
//      KitInstaller calls requestTour() → the live 'blubber:start-tour' event
//      fires and page.tsx starts the tour immediately, no reload.
//
// The pending flag (localStorage) bridges case 1 across the onboarding→app
// remount; the event covers case 2 in the same session. consumeTourPending()
// is one-shot, so a reload after the tour never re-triggers it.

export const TOUR_PENDING_KEY = 'blubber_tour_pending';
export const TOUR_EVENT = 'blubber:start-tour';

/** Ask for the walkthrough to run. Persists a pending flag (for the
 * onboarding→app remount) AND fires a live event (for an already-mounted app). */
export function requestTour(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOUR_PENDING_KEY, '1');
  } catch {
    // localStorage unavailable — the event below still covers the live case.
  }
  window.dispatchEvent(new CustomEvent(TOUR_EVENT));
}

/** Read-and-clear the pending flag. Returns true at most once per request. */
export function consumeTourPending(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(TOUR_PENDING_KEY) === '1') {
      window.localStorage.removeItem(TOUR_PENDING_KEY);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}
