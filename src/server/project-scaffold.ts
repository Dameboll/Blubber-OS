/**
 * project-scaffold — the REAL, sandboxed project creator behind POST
 * /api/projects (Item 7). Creates a new folder under exactly one of the four
 * Development roots and lays down a small, honest starter scaffold for the
 * chosen template. No shell, no npm, no network — just fs writes inside a
 * hard-fenced path.
 *
 * SECURITY (CRITICAL — this is a filesystem-mutating boundary):
 *   - root must be one of the four fixed labels (ACTIVE/HOBBY/general/research).
 *   - name is sanitized to [a-zA-Z0-9-_] (spaces → hyphens) and rejected if it
 *     escapes to empty, a dotfile, or "."/"..".
 *   - the final absolute path is re-resolved and asserted to live directly
 *     inside Development/<root>/ — any traversal attempt is refused.
 *   - refuses to touch an existing folder (never overwrites real work).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PROJECT_ROOTS = ["ACTIVE", "HOBBY", "general", "research"] as const;
export type ProjectRootLabel = (typeof PROJECT_ROOTS)[number];

export const TEMPLATE_KEYS = ["web-app", "ai-agent", "api-service", "data-pipeline", "blank"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

interface TemplateDef {
  title: string;
  /** Recommended real agent slugs (from ~/.claude/agents) that fit this work. */
  agents: string[];
  /** Extra template-specific starter files (relative path → contents). */
  files: (name: string) => Record<string, string>;
}

const GITIGNORE = `node_modules/
.next/
.env
.env.local
.DS_Store
dist/
*.log
`;

function claudeMd(name: string, kind: string): string {
  return `@~/.claude/CLAUDE.md

# ${name} — ${kind}

## Project context
Fresh ${kind}. Fill in the current state and key contacts here.

## Commands
(add project-specific commands as they exist)

## Active work
Just scaffolded — nothing built yet.
`;
}

function aiContext(name: string, kind: string, created: string): string {
  return `# AI Context — ${name}
# Cross-tool memory (Claude Code / Codex / Cursor read this directly).
# Created: ${created}

## What this is
${kind}, created ${created}. No work done yet.

## Decisions
(none yet)

## Next
(define the first task)
`;
}

const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  "web-app": {
    title: "Web App",
    agents: ["react-reviewer", "typescript-reviewer", "a11y-architect"],
    files: (name) => ({
      "README.md": `# ${name}\n\nFull-stack web application. Next.js App Router + TypeScript.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
      "src/.gitkeep": "",
    }),
  },
  "ai-agent": {
    title: "AI Agent",
    agents: ["architect", "gemini-analyst", "researcher"],
    files: (name) => ({
      "README.md": `# ${name}\n\nIntelligent agent system.\n\n## Shape\n- \`agent.md\` — the agent's spec / system prompt\n- wire tools + a run loop from here\n`,
      "agent.md": `# ${name} — agent spec\n\n## Role\n(what this agent does)\n\n## Tools\n(list the tools it can call)\n\n## Guardrails\n(what it must never do)\n`,
    }),
  },
  "api-service": {
    title: "API Service",
    agents: ["architect", "security-reviewer", "database-reviewer"],
    files: (name) => ({
      "README.md": `# ${name}\n\nRESTful API service.\n\n## Endpoints\n(document routes here as they land)\n`,
      "src/.gitkeep": "",
    }),
  },
  "data-pipeline": {
    title: "Data Pipeline",
    agents: ["database-reviewer", "performance-optimizer", "gemini-analyst"],
    files: (name) => ({
      "README.md": `# ${name}\n\nData processing pipeline.\n\n## Stages\n1. ingest\n2. transform\n3. load\n`,
      "src/.gitkeep": "",
    }),
  },
  blank: {
    title: "Blank Project",
    agents: ["general-purpose"],
    files: (name) => ({
      "README.md": `# ${name}\n\nBlank project.\n`,
    }),
  },
};

export interface ScaffoldInput {
  root: string;
  name: string;
  template: string;
  createdISO: string;
}

export interface ScaffoldResult {
  ok: boolean;
  error?: string;
  root?: ProjectRootLabel;
  name?: string;
  path?: string;
  agents?: string[];
}

/** Turn a raw display name into a safe folder name, or null if nothing usable
 *  survives sanitization. */
export function sanitizeName(raw: string): string | null {
  const trimmed = raw.trim();
  // Reject path-ish input outright rather than silently neutralizing it into a
  // surprise folder name — if it has a separator or a "..", it's not a name.
  // Explicit includes (not a char-class regex) so both slash kinds are caught
  // unambiguously ("\\" is a single backslash char).
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  const cleaned = trimmed
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/^\.+/, ""); // never a dotfile
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.length > 64) return null;
  return cleaned;
}

export function isRootLabel(value: string): value is ProjectRootLabel {
  return (PROJECT_ROOTS as readonly string[]).includes(value);
}

export function templateKeyOf(value: string): TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as TemplateKey) : "blank";
}

export function recommendedAgents(template: string): string[] {
  return TEMPLATES[templateKeyOf(template)].agents;
}

export async function scaffoldProject(input: ScaffoldInput): Promise<ScaffoldResult> {
  if (!isRootLabel(input.root)) return { ok: false, error: "invalid root" };
  const name = sanitizeName(input.name ?? "");
  if (!name) return { ok: false, error: "invalid name" };

  const template = templateKeyOf(input.template);
  const def = TEMPLATES[template];
  const kind = def.title;

  const devRoot = path.join(os.homedir(), "Development");
  const rootDir = path.join(devRoot, input.root);
  const target = path.resolve(rootDir, name);

  // Hard fence: target must be a direct child of the chosen root — no traversal.
  const rel = path.relative(rootDir, target);
  if (rel !== name || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "path escapes root" };
  }

  try {
    await fs.access(target);
    return { ok: false, error: "a folder with that name already exists" };
  } catch {
    // Good — does not exist yet.
  }

  try {
    const files: Record<string, string> = {
      ...def.files(name),
      "CLAUDE.md": claudeMd(name, kind),
      "docs/ai-context.md": aiContext(name, kind, input.createdISO.slice(0, 10)),
      ".gitignore": GITIGNORE,
    };

    await fs.mkdir(target, { recursive: true });
    for (const [relPath, contents] of Object.entries(files)) {
      const filePath = path.join(target, relPath);
      // Re-fence every write inside the target (belt + suspenders).
      if (!path.resolve(filePath).startsWith(target)) continue;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    }

    return { ok: true, root: input.root, name, path: target, agents: def.agents };
  } catch (err) {
    console.error("[project-scaffold] create failed:", err);
    return { ok: false, error: "failed to create project" };
  }
}
