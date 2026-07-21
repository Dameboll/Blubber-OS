// GET  /api/onboarding  → { seen: boolean } — has the first-run "Meet Blubber"
//                         overlay already been completed on this machine?
// POST /api/onboarding  → marks onboarding as seen, returns { ok: true }.
//
// Backed by src/server/onboarding-store.ts's single app_meta row. Community
// Edition ships with zero built-in help content, so this overlay is the
// entire onboarding experience — page.tsx checks GET on mount and renders
// OnboardingOverlay full-screen when seen is false (see that component).

import { NextResponse } from 'next/server';
import { hasSeenOnboarding, markOnboardingSeen } from '../../../server/onboarding-store';

// Touches local SQLite — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({ seen: hasSeenOnboarding() });
  } catch (err) {
    console.error('[api/onboarding] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read onboarding state' }, { status: 500 });
  }
}

export async function POST() {
  try {
    markOnboardingSeen();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/onboarding] POST failed:', err);
    return NextResponse.json({ ok: false, error: 'Failed to update onboarding state' }, { status: 500 });
  }
}
