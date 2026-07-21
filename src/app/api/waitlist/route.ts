// POST /api/waitlist  { email: string }  →  { ok: true }
//
// Backs the Blubber Academy waitlist form (Lane B3). Basic server-side email
// shape validation only — no verification email, no payment, no real course
// content yet. Malformed input is rejected with a clear 400 message; a
// duplicate (already-subscribed) email is a graceful success, never an error.
//
// Cloud-first: forwards to the `waitlist-signup` Supabase Edge Function
// (supabase/functions/waitlist-signup) so every install's signups land in one
// real, shared table Dame can actually see — not a per-machine SQLite file
// (the old behavior, kept only as an offline/local-dev fallback below).
//
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are safe to expose
// (the anon key is meant to be public — see .env.example). If they're not
// configured yet, or the request fails (offline, cloud outage), we fall back
// to the local SQLite store so the user never sees a hard failure — but that
// fallback is logged loudly since it means this signup is NOT visible to Dame
// until the machine comes back online and this route is retried.

import { NextResponse } from 'next/server';
import { addWaitlistEmail } from '../../../server/waitlist-store';

// May fall back to a local SQLite file — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function signupViaSupabase(email: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.warn('[api/waitlist] Supabase env vars missing — using local SQLite fallback only.');
    return false;
  }

  try {
    const res = await fetch(`${url}/functions/v1/waitlist-signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      console.error('[api/waitlist] Supabase signup failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[api/waitlist] Supabase signup request threw:', err);
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }

    const cloudOk = await signupViaSupabase(email);
    if (!cloudOk) {
      console.warn('[api/waitlist] falling back to local SQLite for:', email);
      addWaitlistEmail(email);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/waitlist] POST failed:', err);
    return NextResponse.json({ error: 'Failed to join the waitlist' }, { status: 500 });
  }
}
