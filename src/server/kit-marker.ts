// kit-marker — a real, filesystem receipt that the Starter Kit was injected on
// this machine. Written into ~/.claude/.blubber-kit.json when the kit installs.
//
// Why a file and not just the SQLite flag (kit-store.ts): onboarding's detection
// step is a literal filesystem scan of ~/.claude (see onboarding/detect) — "is
// Claude Code here?" — and Dame's model is that the SAME scan also looks for the
// Starter Kit and, if it finds it, triggers the guided walkthrough. A file
// dropped alongside CLAUDE.md/agents/skills is the honest thing to scan for: it
// lives WITH the kit's own installed files, survives the app's own DB being
// reset, and would still be found if the kit were placed by any means other
// than this app's installer. Pure fs, no DB import — safe for the detect route
// to use without pulling in the SQLite singleton.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KIT_MARKER_FILENAME = ".blubber-kit.json";

export interface KitMarker {
  kitVersion: string;
  kitName: string;
  installedAt: string;
}

function markerPath(): string {
  return path.join(os.homedir(), ".claude", KIT_MARKER_FILENAME);
}

/** Drop the receipt next to the kit's installed files. Best-effort: the kit
 * install itself already succeeded before this runs, so a marker-write failure
 * is logged by the caller, not fatal. */
export function writeKitMarker(marker: KitMarker): void {
  const dir = path.join(os.homedir(), ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(markerPath(), JSON.stringify(marker, null, 2), "utf8");
}

/** Read the receipt, or null if the kit was never injected here. Never throws —
 * an unreadable/corrupt marker reads as "no kit" rather than crashing the scan. */
export function readKitMarker(): KitMarker | null {
  try {
    const raw = fs.readFileSync(markerPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<KitMarker>;
    if (typeof parsed.kitVersion === "string" && typeof parsed.installedAt === "string") {
      return {
        kitVersion: parsed.kitVersion,
        kitName: typeof parsed.kitName === "string" ? parsed.kitName : "Starter Kit",
        installedAt: parsed.installedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** The scan itself: is the Starter Kit present on this machine? */
export function hasKitMarker(): boolean {
  return readKitMarker() !== null;
}

/** Remove the receipt (master-reset flows). */
export function removeKitMarker(): void {
  try {
    fs.rmSync(markerPath(), { force: true });
  } catch {
    /* already gone */
  }
}
