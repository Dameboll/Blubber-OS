/**
 * GET /api/agents
 *
 * Reads ~/.claude/agents/*.md, parses the YAML frontmatter (name,
 * description) of each, and returns the roster as JSON for AgentCard /
 * TabBar quick-launch presets.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { isDemoModeRequest } from "../../../lib/demo-mode";
import { getDemoAgentList } from "../../../server/demo-dataset";

export interface AgentSummary {
  name: string;
  description: string;
  file: string;
}

const AGENTS_DIR = path.join(os.homedir(), ".claude", "agents");

// Module-scope, TTL-based cache. This route re-reads every *.md file in
// ~/.claude/agents on every call (120+ files as of this build) -- uncached,
// that's 1.4-8.7s per request (measured), which stalled AgentsScreen's
// "Loading the agent roster..." state for multiple seconds on every
// navigation. A local tool's agent roster doesn't change second-to-second,
// so a short TTL is safe: worst case a newly-added/edited agent file takes
// up to CACHE_TTL_MS to show up, which is an acceptable tradeoff for a
// near-instant screen. Cleared implicitly by process restart (dev server
// reload), never needs manual invalidation.
const CACHE_TTL_MS = 60_000;
let cache: { agents: AgentSummary[]; expiresAt: number } | null = null;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal YAML frontmatter reader — only extracts `name` and `description`.
 * Handles plain scalars (quoted or not) and block scalars (`|` / `>`) since
 * some agent files use multi-line descriptions.
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^name:\s*(.*)$/);
    if (nameMatch) {
      name = stripQuotes(nameMatch[1]);
      continue;
    }

    const descMatch = lines[i].match(/^description:\s*(.*)$/);
    if (descMatch) {
      const rest = descMatch[1].trim();
      const isBlockScalar = rest === "|" || rest === ">" || rest === "|-" || rest === ">-";

      if (isBlockScalar) {
        const blockLines: string[] = [];
        let j = i + 1;
        while (j < lines.length && (lines[j].startsWith("  ") || lines[j].trim() === "")) {
          blockLines.push(lines[j].replace(/^ {2}/, ""));
          j++;
        }
        const joiner = rest.startsWith(">") ? " " : "\n";
        description = blockLines.join(joiner).trim();
        i = j - 1;
      } else {
        description = stripQuotes(rest);
      }
    }
  }

  return { name, description };
}

async function readRoster(): Promise<AgentSummary[]> {
  // Typed explicitly rather than inferred from ReturnType<typeof fs.readdir> --
  // that generic inference picks the wrong overload (Dirent<Buffer>) against
  // this project's @types/node version even though withFileTypes:true at the
  // call site always resolves to Dirent<string>[] at runtime.
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
  } catch (err) {
    // No agents directory yet (or unreadable) — empty roster, not an error.
    console.error(`[api/agents] could not read ${AGENTS_DIR}:`, err);
    return [];
  }

  const mdFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));

  const agents: AgentSummary[] = [];
  for (const entry of mdFiles) {
    const filePath = path.join(AGENTS_DIR, entry.name);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const { name, description } = parseFrontmatter(content);
      agents.push({
        name: name ?? entry.name.replace(/\.md$/, ""),
        description: description ?? "",
        file: entry.name,
      });
    } catch (err) {
      console.error(`[api/agents] failed to parse ${entry.name}:`, err);
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));

  return agents;
}

export async function GET(request: Request) {
  // Demo Mode: the fixture roster, never the visiting machine's real
  // ~/.claude/agents (this fed the sidebar's "Recent Agents" leak).
  if (isDemoModeRequest(request)) {
    return NextResponse.json({ agents: getDemoAgentList() });
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json({ agents: cache.agents });
  }

  const agents = await readRoster();
  cache = { agents, expiresAt: now + CACHE_TTL_MS };

  return NextResponse.json({ agents });
}
