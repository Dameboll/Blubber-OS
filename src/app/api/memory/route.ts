// GET /api/memory[?root=<ACTIVE|HOBBY|general|research>&name=<folder>]
//
// The one real read behind the Memory screen (LANE G, docs/plans/
// idle-life-and-wiring.md). Honest sources only, nothing invented.
//
//   identity — the OWNER'S OWN creed, read straight from the global identity
//              markdown their system already keeps. This is who the owner is /
//              what they stand for, NOT a contacts list:
//                fields  — the identity key:value lines of ~/.claude/USER.md
//                          (name, mission, family, background, how they work).
//                          Pure-technical / other-people lines (Stack, Active
//                          ventures, Key contacts) are filtered out.
//                beliefs — the bullet lines of ~/.claude/PERSONA.md (their top
//                          beliefs / morals, strongest floated to top).
//                creed   — the mantra paragraphs of ~/.claude/SOUL.md (the
//                          system identity: what the system is, what they're
//                          building, the mission). Curated to the creed
//                          sections, faithful to the file, never a raw dump.
//              `identity` is null only when ALL THREE files are missing — an
//              honest empty state the UI renders as "No identity recorded",
//              never fabricated copy. Always global, independent of any project.
//
// When a project is open in the terminal the caller passes its root+name and
// this route also reads THAT project's own docs for the two project bubbles:
//
//   project.context   — first real prose of <dir>/docs/ai-context.md
//                       (the cross-tool "current work" sync file).
//   project.knowledge — first real prose of <dir>/CLAUDE.md (fallbacks:
//                       <dir>/.claude/CLAUDE.md, then README.md) — the
//                       long-term shape/goals of the codebase.
//
// Each project field is null when its doc doesn't exist — an honest empty
// state. Path-guarded (root allowlist + name has no separators + resolved path
// stays inside the root) exactly like /api/projects/meta and /api/projects/summary.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveProjectDir, resolveProjectEntry } from "../../../server/project-roots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const USER_PATH = path.join(CLAUDE_HOME, "USER.md");
const PERSONA_PATH = path.join(CLAUDE_HOME, "PERSONA.md");
const SOUL_PATH = path.join(CLAUDE_HOME, "SOUL.md");

const MAX_PROSE_LENGTH = 520;

// USER.md lines that describe the owner's identity are kept; technical +
// other-people lines are dropped so this bubble stays about who the owner is,
// not a stack sheet or a contacts list (the whole point of this lane). Matched
// case-insensitively.
const IDENTITY_FIELD_DENYLIST = new Set(["stack", "active ventures", "key contacts"]);

// SOUL.md sections whose prose is the owner's creed / mantra. Reasoning and
// operating-procedure sections are intentionally left out — this is identity,
// not the runbook.
const SOUL_CREED_SECTIONS = new Set(["WHAT THIS SYSTEM IS", "WHAT THE OWNER IS BUILDING"]);

export interface IdentityField {
  label: string;
  value: string;
}

export interface OwnerIdentity {
  fields: IdentityField[];
  beliefs: string[];
  creed: string[];
}

type ProjectDocSource = "ai-context" | "claude-md" | "readme" | null;

export interface MemoryProject {
  root: string;
  name: string;
  context: string | null;
  contextSource: ProjectDocSource;
  knowledge: string | null;
  knowledgeSource: ProjectDocSource;
}

export interface MemoryResponse {
  identity: OwnerIdentity | null;
  project: MemoryProject | null;
}

async function readFileSafe(abs: string): Promise<string | null> {
  try {
    return await fsp.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/** Parses ~/.claude/USER.md — one identity fact per "Label: value" line.
 * Technical / other-people labels are filtered (see IDENTITY_FIELD_DENYLIST) so
 * only who-he-is lines survive, preserving the file's own order. */
function parseIdentityFields(raw: string): IdentityField[] {
  const fields: IdentityField[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z][A-Za-z ]*?):\s*(.+)$/);
    if (!match) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (value.length === 0) continue;
    if (IDENTITY_FIELD_DENYLIST.has(label.toLowerCase())) continue;
    fields.push({ label, value });
  }
  return fields;
}

/** The bullet lines of PERSONA.md ("- belief"), trimmed of the marker. */
function parseBeliefBullets(raw: string): string[] {
  const bullets: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*[-*]\s+(.*)$/);
    if (match) {
      const text = match[1].trim();
      if (text.length > 0) bullets.push(text);
    }
  }
  return bullets;
}

/** The creed paragraphs of SOUL.md — the plain-prose paragraphs that live
 * inside the mantra sections (SOUL_CREED_SECTIONS). A paragraph is a run of
 * consecutive prose lines; blank lines, headings, rules, "# " file comments and
 * "**bold**" sub-labels break/skip it. The long J.A.R.V.I.S. analogy paragraph
 * is dropped so the creed stays about the owner, not a pop-culture reference.
 * Faithful to the file's own words, never rewritten. */
function parseSoulCreed(raw: string): string[] {
  const creed: string[] = [];
  let inSection = false;
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (text.length === 0) return;
    if (/J\.A\.R\.V\.I\.S\./i.test(text)) return; // the analogy aside, not his creed
    creed.push(text);
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();

    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      flush();
      inSection = SOUL_CREED_SECTIONS.has(heading[1].trim().toUpperCase());
      continue;
    }
    if (!inSection) continue;

    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("#")) continue; // stray "# " comment inside body
    if (/^[-*_]{3,}$/.test(line)) {
      flush();
      continue;
    }
    if (/^\*\*.*\*\*/.test(line)) continue; // bold sub-label, not prose
    paragraph.push(line);
  }
  flush();
  return creed;
}

/** First meaningful prose block of a markdown doc: frontmatter, HTML
 * comments, headings, horizontal rules, and image/badge-only lines skipped.
 * Joins the leading real paragraphs up to MAX_PROSE_LENGTH. Null when the
 * doc has no prose at all (e.g. only headings + badges). Mirrors the
 * extraction logic in /api/projects/summary. */
function firstMeaningfulProse(raw: string): string | null {
  let text = raw;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) text = text.slice(end + 4);
  }
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  const collected: string[] = [];
  let joinedLength = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (joinedLength > 0) continue; // paragraph gap — keep gathering until the cap
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue; // heading
    if (/^[-*_]{3,}$/.test(line)) continue; // horizontal rule
    if (/^(\[!\[.*?\]\(.*?\)\]\(.*?\)\s*)+$/.test(line)) continue; // badge row
    if (/^!\[.*?\]\(.*?\)$/.test(line)) continue; // bare image
    if (/^>\s*$/.test(line)) continue;
    collected.push(line);
    joinedLength += line.length + 1;
    if (joinedLength >= MAX_PROSE_LENGTH) break;
  }

  if (collected.length === 0) return null;
  let joined = collected.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length === 0) return null;
  if (joined.length > MAX_PROSE_LENGTH) {
    const cut = joined.slice(0, MAX_PROSE_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    joined = (lastSpace > MAX_PROSE_LENGTH - 120 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  }
  return joined;
}

async function readProject(root: string, name: string): Promise<MemoryProject | null> {
  const dir = resolveProjectDir(root, name);
  if (!dir) return null;

  const contextPath = resolveProjectEntry(root, name, path.join("docs", "ai-context.md"));
  const contextRaw = contextPath ? await readFileSafe(contextPath) : null;
  const context = contextRaw ? firstMeaningfulProse(contextRaw) : null;

  // Long-term "shape of the codebase": project CLAUDE.md first, then a
  // nested .claude/CLAUDE.md, then the README as a last honest fallback.
  const knowledgeCandidates: { rel: string; source: Exclude<ProjectDocSource, null> }[] = [
    { rel: "CLAUDE.md", source: "claude-md" },
    { rel: path.join(".claude", "CLAUDE.md"), source: "claude-md" },
    { rel: "README.md", source: "readme" },
    { rel: "Readme.md", source: "readme" },
    { rel: "readme.md", source: "readme" },
  ];
  let knowledge: string | null = null;
  let knowledgeSource: ProjectDocSource = null;
  for (const candidate of knowledgeCandidates) {
    const candidatePath = resolveProjectEntry(root, name, candidate.rel);
    const raw = candidatePath ? await readFileSafe(candidatePath) : null;
    if (!raw) continue;
    const prose = firstMeaningfulProse(raw);
    if (prose) {
      knowledge = prose;
      knowledgeSource = candidate.source;
      break;
    }
  }

  return {
    root,
    name,
    context,
    contextSource: context ? "ai-context" : null,
    knowledge,
    knowledgeSource,
  };
}

/** Reads the owner's creed from the three global identity docs. Null only when
 * none of them exist — a genuinely empty state, never invented. */
async function readIdentity(): Promise<OwnerIdentity | null> {
  const [userRaw, personaRaw, soulRaw] = await Promise.all([
    readFileSafe(USER_PATH),
    readFileSafe(PERSONA_PATH),
    readFileSafe(SOUL_PATH),
  ]);

  if (userRaw === null && personaRaw === null && soulRaw === null) return null;

  return {
    fields: userRaw ? parseIdentityFields(userRaw) : [],
    beliefs: personaRaw ? parseBeliefBullets(personaRaw) : [],
    creed: soulRaw ? parseSoulCreed(soulRaw) : [],
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const root = searchParams.get("root") ?? "";
  const name = searchParams.get("name") ?? "";

  const [identity, project] = await Promise.all([
    readIdentity(),
    root && name ? readProject(root, name) : Promise.resolve(null),
  ]);

  const body: MemoryResponse = { identity, project };
  return NextResponse.json(body);
}
