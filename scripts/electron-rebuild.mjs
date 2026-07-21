#!/usr/bin/env node
/**
 * scripts/electron-rebuild.mjs
 *
 * postinstall step: rebuilds the two native addons Blubber depends on
 * (better-sqlite3, node-pty) against Electron's bundled Node ABI instead
 * of the system Node ABI they'd normally compile against.
 *
 * WHY: electron/main.js spawns server.js via Electron's own binary
 * (ELECTRON_RUN_AS_NODE=1), not a system `node` executable, so that an
 * eventual packaged installer never depends on the end user having
 * Node.js installed. For that spawned process to actually load
 * better-sqlite3 and node-pty, those addons must be compiled for
 * Electron's Node ABI, not whatever system Node ran `npm install`.
 *
 * KNOWN TRADEOFF (real, not a bug): after this runs, the compiled .node
 * binaries in node_modules match Electron's ABI. The plain `npm run dev` /
 * `npm start` path (system `node server.js`, no Electron) will then throw
 * a NODE_MODULE_VERSION mismatch on require(), because that path runs
 * under system Node, not Electron. Run:
 *   npm run rebuild:system-node
 * to flip the addons back before using the plain dev/start scripts again.
 * Flip forward again with `npm run rebuild:electron` before
 * `npm run electron:dev` / `npm run electron:build`.
 *
 * Non-fatal by design: `npm install` must never hard-fail because of
 * Electron-only tooling (offline installs, CI without Electron resolved
 * yet, etc). Any failure here just warns and exits 0.
 *
 * SELF-HEALING (added after hitting this for real): node-gyp/@electron/rebuild
 * deletes a module's existing compiled .node binary BEFORE attempting the
 * new build. If the machine has no native build toolchain (e.g. no Visual
 * Studio Build Tools on Windows), the Electron-ABI build then fails --
 * leaving better-sqlite3/node-pty with NO working binary at all, which
 * breaks the plain `npm run dev` path too, not just Electron. So on any
 * failure here, we immediately fall back to `npm rebuild` for the affected
 * modules to restore a working system-Node build before exiting. A
 * `postinstall` step must never brick the app it's attached to.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDir);
const NATIVE_MODULES = ["better-sqlite3", "node-pty"];

async function main() {
  const electronPkgPath = path.join(
    projectRoot,
    "node_modules",
    "electron",
    "package.json",
  );
  const electronVersion = JSON.parse(readFileSync(electronPkgPath, "utf8"))
    .version;

  const { rebuild } = await import("@electron/rebuild");

  await rebuild({
    buildPath: projectRoot,
    electronVersion,
    onlyModules: NATIVE_MODULES,
  });

  console.log(
    `[electron-rebuild] better-sqlite3 + node-pty rebuilt for Electron ${electronVersion}`,
  );
}

function restoreSystemNodeBuild() {
  console.warn(
    "[electron-rebuild] restoring system-Node build via `npm rebuild` so the plain dev/start scripts keep working...",
  );
  const result = spawnSync(
    "npm",
    ["rebuild", ...NATIVE_MODULES],
    {
      cwd: projectRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.status === 0) {
    console.warn(
      "[electron-rebuild] restored -- native modules are back on system Node's ABI.",
    );
  } else {
    console.error(
      "[electron-rebuild] AUTO-RESTORE FAILED. better-sqlite3/node-pty may be left " +
        "without a working binary. Run manually: npm rebuild better-sqlite3 node-pty",
    );
  }
}

main().catch((err) => {
  console.warn(
    "[electron-rebuild] Electron-ABI build skipped (non-fatal):",
    err instanceof Error ? err.message : err,
  );
  console.warn(
    "[electron-rebuild] this usually means no native build toolchain is installed " +
      "(e.g. Visual Studio Build Tools on Windows). Install one, then run " +
      "`npm run rebuild:electron` manually before `npm run electron:dev` / " +
      "`npm run electron:build` if you need the packaged/ELECTRON_RUN_AS_NODE mode.",
  );
  restoreSystemNodeBuild();
  process.exit(0);
});
