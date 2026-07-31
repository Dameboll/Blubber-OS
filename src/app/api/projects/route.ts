/**
 * GET /api/projects
 *
 * Lists immediate subdirectories of the four root folders the terminal
 * workflow already uses, for the TabBar folder switcher. Root paths are
 * derived from the home directory so they resolve correctly on any machine
 * while matching the exact fixed list in PLAN.md:
 *
 *   <home>\Development\ACTIVE\
 *   <home>\Development\HOBBY\
 *   <home>\Development\general\
 *   <home>\Development\research\
 *
 * Placeholder until connected: before the user's real ~/.claude workspace has
 * ever been connected (see src/server/connected-store.ts), GET returns the
 * bundled placeholder dataset's project names under a placeholder HOBBY root
 * instead of reading the real filesystem -- a fresh install's machine may not
 * have ACTIVE/HOBBY/general/research folders to list yet. POST (real folder
 * creation via scaffoldProject) is also gated on the same check -- a
 * not-yet-connected shell must never write a real folder to the host.
 */

import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { scaffoldProject } from "../../../server/project-scaffold";
import { isWorkspaceConnected } from "../../../server/connected-store";
import { getDemoProjectRoots } from "../../../server/demo-dataset";
import { getProjectRoots, type ProjectRootKind } from "../../../server/project-roots";

export const runtime = "nodejs";

export interface ProjectRoot {
  id: string;
  label: string;
  root: string;
  projects: string[];
  custom: boolean;
  kind: ProjectRootKind;
}

async function listSubdirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    // Root folder missing/unreadable — empty-state, not broken.
    console.error(`[api/projects] could not read ${root}:`, err);
    return [];
  }
}

export async function GET() {
  const workspaceConnected = isWorkspaceConnected();
  const registeredRoots = getProjectRoots();
  const visibleRoots = workspaceConnected
    ? registeredRoots
    : registeredRoots.filter((root) => root.custom);

  // Preserve the deliberate placeholder shell until the user either connects
  // onboarding OR explicitly chooses a custom projects folder. Adding a root
  // is itself clear consent to show real local folder names.
  if (!workspaceConnected && visibleRoots.length === 0) {
    return NextResponse.json({ roots: getDemoProjectRoots() });
  }

  const roots: ProjectRoot[] = await Promise.all(
    visibleRoots.map(async (definition) => {
      return {
        id: definition.id,
        label: definition.label,
        root: definition.path,
        custom: definition.custom,
        kind: definition.kind,
        projects:
          definition.kind === "project"
            ? [definition.label]
            : await listSubdirectories(definition.path),
      };
    })
  );

  return NextResponse.json({ roots });
}

/**
 * POST /api/projects  { root, name, template }  ->  { ok, root, name, path, agents }
 *
 * Creates a REAL new project folder (Item 7) under one of the four fixed roots
 * and scaffolds the chosen template. All validation + the path fence live in
 * scaffoldProject — this handler just shuttles the request through.
 *
 * Placeholder until connected: a not-yet-connected shell must never write to
 * the host filesystem, so this is gated on the same workspace-connected check
 * GET uses, before scaffoldProject (or any fs access) ever runs.
 */
export async function POST(request: Request) {
  if (!isWorkspaceConnected()) {
    return NextResponse.json(
      { ok: false, error: "Project creation is disabled until a workspace is connected" },
      { status: 403 }
    );
  }

  let body: { root?: string; name?: string; template?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const result = await scaffoldProject({
    root: body.root ?? "",
    name: body.name ?? "",
    template: body.template ?? "blank",
    createdISO: new Date().toISOString(),
  });

  if (!result.ok) {
    // "already exists" is a client-correctable conflict, the rest are bad input.
    const status = result.error === "a folder with that name already exists" ? 409 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
