/**
 * Single source of truth for where Blubber keeps mutable customer data.
 *
 * Packaged (Electron) runs set BLUBBER_DATA_DIR / BLUBBER_MUSIC_DIR to
 * durable per-user locations OUTSIDE the install directory (see
 * electron/main.js) — the NSIS uninstaller removes the install dir, and
 * before this split it took every database, preference, playlist, and
 * uploaded track with it. Dev runs leave the envs unset and keep the old
 * repo-local ./data and ./music layout.
 *
 * Databases/JSON stores live under DATA_DIR (a subfolder of Electron's
 * userData). Uploaded music lives under MUSIC_DIR, deliberately separate:
 * Electron guidance warns against parking large media in userData because
 * some systems back that folder up.
 */
import path from "node:path";

export const DATA_DIR =
  process.env.BLUBBER_DATA_DIR || path.join(process.cwd(), "data");

export const MUSIC_DIR =
  process.env.BLUBBER_MUSIC_DIR || path.join(process.cwd(), "music");
