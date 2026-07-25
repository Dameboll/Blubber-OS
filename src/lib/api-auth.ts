/**
 * Client half of the localhost authorization boundary.
 *
 * server.js rejects every state-changing /api/* request that doesn't carry
 * the per-process secret in an `x-blubber-token` header (see the mutation
 * gate in server.js). This module patches window.fetch ONCE so every
 * same-origin non-GET request the app makes automatically attaches that
 * header — one choke point instead of touching dozens of call sites.
 *
 * The token comes from /__ws-auth, the same-origin-only endpoint ws-client
 * already uses: no CORS headers means a foreign page can send the request
 * but can never read the token out of the response, so it can never forge
 * the header. The custom header itself also forces a CORS preflight on any
 * cross-origin attempt, which the server never approves.
 */

const TOKEN_PATH = "/__ws-auth";

let tokenPromise: Promise<string> | null = null;
let installed = false;

function getToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      try {
        const res = await fetch(TOKEN_PATH, { cache: "no-store" });
        if (!res.ok) return "";
        const data = (await res.json()) as { token?: string };
        return data.token ?? "";
      } catch {
        // Retry on the next mutation rather than caching a failure forever.
        tokenPromise = null;
        return "";
      }
    })();
  }
  return tokenPromise;
}

function isSameOriginApiMutation(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const rawUrl =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(rawUrl, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Idempotent — safe to call from any client module's top level. */
export function installFetchAuth(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isSameOriginApiMutation(input, init)) return realFetch(input, init);

    const token = await getToken();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (token) headers.set("x-blubber-token", token);
    return realFetch(input, { ...init, headers });
  }) as typeof window.fetch;
}
