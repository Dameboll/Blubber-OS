// GET  /api/kit/install -> { installed: boolean, installedAt: string | null }
// POST /api/kit/install { kitPath: string } -> KitInstallResult
//
// The Starter Kit importer's install mechanism (Lane B8). Real payment /
// entitlement verification (Shopify + Supabase) is a LATER stage — this
// route assumes the caller already has a legitimately-downloaded, extracted
// kit folder sitting on disk and just points at it with `kitPath`.
//
// What POST actually does, in order, each step independently reported so a
// failure never gets swallowed into a generic "install failed":
//   1. read + validate {kitPath}/kit-manifest.json against the real schema
//      (see the reference kit at HOBBY/blubber-kit/kit/kit-manifest.json —
//      NOT copied into this repo, read-only reference)
//   2. copy claudeMdSource -> ~/.claude/CLAUDE.md
//   3. copy agentsSource/  -> ~/.claude/agents/
//   4. copy skillsSource/  -> ~/.claude/skills/
//   5. copy commandsSource/-> ~/.claude/commands/
//   6. create projectStructure.subfolders under a portable Development-root
//      path (see developmentRoot() below)
//
// A failed step returns 400/500 immediately with `step` naming exactly which
// one failed and `stepsCompleted` listing everything that genuinely finished
// before it — later steps never run once one has failed. On full success,
// kit-store.markKitInstalled() records the real install timestamp and the
// response echoes the manifest's own `narration` object back to the caller
// so the client renders Dame's copy, not a hardcoded string baked in here.
//
// DELIBERATE SCOPE NOTES (see INTEGRATION REPORT for the full write-up):
//   - guidesSource is part of the validated manifest shape but has no
//     install destination in this pass (the reference manifest's own
//     installTargets has no `guides` key either) — never copied.
//   - Destinations are hardcoded to the canonical ~/.claude + Development
//     paths this codebase already uses everywhere else (see developmentRoot()
//     and project-scaffold.ts's identical `devRoot`), NOT read from the
//     manifest's own installTargets strings (which are closer to
//     human-readable documentation, e.g. "~/Projects/", than to a path this
//     process should blindly trust/expand).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { markKitInstalled, hasInstalledKit, getKitInstalledAt } from "../../../../server/kit-store";
import { writeKitMarker } from "../../../../server/kit-marker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type KitStep = "manifest" | "claudeMd" | "agents" | "skills" | "commands" | "structure";

interface KitNarration {
  onInstallStart: string;
  onClaudeMdInstalled: string;
  onAgentsInstalled: string;
  onSkillsInstalled: string;
  onCommandsInstalled: string;
  onStructureCreated: string;
  onComplete: string;
}

interface KitManifest {
  kitVersion?: string;
  kitName?: string;
  claudeMdSource: string;
  agentsSource: string;
  skillsSource: string;
  commandsSource: string;
  guidesSource: string;
  projectStructure: {
    rootFolderName: string;
    subfolders: string[];
    sourcePath?: string;
    description?: string;
  };
  installTargets: Record<string, string>;
  narration: KitNarration;
}

const REQUIRED_TOP_LEVEL_KEYS = [
  "claudeMdSource",
  "agentsSource",
  "skillsSource",
  "commandsSource",
  "guidesSource",
  "projectStructure",
  "installTargets",
  "narration",
] as const;

const REQUIRED_NARRATION_KEYS: (keyof KitNarration)[] = [
  "onInstallStart",
  "onClaudeMdInstalled",
  "onAgentsInstalled",
  "onSkillsInstalled",
  "onCommandsInstalled",
  "onStructureCreated",
  "onComplete",
];

type ManifestValidation = { ok: true; manifest: KitManifest } | { ok: false; error: string };

/** Confirms the parsed JSON actually matches the real kit-manifest.json
 * shape (top-level keys + the nested projectStructure/narration shapes)
 * before any file is touched. Returns a specific, actionable error string —
 * never a generic "invalid manifest". */
function validateManifest(raw: unknown): ManifestValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "kit-manifest.json is not a valid JSON object" };
  }
  const m = raw as Record<string, unknown>;

  const missingTop = REQUIRED_TOP_LEVEL_KEYS.filter((key) => !(key in m));
  if (missingTop.length > 0) {
    return { ok: false, error: `kit-manifest.json is missing required key(s): ${missingTop.join(", ")}` };
  }

  if (
    typeof m.claudeMdSource !== "string" ||
    typeof m.agentsSource !== "string" ||
    typeof m.skillsSource !== "string" ||
    typeof m.commandsSource !== "string" ||
    typeof m.guidesSource !== "string"
  ) {
    return {
      ok: false,
      error: "claudeMdSource, agentsSource, skillsSource, commandsSource, and guidesSource must all be strings",
    };
  }

  const ps = m.projectStructure as Record<string, unknown> | null;
  if (!ps || typeof ps !== "object" || typeof ps.rootFolderName !== "string" || !Array.isArray(ps.subfolders)) {
    return {
      ok: false,
      error: "projectStructure must be an object with a string rootFolderName and an array subfolders",
    };
  }
  if (!ps.subfolders.every((s) => typeof s === "string")) {
    return { ok: false, error: "projectStructure.subfolders must all be strings" };
  }

  if (!m.installTargets || typeof m.installTargets !== "object" || Array.isArray(m.installTargets)) {
    return { ok: false, error: "installTargets must be an object" };
  }

  const narration = m.narration as Record<string, unknown> | null;
  if (!narration || typeof narration !== "object") {
    return { ok: false, error: "narration must be an object" };
  }
  const missingNarration = REQUIRED_NARRATION_KEYS.filter((key) => typeof narration[key] !== "string");
  if (missingNarration.length > 0) {
    return { ok: false, error: `narration is missing required string key(s): ${missingNarration.join(", ")}` };
  }

  return { ok: true, manifest: raw as KitManifest };
}

/** Mirrors the exact os.homedir()-based "Development root" pattern already
 * used by log-indexer.ts's `DEV_ROOT` and project-scaffold.ts's `devRoot` —
 * never a hardcoded personal path, and never re-derived differently here. */
function developmentRoot(): string {
  return path.join(os.homedir(), "Development");
}

function claudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

/** Every failure path returns the same honest shape: which step failed, what
 * had already genuinely completed before it, and a specific message — never
 * a generic "install failed". `narration` is included whenever the manifest
 * was already validated by that point, so the client can still show real
 * narration lines for the steps that DID finish before the failure. */
function stepError(
  step: KitStep,
  stepsCompleted: KitStep[],
  error: string,
  status: number,
  narration?: KitNarration,
) {
  return NextResponse.json({ ok: false, step, stepsCompleted, error, narration: narration ?? null }, { status });
}

export async function GET() {
  return NextResponse.json({ installed: hasInstalledKit(), installedAt: getKitInstalledAt() });
}

export async function POST(request: Request) {
  let kitPath: string;
  try {
    const body = (await request.json()) as { kitPath?: string };
    if (!body.kitPath || typeof body.kitPath !== "string" || !body.kitPath.trim()) {
      return stepError("manifest", [], "kitPath is required", 400);
    }
    kitPath = body.kitPath.trim();
  } catch {
    return stepError("manifest", [], "invalid request body", 400);
  }

  const manifestPath = path.join(kitPath, "kit-manifest.json");
  let manifest: KitManifest;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const validated = validateManifest(raw);
    if (!validated.ok) {
      return stepError("manifest", [], validated.error, 400);
    }
    manifest = validated.manifest;
  } catch (err) {
    return stepError(
      "manifest",
      [],
      `could not read kit-manifest.json at ${manifestPath}: ${(err as Error).message}`,
      400,
    );
  }

  const stepsCompleted: KitStep[] = [];

  // Step 1 — CLAUDE.md
  try {
    const src = path.join(kitPath, manifest.claudeMdSource);
    const dest = path.join(claudeDir(), "CLAUDE.md");
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.copyFileSync(src, dest);
    stepsCompleted.push("claudeMd");
  } catch (err) {
    return stepError(
      "claudeMd",
      stepsCompleted,
      `failed to install CLAUDE.md: ${(err as Error).message}`,
      500,
      manifest.narration,
    );
  }

  // Step 2 — agents/
  try {
    const src = path.join(kitPath, manifest.agentsSource);
    const dest = path.join(claudeDir(), "agents");
    fs.cpSync(src, dest, { recursive: true });
    stepsCompleted.push("agents");
  } catch (err) {
    return stepError(
      "agents",
      stepsCompleted,
      `failed to install agents: ${(err as Error).message}`,
      500,
      manifest.narration,
    );
  }

  // Step 3 — skills/
  try {
    const src = path.join(kitPath, manifest.skillsSource);
    const dest = path.join(claudeDir(), "skills");
    fs.cpSync(src, dest, { recursive: true });
    stepsCompleted.push("skills");
  } catch (err) {
    return stepError(
      "skills",
      stepsCompleted,
      `failed to install skills: ${(err as Error).message}`,
      500,
      manifest.narration,
    );
  }

  // Step 4 — commands/  (the kit's slash-commands, e.g. /landing-page,
  // /ship-check). Copied to ~/.claude/commands/ so Claude Code picks them up
  // as user-scoped slash commands exactly like agents/skills above.
  try {
    const src = path.join(kitPath, manifest.commandsSource);
    const dest = path.join(claudeDir(), "commands");
    fs.cpSync(src, dest, { recursive: true });
    stepsCompleted.push("commands");
  } catch (err) {
    return stepError(
      "commands",
      stepsCompleted,
      `failed to install commands: ${(err as Error).message}`,
      500,
      manifest.narration,
    );
  }

  // Step 5 — projectStructure folders, under the same portable Development
  // root every other real filesystem feature in this codebase already uses.
  try {
    const structureRoot = path.join(developmentRoot(), manifest.projectStructure.rootFolderName);
    fs.mkdirSync(structureRoot, { recursive: true });
    for (const sub of manifest.projectStructure.subfolders) {
      if (!sub.trim()) continue;
      fs.mkdirSync(path.join(structureRoot, sub), { recursive: true });
    }
    stepsCompleted.push("structure");
  } catch (err) {
    return stepError(
      "structure",
      stepsCompleted,
      `failed to create project structure: ${(err as Error).message}`,
      500,
      manifest.narration,
    );
  }

  markKitInstalled();

  // Drop the filesystem receipt next to the installed kit files so onboarding's
  // ~/.claude scan can DETECT the Starter Kit (and fire the walkthrough), not
  // just read this app's own DB flag. Best-effort — the install already fully
  // succeeded above; a marker-write hiccup shouldn't fail the whole install.
  try {
    writeKitMarker({
      kitVersion: manifest.kitVersion ?? "unknown",
      kitName: manifest.kitName ?? "Starter Kit",
      installedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[api/kit/install] kit marker write failed (install still succeeded):", err);
  }

  return NextResponse.json({
    ok: true,
    stepsCompleted,
    narration: manifest.narration,
    installedTo: {
      claudeMd: path.join(claudeDir(), "CLAUDE.md"),
      agents: path.join(claudeDir(), "agents"),
      skills: path.join(claudeDir(), "skills"),
      commands: path.join(claudeDir(), "commands"),
      projectStructure: path.join(developmentRoot(), manifest.projectStructure.rootFolderName),
    },
  });
}
