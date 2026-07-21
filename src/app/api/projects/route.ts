/**
 * GET /api/projects
 *
 * Lists immediate subdirectories of the four root folders Dame's terminal
 * workflow already uses, for the TabBar folder switcher. Root paths are
 * derived from the home directory so they resolve correctly on this machine
 * while matching the exact fixed list in PLAN.md:
 *
 *   C:\Users\jeffh\Development\ACTIVE\
 *   C:\Users\jeffh\Development\HOBBY\
 *   C:\Users\jeffh\Development\general\
 *   C:\Users\jeffh\Development\research\
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { scaffoldProject } from "../../../server/project-scaffold";

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

export async function GET() {
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
 */
export async function POST(request: Request) {
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
