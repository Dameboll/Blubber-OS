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
import { writeKitMarker, readKitMarker } from "../../../../server/kit-marker";

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

/**
 * Join `relative` under `base` ONLY if the result stays inside `base`.
 * Rejects absolute paths and any ".." traversal — a tampered manifest must
 * never be able to read from or write to anywhere outside its own kit
 * folder / the intended destination tree. Returns null on violation.
 */
function containedJoin(base: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, relative);
  const rel = path.relative(resolvedBase, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Top-level entries of a source dir that already exist in dest — these are
 * the customer's own files the copy would overwrite. */
function findConflicts(srcDir: string, destDir: string): string[] {
  if (!fs.existsSync(srcDir) || !fs.existsSync(destDir)) return [];
  const destNames = new Set(fs.readdirSync(destDir));
  return fs.readdirSync(srcDir).filter((name) => destNames.has(name));
}

interface BackupPlan {
  backupDir: string;
  /** dest path -> backup path, for exact restore */
  entries: Array<{ original: string; saved: string }>;
}

/** Copy every file/folder the install would overwrite into a timestamped
 * backup folder BEFORE the first write. Throws on any failure — the caller
 * must treat that as a hard abort with nothing yet modified. */
function backupConflicts(
  claudeMdConflict: boolean,
  dirConflicts: Array<{ destDir: string; label: string; names: string[] }>,
): BackupPlan {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(claudeDir(), `.blubber-kit-backup-${stamp}`);
  const entries: BackupPlan["entries"] = [];
  fs.mkdirSync(backupDir, { recursive: true });

  if (claudeMdConflict) {
    const original = path.join(claudeDir(), "CLAUDE.md");
    const saved = path.join(backupDir, "CLAUDE.md");
    fs.copyFileSync(original, saved);
    entries.push({ original, saved });
  }
  for (const { destDir, label, names } of dirConflicts) {
    for (const name of names) {
      const original = path.join(destDir, name);
      const saved = path.join(backupDir, label, name);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.cpSync(original, saved, { recursive: true });
      entries.push({ original, saved });
    }
  }
  return { backupDir, entries };
}

/** Put every backed-up original back over whatever a failed install left
 * behind. Best-effort per entry; reports whether everything went back. */
function restoreBackup(plan: BackupPlan): boolean {
  let allRestored = true;
  for (const { original, saved } of plan.entries) {
    try {
      fs.cpSync(saved, original, { recursive: true, force: true });
    } catch (err) {
      allRestored = false;
      console.error(`[api/kit/install] restore failed for ${original}:`, err);
    }
  }
  return allRestored;
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
  // Source of truth for "is the Starter Kit on this machine" is the filesystem
  // marker (~/.claude/.blubber-kit.json), not just this app's SQLite flag: the
  // marker lives WITH the installed kit files, survives the app's own DB being
  // reset/re-created (a fresh packaged install has an empty DB), and is what the
  // onboarding scan already keys off. So a marker present == kit installed, even
  // if this install's DB never recorded the flag. Fall back to the DB flag when
  // there's no marker (older installs that predate the marker write).
  const marker = readKitMarker();
  const installed = marker !== null || hasInstalledKit();
  const installedAt = marker?.installedAt ?? getKitInstalledAt();
  return NextResponse.json({ installed, installedAt });
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

  // --- VALIDATE EVERYTHING BEFORE WRITING ANYTHING -------------------------
  // Path containment (a tampered manifest can't escape the kit folder or the
  // destination trees) + source existence, all checked up front so a bad kit
  // aborts with the customer's machine completely untouched.
  const claudeMdSrc = containedJoin(kitPath, manifest.claudeMdSource);
  const agentsSrc = containedJoin(kitPath, manifest.agentsSource);
  const skillsSrc = containedJoin(kitPath, manifest.skillsSource);
  const commandsSrc = containedJoin(kitPath, manifest.commandsSource);
  if (!claudeMdSrc || !agentsSrc || !skillsSrc || !commandsSrc) {
    return stepError(
      "manifest",
      [],
      "manifest source paths must be relative paths inside the kit folder (no absolute paths, no '..')",
      400,
    );
  }
  const structureRoot = containedJoin(developmentRoot(), manifest.projectStructure.rootFolderName);
  if (!structureRoot) {
    return stepError(
      "manifest",
      [],
      "projectStructure.rootFolderName must be a plain folder name (no absolute paths, no '..')",
      400,
    );
  }
  for (const sub of manifest.projectStructure.subfolders) {
    if (sub.trim() && !containedJoin(structureRoot, sub)) {
      return stepError(
        "manifest",
        [],
        `projectStructure subfolder "${sub}" escapes the project root (no absolute paths, no '..')`,
        400,
      );
    }
  }
  const missingSources = [
    { label: "claudeMdSource", p: claudeMdSrc },
    { label: "agentsSource", p: agentsSrc },
    { label: "skillsSource", p: skillsSrc },
    { label: "commandsSource", p: commandsSrc },
  ].filter(({ p }) => !fs.existsSync(p));
  if (missingSources.length > 0) {
    return stepError(
      "manifest",
      [],
      `kit is missing source file(s)/folder(s): ${missingSources.map((s) => s.label).join(", ")}`,
      400,
    );
  }

  // --- CONFLICT SCAN + BACKUP BEFORE FIRST WRITE ---------------------------
  // Everything the copy would overwrite (the customer's own CLAUDE.md,
  // same-name agents/skills/commands) is copied into a timestamped backup
  // folder first. Backup failure = hard abort with nothing modified; any
  // later write failure auto-restores every backed-up original.
  const claudeMdDest = path.join(claudeDir(), "CLAUDE.md");
  const dirConflicts = [
    { destDir: path.join(claudeDir(), "agents"), label: "agents", names: findConflicts(agentsSrc, path.join(claudeDir(), "agents")) },
    { destDir: path.join(claudeDir(), "skills"), label: "skills", names: findConflicts(skillsSrc, path.join(claudeDir(), "skills")) },
    { destDir: path.join(claudeDir(), "commands"), label: "commands", names: findConflicts(commandsSrc, path.join(claudeDir(), "commands")) },
  ];
  const claudeMdConflict = fs.existsSync(claudeMdDest);
  const hasConflicts = claudeMdConflict || dirConflicts.some((d) => d.names.length > 0);

  let backup: BackupPlan | null = null;
  if (hasConflicts) {
    try {
      backup = backupConflicts(claudeMdConflict, dirConflicts);
    } catch (err) {
      return stepError(
        "manifest",
        [],
        `could not back up your existing Claude files, so nothing was installed: ${(err as Error).message}`,
        500,
        manifest.narration,
      );
    }
  }

  const stepsCompleted: KitStep[] = [];

  /** Shared failure path for the write steps: restore every backed-up
   * original, then report both the failure and the restore outcome. */
  const failAndRestore = (step: KitStep, message: string) => {
    const restored = backup ? restoreBackup(backup) : true;
    return stepError(
      step,
      stepsCompleted,
      `${message}${backup ? (restored ? " Your previous Claude files were restored from backup." : ` Restore was incomplete — your originals are preserved in ${backup.backupDir}.`) : ""}`,
      500,
      manifest.narration,
    );
  };

  // Step 1 — CLAUDE.md
  try {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    stepsCompleted.push("claudeMd");
  } catch (err) {
    return failAndRestore("claudeMd", `failed to install CLAUDE.md: ${(err as Error).message}.`);
  }

  // Step 2 — agents/
  try {
    fs.cpSync(agentsSrc, path.join(claudeDir(), "agents"), { recursive: true });
    stepsCompleted.push("agents");
  } catch (err) {
    return failAndRestore("agents", `failed to install agents: ${(err as Error).message}.`);
  }

  // Step 3 — skills/
  try {
    fs.cpSync(skillsSrc, path.join(claudeDir(), "skills"), { recursive: true });
    stepsCompleted.push("skills");
  } catch (err) {
    return failAndRestore("skills", `failed to install skills: ${(err as Error).message}.`);
  }

  // Step 4 — commands/  (the kit's slash-commands, e.g. /landing-page,
  // /ship-check). Copied to ~/.claude/commands/ so Claude Code picks them up
  // as user-scoped slash commands exactly like agents/skills above.
  try {
    fs.cpSync(commandsSrc, path.join(claudeDir(), "commands"), { recursive: true });
    stepsCompleted.push("commands");
  } catch (err) {
    return failAndRestore("commands", `failed to install commands: ${(err as Error).message}.`);
  }

  // Step 5 — projectStructure folders, under the same portable Development
  // root every other real filesystem feature in this codebase already uses.
  try {
    fs.mkdirSync(structureRoot, { recursive: true });
    for (const sub of manifest.projectStructure.subfolders) {
      if (!sub.trim()) continue;
      const subPath = containedJoin(structureRoot, sub);
      if (subPath) fs.mkdirSync(subPath, { recursive: true });
    }
    stepsCompleted.push("structure");
  } catch (err) {
    return failAndRestore("structure", `failed to create project structure: ${(err as Error).message}.`);
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
    // Honest overwrite report: what customer files the install replaced, and
    // where the pre-install originals live. Empty/null on a clean machine.
    conflicts: {
      claudeMd: claudeMdConflict,
      agents: dirConflicts[0].names,
      skills: dirConflicts[1].names,
      commands: dirConflicts[2].names,
    },
    backupDir: backup?.backupDir ?? null,
    installedTo: {
      claudeMd: claudeMdDest,
      agents: path.join(claudeDir(), "agents"),
      skills: path.join(claudeDir(), "skills"),
      commands: path.join(claudeDir(), "commands"),
      projectStructure: structureRoot,
    },
  });
}
