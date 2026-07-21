// POST /functions/v1/request-otp   { email: string }  ->  { ok: true }
//
// Entitlement-gated login: only an email that already has a row in
// `entitlements` (i.e. bought "Starter Kit" or "All Access" via Shopify) can
// request a code. Always responds { ok: true } for any well-formed email —
// never reveals whether an address is entitled, to avoid leaking the
// purchaser list to anyone probing the endpoint.

import { corsHeaders, handleOptions } from '../_shared/cors.ts';
import { supabaseAdmin } from '../_shared/supabase-admin.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MINUTES = 10;
const RESEND_FROM = Deno.env.get('RESEND_FROM_EMAIL') ?? 'Blubber OS <noreply@blubber-os.app>';

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
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }

  const supabase = supabaseAdmin();

  const { data: entitlement } = await supabase
    .from('entitlements')
    .select('id')
    .eq('email', email)
    .limit(1)
    .maybeSingle();

  // Always return ok:true regardless of match — do not leak entitlement status.
  if (!entitlement) {
    return json({ ok: true });
  }

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

  const { error } = await supabase.from('otp_codes').insert({
    email,
    code,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[request-otp] insert failed:', error.message);
    return json({ error: 'Failed to generate code' }, 500);
  }

  const sent = await sendOtpEmail(email, code);
  if (!sent) {
    // Code exists in the DB even if the email failed to send — do not lie
    // about success. The caller should show a real error, not a fake "check
    // your inbox" if RESEND_API_KEY is missing or the send failed.
    return json({ error: 'Could not send the code email. Try again shortly.' }, 502);
  }

  return json({ ok: true });
});

function generateOtp(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/**
 * Sends the OTP via Resend. Returns false (never throws) if RESEND_API_KEY
 * is missing or the API call fails — the caller decides how to surface that.
 *
 * SETUP DAME STILL NEEDS TO DO: set the real key with
 *   supabase secrets set RESEND_API_KEY=re_xxx --project-ref <project-ref>
 * No key is fabricated here — without it this function cleanly fails closed.
 */
async function sendOtpEmail(email: string, code: string): Promise<boolean> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    console.error('[request-otp] RESEND_API_KEY is not set — cannot send OTP email.');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: `Your Blubber OS code: ${code}`,
        text: `Your login code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
      }),
    });
    if (!res.ok) {
      console.error('[request-otp] Resend API error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[request-otp] Resend request threw:', err);
    return false;
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
