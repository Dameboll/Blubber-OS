// GET /api/meta -> { version: string, dataDir: string, claudeProjectsDir: string }
//
// Small read-only endpoint for the Settings "Advanced" tab's data-locations
// rows. Reads the real values from the running process (package.json's
// version field, the actual resolved paths this app already reads/writes
// from — see src/server/db.ts and src/server/live-usage-watcher.ts for the
// same os.homedir()-based paths) rather than the client guessing/hardcoding
// them, so what's shown is always the real machine truth.

import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import pkg from "../../../../package.json";
import { DATA_DIR } from "../../../server/app-dirs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    version: pkg.version,
    dataDir: DATA_DIR,
    claudeProjectsDir: path.join(os.homedir(), ".claude", "projects"),
  });
}
