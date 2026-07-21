/**
 * quickchat-store — persisted transcript for the Dashboard's "Quick Chat" tab
 * (PILL WORLDS + MINI DASH, Lane 2). A flat JSON file, written atomically (tmp
 * file + rename), same pattern as spawned-store.ts / quest-store.ts.
 *
 * This is a SEPARATE Claude session from the main work terminal — it never
 * touches PersistentTerminalHost/TabBar/wsClient. See src/app/api/quickchat/
 * route.ts for the actual `claude -p --model claude-opus-4-8 --output-format
 * json` process spawn; this file only owns the persisted transcript + which
 * real Claude CLI session id to `--resume` next time. Assistant messages also
 * carry the REAL model id the CLI reported for that turn, so the badge shows
 * what actually answered across reloads.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "quickchat.json");

export interface QuickChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
  /** The REAL model id the CLI reported for this turn (assistant messages
   * only; null when the CLI didn't report one or the parse failed). The UI
   * maps this to a friendly badge label. */
  model?: string | null;
}

interface StoreShape {
  /** The real Claude CLI session id from the last successful response's
   * output-format json (`session_id`), passed as --resume next call. Null
   * until the first successful reply, or after "New chat" clears it. */
  claudeSessionId: string | null;
  messages: QuickChatMessage[];
}

const EMPTY_STORE: StoreShape = { claudeSessionId: null, messages: [] };

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore(): StoreShape {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return {
      claudeSessionId: typeof parsed.claudeSessionId === "string" ? parsed.claudeSessionId : null,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return { ...EMPTY_STORE, messages: [] };
  }
}

/** Atomic write: write to a tmp file in the same dir, then rename over the
 * real path, so a reader never sees a half-written file. */
function writeStore(store: StoreShape): void {
  ensureDataDir();
  const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmpPath, STORE_PATH);
}

export function getTranscript(): { sessionId: string | null; messages: QuickChatMessage[] } {
  const store = readStore();
  return { sessionId: store.claudeSessionId, messages: store.messages };
}

export function getClaudeSessionId(): string | null {
  return readStore().claudeSessionId;
}

export function setClaudeSessionId(id: string | null): void {
  const store = readStore();
  store.claudeSessionId = id;
  writeStore(store);
}

export function appendMessage(
  role: QuickChatMessage["role"],
  text: string,
  model: string | null = null,
): QuickChatMessage {
  const store = readStore();
  const message: QuickChatMessage = {
    id: crypto.randomUUID(),
    role,
    text,
    ts: new Date().toISOString(),
    model,
  };
  store.messages.push(message);
  writeStore(store);
  return message;
}

/** "New chat" — drops the transcript AND the Claude session id, so the next
 * message starts a genuinely fresh `claude -p` session, not a --resume. */
export function clear(): void {
  writeStore({ claudeSessionId: null, messages: [] });
}
