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

import { readFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDir);

// Only better-sqlite3 is a classic (V8-ABI) addon that must be recompiled for
// Electron's Node ABI. node-pty 1.x ships N-API prebuilds (prebuilds/win32-x64/
// pty.node + conpty.node), which are ABI-stable and load unchanged under both
// system Node and Electron — recompiling it is not just unnecessary, it FAILS
// on Windows (its winpty dep's GetCommitHash.bat build step is broken from an
// npm tarball), which used to abort the whole rebuild and revert better-sqlite3
// too. So the Electron rebuild targets better-sqlite3 only; node-pty keeps its
// prebuilt binary. `npm rebuild` in the restore path still no-ops safely on it.
const ELECTRON_REBUILD_MODULES = ["better-sqlite3"];
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
    onlyModules: ELECTRON_REBUILD_MODULES,
  });

  // @electron/rebuild writes better-sqlite3's Electron-ABI binary to
  // bin/<platform>-<arch>-<abi>/better-sqlite3.node but LEAVES the stale
  // system-Node binary in build/Release/better_sqlite3.node. better-sqlite3's
  // loader resolves build/Release FIRST, so at runtime under Electron the
  // server dlopen's the wrong ABI (NODE_MODULE_VERSION 137 vs 148) and every
  // DB route 500s. Overwrite build/Release with the freshly built Electron-ABI
  // binary (the newest bin/*/better-sqlite3.node) so the loader gets the right
  // one. Without this the packaged app boots but its whole database layer dies.
  syncElectronBinaryIntoBuildRelease("better-sqlite3");

  console.log(
    `[electron-rebuild] better-sqlite3 rebuilt for Electron ${electronVersion} ` +
      `(node-pty uses its N-API prebuild, no recompile needed)`,
  );
}

/**
 * Copy the freshly built Electron-ABI binary from better-sqlite3's bin/
 * output dir over build/Release/better_sqlite3.node, which better-sqlite3's
 * loader resolves first. The correct binary is the most-recently-modified
 * bin/<platform>-<arch>-<abi>/better-sqlite3.node (just written by rebuild()).
 */
function syncElectronBinaryIntoBuildRelease(moduleName) {
  const moduleRoot = path.join(projectRoot, "node_modules", moduleName);
  const binRoot = path.join(moduleRoot, "bin");
  const target = path.join(moduleRoot, "build", "Release", "better_sqlite3.node");
  if (!existsSync(binRoot)) return;

  let newest = null;
  for (const dir of readdirSync(binRoot)) {
    const candidate = path.join(binRoot, dir, "better-sqlite3.node");
    if (!existsSync(candidate)) continue;
    const mtime = statSync(candidate).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path: candidate, mtime };
  }
  if (!newest) return;

  copyFileSync(newest.path, target);
  console.log(
    `[electron-rebuild] synced ${path.relative(moduleRoot, newest.path)} -> build/Release (Electron ABI)`,
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
