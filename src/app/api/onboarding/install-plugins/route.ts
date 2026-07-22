// POST /api/onboarding/install-plugins — installs the recommended Claude Code
// plugin stack, streaming real CLI output as NDJSON (see stream-command.ts /
// install-stream.ts for event shapes).
//
// Body: { plugins?: string[] }  — plugin ids to install (see
// src/lib/recommended-plugins.ts). Omitted / empty = install the whole curated
// stack. Unknown ids are dropped, never fabricated.
//
// Per plugin, two commands run in sequence:
//   claude plugin marketplace add <marketplaceSource>   (idempotent — safe to
//                                                        re-run if already added)
//   claude plugin install <id>@<marketplace>
// Requires the `claude` CLI on PATH (Claude Code installed). The whole thing is
// optional and declinable in the UI, and Cancel aborts it mid-run (the child is
// killed — see stream-command.ts).

import { NextResponse } from "next/server";
import { runCommandStream, type StreamStep } from "../../../../server/stream-command";
import { selectPlugins } from "../../../../lib/recommended-plugins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let ids: string[] | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { plugins?: unknown };
    if (Array.isArray(body.plugins)) {
      ids = body.plugins.filter((p): p is string => typeof p === "string");
    }
  } catch {
    ids = undefined;
  }

  const plugins = selectPlugins(ids);
  if (plugins.length === 0) {
    return NextResponse.json({ error: "no matching recommended plugins to install" }, { status: 400 });
  }

  // Track which marketplaces we've already added this run so we don't re-add the
  // shared official marketplace once per plugin.
  const addedMarketplaces = new Set<string>();
  const steps: StreamStep[] = [];

  for (const p of plugins) {
    if (!addedMarketplaces.has(p.marketplace)) {
      steps.push({
        label: `Adding marketplace ${p.marketplace}`,
        cmd: "claude",
        args: ["plugin", "marketplace", "add", p.marketplaceSource],
      });
      addedMarketplaces.add(p.marketplace);
    }
    steps.push({
      label: `Installing ${p.name}`,
      cmd: "claude",
      args: ["plugin", "install", `${p.id}@${p.marketplace}`],
    });
  }

  try {
    const stream = runCommandStream(steps, request.signal);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `could not start install: ${(err as Error).message}` }, { status: 500 });
  }
}
