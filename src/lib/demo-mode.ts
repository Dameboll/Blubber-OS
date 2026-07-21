/**
 * demo-mode — lets a stranger with zero Claude Code history still see a
 * believable, clearly DEMO-badged dashboard. Fully isomorphic (no Node
 * built-ins), safe to import from both client components and server route
 * handlers.
 *
 * Persistence model:
 *   - Client:  a `blubber_demo` flag in localStorage (survives reloads),
 *              mirrored into a same-name, non-HttpOnly cookie every time
 *              it's checked or set. Same-origin fetch() calls send that
 *              cookie automatically, so API routes see it with zero extra
 *              wiring — the cookie IS the shared state between the client
 *              and the API routes, no server-side "is demo on" store needed.
 *   - Server:  API routes call isDemoModeRequest(request) to read that same
 *              cookie straight off the incoming Request's headers.
 *   - `?demo=1` in the URL activates + persists it on first load so it
 *     survives subsequent navigation without the param on every URL.
 *     `?demo=0` is the explicit escape hatch that turns it back off.
 *
 * No src/server/demo-store.ts was built for this: a cookie is sufficient
 * persistence for a boolean flag, so a separate store would just be
 * indirection. See src/server/demo-dataset.ts for the (separate, unrelated)
 * job of loading the bundled demo dataset itself.
 */

export const DEMO_FLAG_NAME = "blubber_demo";
const DEMO_QUERY_PARAM = "demo";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // ~1 year — a persisted preference, not a session blip

function setClientCookie(value: string, maxAgeSeconds: number): void {
  if (typeof document === "undefined") return;
  document.cookie = `${DEMO_FLAG_NAME}=${value}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

function readClientCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${DEMO_FLAG_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Turns Demo Mode ON: persists to localStorage + the cookie API routes read. */
export function activateDemoMode(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEMO_FLAG_NAME, "1");
  } catch {
    // localStorage unavailable (private browsing) — the cookie still carries it
  }
  setClientCookie("1", COOKIE_MAX_AGE_SECONDS);
}

/** Turns Demo Mode OFF: clears localStorage + expires the cookie. */
export function deactivateDemoMode(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DEMO_FLAG_NAME);
  } catch {
    // ignore — expiring the cookie below is what actually matters
  }
  setClientCookie("", 0);
}

/**
 * Client-side check, meant to be called once on initial app mount (it both
 * reads AND writes persisted state, so avoid calling it from a hot render
 * path or tight loop).
 *
 * Priority: `?demo=1` / `?demo=0` query param (persists the choice) beats the
 * persisted localStorage flag (which is re-synced into the cookie on every
 * check, in case the cookie expired independently — e.g. cleared cookies
 * but not localStorage).
 */
export function isDemoModeActive(): boolean {
  if (typeof window === "undefined") return false;

  const queryValue = new URLSearchParams(window.location.search).get(DEMO_QUERY_PARAM);
  if (queryValue === "1") {
    activateDemoMode();
    return true;
  }
  if (queryValue === "0") {
    deactivateDemoMode();
    return false;
  }

  try {
    if (window.localStorage.getItem(DEMO_FLAG_NAME) === "1") {
      setClientCookie("1", COOKIE_MAX_AGE_SECONDS);
      return true;
    }
  } catch {
    // localStorage unavailable — fall through to the cookie itself
  }

  return readClientCookie() === "1";
}

/** Server-side check for API route handlers — reads the same cookie straight
 * off the incoming Request. No shared server state: the cookie IS the state. */
export function isDemoModeRequest(request: Request): boolean {
  const header = request.headers.get("cookie");
  if (!header) return false;
  const match = header.match(new RegExp(`(?:^|;\\s*)${DEMO_FLAG_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) === "1" : false;
}
