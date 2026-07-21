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
 * Demo Mode: when the `blubber_demo` cookie is set (see src/lib/demo-mode.ts),
 * GET returns the bundled demo dataset's project names under a placeholder
 * HOBBY root instead of reading the real filesystem -- a demo visitor's
 * machine has no ACTIVE/HOBBY/general/research folders to list. POST (real
 * folder creation via scaffoldProject) is also gated on the same cookie --
 * a demo visitor must never be able to create a real folder on the host.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { scaffoldProject } from "../../../server/project-scaffold";
import { isDemoModeRequest } from "../../../lib/demo-mode";
import { getDemoProjectRoots } from "../../../server/demo-dataset";

export const runtime = "nodejs";

export interface ProjectRoot {
  label: string;
  root: string;
  projects: string[];
}

const ROOT_LABELS = ["ACTIVE", "HOBBY", "general", "research"] as const;

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

export async function GET(request: Request) {
  if (isDemoModeRequest(request)) {
    return NextResponse.json({ roots: getDemoProjectRoots() });
  }

  const devRoot = path.join(os.homedir(), "Development");

  const roots: ProjectRoot[] = await Promise.all(
    ROOT_LABELS.map(async (label) => {
      const root = path.join(devRoot, label);
      return {
        label,
        root,
        projects: await listSubdirectories(root),
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
 * Demo Mode: a demo visitor must never be able to write to the host
 * filesystem, so this is gated on the same `blubber_demo` cookie check GET
 * uses, before scaffoldProject (or any fs access) ever runs.
 */
export async function POST(request: Request) {
  if (isDemoModeRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Project creation is disabled in Demo Mode" },
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
