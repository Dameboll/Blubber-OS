// Live token-usage tail-watcher.
//
// Finds every *.jsonl transcript under ~/.claude/projects/ (session files AND
// any nested subagents/**/*.jsonl files -- a plain recursive walk covers both
// without special-casing), starts tracking each one at its CURRENT end-of-file
// (so nothing historical is replayed), then polls for appended bytes and emits
// token-usage deltas over a module-level EventEmitter as new lines land.
//
// This is intentionally decoupled from the SQLite rollup (log-indexer.ts/db.ts)
// -- it is a separate, simpler concern: cheap live deltas for the orb + live
// bar, not the historical/aggregate store.

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import os from "os";

export interface UsagePayload {
  tokensInDelta: number;
  tokensOutDelta: number;
  totalToday: number;
}

interface TrackedFile {
  offset: number;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// How often we re-check tracked files for appended bytes.
const POLL_INTERVAL_MS = 2000;
// How often we re-walk the whole tree looking for brand-new session/subagent
// files. Kept separate (and much less frequent) from the poll above so a
// large ~/.claude/projects/ tree doesn't get re-listed 30x/minute.
const DISCOVER_INTERVAL_MS = 10000;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function walkJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory may not exist yet on a fresh install -- that's fine, the
    // watcher just has nothing to track until it appears.
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function extractUsage(line: string): UsageBlock | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, any>;
  const usage: UsageBlock | undefined = obj.message?.usage ?? obj.usage;
  if (
    usage &&
    (typeof usage.input_tokens === "number" ||
      typeof usage.output_tokens === "number")
  ) {
    return usage;
  }
  return null;
}

function readSlice(filePath: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (end <= start) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    // createReadStream's `end` option is inclusive, so subtract 1.
    const stream = fs.createReadStream(filePath, { start, end: end - 1 });
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

class LiveUsageWatcher extends EventEmitter {
  private tracked = new Map<string, TrackedFile>();
  private partials = new Map<string, string>();
  private totalToday = 0;
  private day = todayKey();
  private lastDiscover = 0;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private started = false;

  constructor() {
    super();
    // Multiple browser tabs each open one SSE connection -> one listener
    // each. Bump the default cap so that doesn't spam an EventEmitter
    // max-listeners warning.
    this.setMaxListeners(50);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.discoverFiles(/* seedAtEof */ true);
    this.lastDiscover = Date.now();

    // Best-effort recursive fs.watch (supported on Windows/macOS, which
    // covers this project's target). Treated purely as an early-wakeup
    // optimization -- the poll loop below is the actual source of truth,
    // so an unsupported/missed watch event never causes lost data.
    try {
      this.fsWatcher = fs.watch(CLAUDE_PROJECTS_DIR, { recursive: true }, () => {
        void this.tick();
      });
    } catch {
      this.fsWatcher = null;
    }

    this.pollHandle = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.fsWatcher?.close();
    this.pollHandle = null;
    this.fsWatcher = null;
    this.started = false;
  }

  /** Current cumulative total for today, with zero deltas -- used to give a
   * freshly-connected SSE client an immediate baseline. */
  getSnapshot(): UsagePayload {
    return { tokensInDelta: 0, tokensOutDelta: 0, totalToday: this.totalToday };
  }

  /** Zero today's live counter and push it to every connected client
   * immediately (Settings master reset). Tracked file offsets stay at EOF, so
   * only genuinely new tokens counted after the reset accumulate again. */
  reset(): void {
    this.totalToday = 0;
    this.emit("usage", { tokensInDelta: 0, tokensOutDelta: 0, totalToday: 0 });
  }

  private discoverFiles(seedAtEof: boolean): void {
    const files = walkJsonlFiles(CLAUDE_PROJECTS_DIR);
    for (const file of files) {
      if (this.tracked.has(file)) continue;
      if (seedAtEof) {
        try {
          this.tracked.set(file, { offset: fs.statSync(file).size });
        } catch {
          // vanished between listing and stat; skip, next discovery pass
          // will pick it back up if it reappears.
        }
      } else {
        // Brand-new file discovered after boot -- it has no "history" to
        // skip, so track it from 0 and let the next tick pick up all of it.
        this.tracked.set(file, { offset: 0 });
      }
    }
  }

  private rolloverDayIfNeeded(): void {
    const key = todayKey();
    if (key !== this.day) {
      this.day = key;
      this.totalToday = 0;
    }
  }

  private async tick(): Promise<void> {
    this.rolloverDayIfNeeded();

    const now = Date.now();
    if (now - this.lastDiscover >= DISCOVER_INTERVAL_MS) {
      this.discoverFiles(/* seedAtEof */ false);
      this.lastDiscover = now;
    }

    let tokensInDelta = 0;
    let tokensOutDelta = 0;

    for (const [file, track] of this.tracked) {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        // File removed/rotated out from under us.
        this.tracked.delete(file);
        this.partials.delete(file);
        continue;
      }

      if (size < track.offset) {
        // Truncated or replaced -- restart from the top of the file.
        track.offset = 0;
        this.partials.delete(file);
      }

      if (size <= track.offset) continue;

      let chunk: string;
      try {
        chunk = await readSlice(file, track.offset, size);
      } catch {
        continue;
      }
      track.offset = size;

      const leftover = this.partials.get(file) ?? "";
      const combined = leftover + chunk;
      const lines = combined.split("\n");
      // Last element may be a partial line (no trailing newline yet) --
      // hold onto it and prepend it on the next read instead of parsing it.
      const trailing = lines.pop() ?? "";
      this.partials.set(file, trailing);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const usage = extractUsage(trimmed);
        if (!usage) continue;
        tokensInDelta +=
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        tokensOutDelta += usage.output_tokens ?? 0;
      }
    }

    if (tokensInDelta > 0 || tokensOutDelta > 0) {
      this.totalToday += tokensInDelta + tokensOutDelta;
      const payload: UsagePayload = {
        tokensInDelta,
        tokensOutDelta,
        totalToday: this.totalToday,
      };
      this.emit("usage", payload);
    }
  }
}

// Survive Next.js dev-mode module re-evaluation (Fast Refresh can re-run a
// module's top-level code) with the same globalThis-singleton pattern used
// for things like a shared Prisma/DB client, so we never end up with two
// competing poll loops.
const globalForWatcher = globalThis as unknown as {
  __blubberLiveUsageWatcher?: LiveUsageWatcher;
};

export const liveUsageWatcher: LiveUsageWatcher =
  globalForWatcher.__blubberLiveUsageWatcher ?? new LiveUsageWatcher();

if (!globalForWatcher.__blubberLiveUsageWatcher) {
  globalForWatcher.__blubberLiveUsageWatcher = liveUsageWatcher;
  liveUsageWatcher.start();
}

export default liveUsageWatcher;
