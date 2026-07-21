// POST /api/reset
//
// The Settings "master reset" — zeros the entire dashboard back to 0 "fresh
// out the box". It does NOT delete your ~/.claude history; it moves the stats
// baseline to now, so every real number (tokens, agent/skill runs, activity
// feed, usage charts) starts counting from this moment. Also zeros today's
// live token counter and resets the virtual pet to a brand-new Blubber.
//
// POST-only (state-changing). After a 200 the client reloads so every screen
// refetches and shows zero.

import { NextResponse } from "next/server";
import { resetStatsBaseline } from "../../../server/db";
import { resetPet } from "../../../server/pet-store";
import { resetQuests } from "../../../server/quest-store";
import { liveUsageWatcher } from "../../../server/live-usage-watcher";
import * as spawnedStore from "../../../server/spawned-store";
import * as brainStore from "../../../server/brain-store";
import { resetOnboardingState } from "../../../server/onboarding-store";
import { resetIntroState } from "../../../server/intro-store";
import { resetKitInstallState } from "../../../server/kit-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const baseline = resetStatsBaseline();
    liveUsageWatcher.reset();
    resetPet();
    // Quest claim state must reset with the baseline: quest targets are measured
    // against the (now-zeroed) baseline, so leaving high-tier quests marked
    // claimed would let adventure XP drift above the real metrics. Clearing
    // claims keeps quest-store's "claim state can never drift" invariant true.
    resetQuests();
    spawnedStore.clear();
    brainStore.reset();
    // First-run gates + kit-install record — master reset puts the machine
    // back to "fresh out the box", which includes replaying onboarding/intro
    // and forgetting the starter-kit install, not just the usage numbers.
    resetOnboardingState();
    resetIntroState();
    resetKitInstallState();
    return NextResponse.json({ ok: true, baseline });
  } catch (err) {
    console.error("[api/reset] reset failed:", err);
    return NextResponse.json({ ok: false, error: "reset failed" }, { status: 500 });
  }
}
