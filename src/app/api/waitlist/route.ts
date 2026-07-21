// POST /api/waitlist  { email: string }  →  { ok: true }
//
// Backs the Blubber Academy waitlist form (Lane B3). Basic server-side email
// shape validation only — no verification email, no payment, no real course
// content yet. Malformed input is rejected with a clear 400 message; a
// duplicate (already-subscribed) email is a graceful success, never an error
// (see src/server/waitlist-store.ts).

import { NextResponse } from 'next/server';
import { addWaitlistEmail } from '../../../server/waitlist-store';

// Touches a local SQLite file — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }

    const result = addWaitlistEmail(email);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/waitlist] POST failed:', err);
    return NextResponse.json({ error: 'Failed to join the waitlist' }, { status: 500 });
  }
}
