/**
 * 00-warmup.spec.ts — dev-server compile warm-up + API smoke check.
 *
 * WHY THIS EXISTS (root cause of the old 03/04 "pre-existing failures"):
 * this suite runs against the real `node server.js` DEV server, which
 * compiles every route on first hit, serially. Meanwhile the app itself
 * legitimately opens two persistent SSE streams (/api/live) plus roughly a
 * dozen polling fetches the moment it loads. Chromium allows only 6
 * concurrent HTTP/1.1 connections per origin — so on a cold dev server the
 * SSE streams pin 2 slots forever while 4 slow first-compile requests pin
 * the rest, and every later page-initiated fetch (the Academy waitlist
 * POST, the demo-mode /api/recent fetch) queues in the browser
 * indefinitely. Trace files showed those requests never even left Chromium.
 * The features were fine; the cold-compile jam was the failure.
 *
 * Fix: run first (numeric filename order + workers:1, same convention as
 * the rest of the suite) and hit every route once through Playwright's
 * request fixture — which uses its own connection pool, immune to the
 * browser's 6-slot limit — so every module is compiled before any browser
 * test opens the app. Doubles as an honest smoke check that each route
 * actually answers.
 *
 * /api/live is deliberately NOT warmed: it's an infinite SSE stream, and a
 * request-fixture GET would block on the never-ending body. Its one-module
 * compile cost is absorbed fine mid-suite.
 *
 * POST-only routes are warmed with a GET: Next must load (= compile) the
 * module to discover its exports before it can answer 405, which is exactly
 * the side effect we want with zero state mutation. /api/reset especially
 * must NEVER be executed here — it wipes real state and its own spec
 * (06-master-reset) runs last for that reason.
 */

import { test, expect, type APIRequestContext, type APIResponse } from 'playwright/test';
import { authedPost } from './helpers';

/**
 * One warm request with retry on TRANSPORT errors only (ECONNRESET etc.) —
 * never on HTTP status codes, which the caller still asserts strictly.
 * Rationale: sequential warm requests with multi-second dev compiles between
 * them are the textbook trigger for the keep-alive close race (server.js now
 * holds sockets 65s, but a soak/dev server sharing this box can still starve
 * the event loop past any timeout). A retried request opens a fresh TCP
 * connection, which is exactly the recovery this failure mode needs.
 */
async function warmRequest(
  request: APIRequestContext,
  method: 'get' | 'post',
  route: string,
  data?: Record<string, unknown>,
): Promise<APIResponse> {
  const ATTEMPTS = 3;
  let lastErr: unknown;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return method === 'get' ? await request.get(route) : await request.post(route, { data });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Read-only GETs that must answer 200 with no params on a healthy install.
const CORE_GET_ROUTES = [
  '/api/intro',
  '/api/onboarding',
  '/api/onboarding/detect',
  '/api/system',
  '/api/weekly',
  '/api/insights',
  '/api/usage-window',
  '/api/usage-limits',
  '/api/spawned',
  '/api/agents',
  '/api/agents-live',
  '/api/recent-session',
  '/api/projects',
  '/api/projects/summary',
  '/api/tracks',
  '/api/playlists',
  '/api/brain',
  '/api/pet',
  '/api/quests',
  '/api/recent?limit=20',
  '/api/top-agents?range=alltime',
  '/api/kit/install',
  '/api/quickchat',
];

// Param-dependent GETs: warm the compile, accept any non-5xx answer (they
// may legitimately 400/404 without query params / a real file).
const WARM_ONLY_GET_ROUTES = ['/api/memory', '/api/projects/meta', '/api/projects/thumb', '/api/audio/warmup.mp3'];

// POST-only modules: a GET compiles the module and comes back 405.
const POST_ONLY_ROUTES = ['/api/reset', '/api/intro/reset', '/api/onboarding/reset', '/api/onboarding/inject'];

test.describe('Warm-up + API smoke', () => {
  // Cold dev server on a contended box: ~30 serial first-compiles can exceed
  // even the global 180s timeout. Sequential on purpose — dev compiles
  // serially anyway.
  test.setTimeout(480_000);

  test('the app page and every API route compile and answer', async ({ request, page }) => {
    // The page bundle is the single biggest cold compile (~10s+) — warm it
    // before any browser test pays that cost inside a navigationTimeout.
    const rootRes = await warmRequest(request, 'get', '/');
    expect(rootRes.status()).toBe(200);

    for (const route of CORE_GET_ROUTES) {
      const res = await warmRequest(request, 'get', route);
      expect(res.status(), `GET ${route}`).toBe(200);
    }

    // A fresh isolated profile uses the placeholder usage payload. Keep its
    // field names locked to WindowTotals so the dashboard never renders NaN.
    const usageRes = await warmRequest(request, 'get', '/api/usage-window');
    const usage = (await usageRes.json()) as {
      breakdown?: Record<string, { totalTokens: number; tokensIn: number; tokensOut: number; tokensCache: number }>;
    };
    for (const period of ['fiveHour', 'weekly', 'today']) {
      const split = usage.breakdown?.[period];
      expect(split, `usage breakdown.${period}`).toBeTruthy();
      for (const field of ['totalTokens', 'tokensIn', 'tokensOut', 'tokensCache'] as const) {
        expect(Number.isFinite(split?.[field]), `${period}.${field} is finite`).toBe(true);
      }
    }

    // Before onboarding connects a workspace, transcript-backed endpoints
    // must not inspect or expose the developer's real ~/.claude sessions.
    const liveAgentsRes = await warmRequest(request, 'get', '/api/agents-live');
    const liveAgents = (await liveAgentsRes.json()) as {
      running?: unknown[];
      recent?: unknown[];
      runningCount?: number;
      heroSession?: { working?: boolean; activity?: unknown; lastAssistantText?: unknown };
    };
    expect(liveAgents.running).toEqual([]);
    expect(liveAgents.recent).toEqual([]);
    expect(liveAgents.runningCount).toBe(0);
    expect(liveAgents.heroSession).toEqual({ working: false, activity: null, lastAssistantText: null });

    const recentSessionRes = await warmRequest(request, 'get', '/api/recent-session');
    expect(await recentSessionRes.json()).toEqual({ session: null });

    for (const route of WARM_ONLY_GET_ROUTES) {
      const res = await warmRequest(request, 'get', route);
      expect(res.status(), `GET ${route}`).toBeLessThan(500);
    }

    for (const route of POST_ONLY_ROUTES) {
      const res = await warmRequest(request, 'get', route);
      expect(res.status(), `GET ${route} (POST-only module)`).toBe(405);
    }

    // Compiles /api/waitlist AND pins the server-side EMAIL_RE contract
    // (src/app/api/waitlist/route.ts) directly — a malformed email is
    // rejected before the Supabase call is ever attempted, so this inserts
    // nothing anywhere. Auth header required: mutations without it are 401
    // by design (see server.js's mutation gate + e2e/helpers.ts authedPost).
    const bad = await authedPost(request, '/api/waitlist', { email: 'not-an-email-address' });
    expect(bad.status()).toBe(400);
    expect(((await bad.json()) as { error?: string }).error).toBe('Enter a valid email address.');

    // Finally: one REAL browser load. The request-fixture GET above compiled
    // the page server-side, but the suite's first full asset + WebGL boot in
    // an actual browser is its own one-time cost (observed >60s on this box
    // under soak load) — pay it here, inside this spec's generous budget,
    // instead of inside 01-boot's navigationTimeout.
    await page.goto('/', { waitUntil: 'load', timeout: 240_000 });
  });
});
