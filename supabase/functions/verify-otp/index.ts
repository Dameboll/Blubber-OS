// POST /functions/v1/verify-otp   { email: string, code: string }
//   -> { ok: true, product: 'starter_kit' | 'all_access' }
//   -> { ok: false, error: string }
//
// Checks the submitted code against the most recent unexpired, unused code
// for that email, marks it used on success, and returns the entitled
// product tier so the desktop app knows what to unlock.

import { corsHeaders, handleOptions } from '../_shared/cors.ts';
import { supabaseAdmin } from '../_shared/supabase-admin.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: { email?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';

  if (!email || !EMAIL_RE.test(email) || !CODE_RE.test(code)) {
    return json({ ok: false, error: 'Enter the 6-digit code sent to your email.' }, 400);
  }

  const supabase = supabaseAdmin();

  const { data: otpRow, error: otpError } = await supabase
    .from('otp_codes')
    .select('id, code, expires_at, used')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (otpError) {
    console.error('[verify-otp] lookup failed:', otpError.message);
    return json({ ok: false, error: 'Could not verify code. Try again.' }, 500);
  }

  const isValid =
    otpRow && !otpRow.used && otpRow.code === code && new Date(otpRow.expires_at).getTime() > Date.now();

  if (!isValid) {
    return json({ ok: false, error: 'That code is invalid or expired.' }, 401);
  }

  await supabase.from('otp_codes').update({ used: true }).eq('id', otpRow.id);

  const { data: entitlement, error: entError } = await supabase
    .from('entitlements')
    .select('product')
    .eq('email', email)
    .order('granted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (entError || !entitlement) {
    console.error('[verify-otp] no entitlement found after valid code for', email);
    return json({ ok: false, error: 'No active entitlement found for this email.' }, 403);
  }

  return json({ ok: true, product: entitlement.product });
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
