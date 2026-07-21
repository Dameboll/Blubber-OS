// POST /functions/v1/waitlist-signup   { email: string }  ->  { ok: true }
//
// Cloud replacement for the old local-SQLite-only waitlist. Called from the
// desktop app's own /api/waitlist route (see src/app/api/waitlist/route.ts in
// the main repo), and safe to call directly from any future public web page
// too — the anon key is meant to be public, this function is the only thing
// that can write to the `waitlist` table with it in practice.
//
// Uses the service-role client internally (simpler than relying solely on
// the anon INSERT RLS policy, and lets us do a clean upsert-style dedup here)
// rather than the caller's own session — this function IS the trust boundary.

import { corsHeaders, handleOptions } from '../_shared/cors.ts';
import { supabaseAdmin } from '../_shared/supabase-admin.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }

  const supabase = supabaseAdmin();

  // INSERT ... ON CONFLICT DO NOTHING via the unique lower(email) index —
  // a resubmit of the same address is a graceful success, never an error,
  // and never creates a second row (can't be spam-grown by repeats).
  const { error } = await supabase
    .from('waitlist')
    .upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });

  if (error) {
    console.error('[waitlist-signup] insert failed:', error.message);
    return json({ error: 'Failed to join the waitlist' }, 500);
  }

  return json({ ok: true });
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
