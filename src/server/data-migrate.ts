/**
 * One-time, idempotent migration of customer data out of the install
 * directory (the old process.cwd()/data + /music layout) into the durable
 * locations in app-dirs.ts. Runs at server startup (server.js) BEFORE any
 * store module touches disk.
 *
 * Safety rules (all deliberate):
 *  - Only runs when BLUBBER_DATA_DIR is set (packaged runs). Dev is a no-op.
 *  - A marker file in the destination records completion; present = skip.
 *  - If the destination already has real content, NOTHING is copied and the
 *    marker is written — newer customer data is never overwritten by stale
 *    install-dir leftovers.
 *  - Every copied file is size-verified before the marker is recorded; a
 *    failed verify leaves the marker absent so the next launch retries.
 *  - Source files are never deleted here. The old install-dir copy simply
 *    stops being read; uninstall removes it with the install directory.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, MUSIC_DIR } from "./app-dirs";

const MARKER_NAME = ".blubber-migration.json";

interface CopyResult {
  copied: number;
  verified: boolean;
}

function hasRealContent(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((name) => name !== MARKER_NAME);
  } catch {
    return false;
  }
}

function copyTreeVerified(src: string, dest: string): CopyResult {
  let copied = 0;
  const walk = (from: string, to: string): boolean => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        if (!walk(fromPath, toPath)) return false;
      } else if (entry.isFile()) {
        fs.copyFileSync(fromPath, toPath);
        const a = fs.statSync(fromPath).size;
        const b = fs.statSync(toPath).size;
        if (a !== b) return false;
        copied += 1;
      }
    }
    return true;
  };
  const verified = walk(src, dest);
  return { copied, verified };
}

function migrateOne(oldDir: string, newDir: string, label: string): void {
  const marker = path.join(newDir, MARKER_NAME);
  if (fs.existsSync(marker)) return;

  const record: Record<string, unknown> = {
    migratedAt: new Date().toISOString(),
    from: oldDir,
    action: "none",
  };

  if (hasRealContent(newDir)) {
    // Destination already lives its own life — never clobber it.
    record.action = "skipped-destination-not-empty";
  } else if (!fs.existsSync(oldDir)) {
    record.action = "skipped-no-source";
  } else {
    const { copied, verified } = copyTreeVerified(oldDir, newDir);
    if (!verified) {
      console.error(
        `[data-migrate] ${label}: copy verification failed — will retry next launch`,
      );
      return; // no marker -> retried next start
    }
    record.action = "copied";
    record.files = copied;
    console.log(`[data-migrate] ${label}: copied ${copied} file(s) from ${oldDir}`);
  }

  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify(record, null, 2));
}

/** Called once from server.js before any store loads. Safe to call every
 * start — the marker files make it a cheap no-op after the first run. */
export function runDataMigration(): void {
  if (!process.env.BLUBBER_DATA_DIR) return; // dev layout — nothing to do
  try {
    migrateOne(path.join(process.cwd(), "data"), DATA_DIR, "data");
    migrateOne(path.join(process.cwd(), "music"), MUSIC_DIR, "music");
  } catch (err) {
    // A migration failure must not stop the app from starting — the old
    // in-place data simply won't be picked up until a later launch retries.
    console.error("[data-migrate] failed:", err);
  }
}
