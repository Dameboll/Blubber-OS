/**
 * electron/main.js
 *
 * Electron shell around the existing custom Next.js server (server.js).
 * This file does NOT reimplement anything server.js already does -- it
 * spawns the real server.js as a child process and points a BrowserWindow
 * at it, same as opening http://127.0.0.1:<port> in a normal browser tab.
 *
 * NODE RUNTIME FOR THE CHILD PROCESS -- two modes, selected by whether the
 * app is packaged (see the `runAsElectronNode` line in startServer below):
 *
 * PACKAGED (always): spawn Electron's OWN binary with ELECTRON_RUN_AS_NODE=1,
 * which makes it behave exactly like `node <script>`. A packaged install must
 * be self-contained -- a buyer has no guarantee of a system `node` on PATH,
 * and the server can't boot without one, so onboarding (which runs INSIDE the
 * app) could never rescue it. Electron's binary always ships with the app.
 * This requires better-sqlite3/node-pty to be built against Electron's Node
 * ABI (`npm run rebuild:electron`, needs Visual Studio Build Tools on
 * Windows); npmRebuild:false in electron-builder.yml keeps those
 * already-correct binaries untouched during packaging.
 *
 * DEV (unpackaged, default): spawn the system `node` found on PATH, exactly
 * like `npm run dev`. Set BLUBBER_ELECTRON_SPAWN_AS_NODE=1 to force the
 * packaged path in dev for a smoke-test of that code path.
 *
 * KNOWN TRADEOFF: after `npm run rebuild:electron`, the plain
 * `npm run dev` / `npm start` path (system `node server.js`, no Electron)
 * throws a NODE_MODULE_VERSION mismatch until `npm run rebuild:system-node`
 * flips the native modules back. Documented, not a bug.
 */

const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { app, BrowserWindow, dialog, ipcMain, shell: electronShell } = require("electron");

const HOST = "127.0.0.1";

const POLL_INTERVAL_MS = 300;
const POLL_TIMEOUT_MS = 15000;

// Per-launch identity nonce. Passed to server.js via env; /__blubber-health
// must echo it back before the window opens. This is what stops Blubber from
// ever rendering an unrelated local dev server that happens to own the port.
const startupNonce = crypto.randomBytes(16).toString("hex");

// Resolved at startup (see resolveFreePort) — dev keeps 3000 for muscle
// memory, packaged runs take any free loopback port so a customer's own
// dev tools on 3000 can never collide with Blubber.
let PORT = parseInt(process.env.PORT || "3000", 10);
let SERVER_URL = `http://${HOST}:${PORT}`;

let serverProcess = null;
let mainWindow = null;
let quitting = false;

// Second launches focus the existing window instead of starting a second
// server (which would either die on the busy port or double every process).
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/** Ask the OS for a currently-free loopback port (listen on 0, read the
 * assignment, close). The tiny race between close and server.js binding is
 * acceptable — a loss surfaces as the existing EADDRINUSE error path. */
function resolveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const assigned = probe.address().port;
      probe.close(() => resolve(assigned));
    });
  });
}

// Native "choose a folder" dialog for the renderer (see electron/preload.js).
// Powers both "point Blubber at a workspace" and "install the Starter Kit from
// the folder you downloaded from Shopify". Returns the chosen absolute path, or
// null on cancel. openDirectory only — never a file, never multi-select.
ipcMain.handle("blubber:pick-folder", async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: options?.title || "Choose a folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * Project root that contains server.js and everything it needs (src/,
 * public/, node_modules/, package.json). In dev (`electron .`), __dirname
 * is <repo>/electron, so the root is one level up. When packaged,
 * electron-builder lays the app out under process.resourcesPath/app
 * (see electron-builder.yml `directories` / default app packaging) --
 * server.js still runs from real files on disk there, never from inside
 * app.asar, since it's a plain child process, not a `require()`.
 */
function getAppRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app");
  }
  return path.join(__dirname, "..");
}

function startServer() {
  const appRoot = getAppRoot();
  const serverEntry = path.join(appRoot, "server.js");
  const { spawn } = require("node:child_process");

  // A packaged install must be self-contained: a beginner buyer has no
  // guarantee of a system `node` on PATH, and the server can't boot without
  // one, so onboarding (which runs INSIDE the app) could never rescue it.
  // Electron's own binary IS a Node runtime (ELECTRON_RUN_AS_NODE=1), and it
  // always ships with the app — so packaged builds always spawn through it.
  // Native modules (better-sqlite3/node-pty) are rebuilt against Electron's
  // ABI before packaging via `npm run rebuild:electron` (npmRebuild:false in
  // electron-builder.yml keeps those already-correct binaries untouched).
  // The env override still forces this mode for a dev smoke-test of the path.
  const runAsElectronNode =
    app.isPackaged || process.env.BLUBBER_ELECTRON_SPAWN_AS_NODE === "1";
  const env = {
    ...process.env,
    PORT: String(PORT),
    // Identity nonce — server.js echoes this from /__blubber-health and the
    // window only opens on an exact match (see waitForBlubberServer).
    BLUBBER_STARTUP_NONCE: startupNonce,
    // Durable customer-data locations OUTSIDE the install directory (the
    // uninstaller removes the install dir; before this, it deleted every
    // database, preference, playlist, and uploaded track with it — see
    // src/server/app-dirs.ts + data-migrate.ts). Music is deliberately NOT
    // under userData: Electron guidance warns against large media there
    // because some systems back that folder up.
    ...(app.isPackaged
      ? {
          BLUBBER_DATA_DIR: path.join(app.getPath("userData"), "blubber-data"),
          BLUBBER_MUSIC_DIR: path.join(app.getPath("music"), "Blubber"),
        }
      : {}),
    NODE_ENV: app.isPackaged
      ? "production"
      : process.env.NODE_ENV || "development",
    // Production `next build` writes to .next-build, not the default
    // `.next` (see next.config.js / package.json "build" + "start"
    // scripts -- the split exists so a production build never clobbers a
    // concurrently running dev server's `.next` chunks). server.js's
    // `next({ dev, ... })` call reads distDir from next.config.js, which
    // reads this env var. Packaged mode always runs the production build,
    // so it must always point at .next-build -- without this, the
    // packaged app's server throws "Could not find a production build in
    // the '.next' directory" and the window never loads.
    ...(app.isPackaged ? { NEXT_DIST_DIR: ".next-build" } : {}),
  };

  let command;
  let args;
  let shell = false;
  if (runAsElectronNode) {
    // Future/packaged mode -- see file header. Requires better-sqlite3 /
    // node-pty rebuilt for Electron's ABI first.
    command = process.execPath;
    args = [serverEntry];
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    // Default -- system `node` on PATH, same as `npm run dev`. `shell:
    // true` on Windows so PATH/PATHEXT resolution finds `node.exe`
    // reliably; args stay static (no user input), so this is safe.
    command = "node";
    args = [serverEntry];
    shell = process.platform === "win32";
  }

  serverProcess = spawn(command, args, {
    cwd: appRoot,
    env,
    stdio: "inherit",
    shell,
  });

  serverProcess.on("error", (err) => {
    console.error("[electron] failed to spawn server.js:", err);
  });

  serverProcess.on("exit", (code, signal) => {
    serverProcess = null;
    if (quitting) return;
    console.log(`[electron] server.js exited (code=${code}, signal=${signal})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "Blubber server stopped",
        `The background server exited unexpectedly (code ${code}). Restart the app.`,
      );
    }
  });
}

/**
 * Poll /__blubber-health until it returns OUR app identity ({app:"blubber"}
 * with this launch's exact nonce), or give up after timeoutMs. Any response
 * that answers but is NOT Blubber (wrong body, wrong nonce) fails
 * immediately — that means something else owns the port and retrying can
 * never succeed. Before this check, the shell opened its window for ANY
 * HTTP response, so a customer's unrelated dev server on the same port got
 * rendered inside Blubber's window.
 */
function waitForBlubberServer(baseUrl, timeoutMs) {
  const start = Date.now();
  const healthUrl = `${baseUrl}/__blubber-health`;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(healthUrl, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.app === "blubber" && parsed.nonce === startupNonce) {
              resolve();
              return;
            }
          } catch {
            /* fall through to identity failure */
          }
          reject(
            new Error(
              `Something that isn't this Blubber instance answered on ${baseUrl}.`,
            ),
          );
        });
      });
      req.on("error", () => {
        if (Date.now() - start >= timeoutMs) {
          reject(
            new Error(`Server did not respond at ${healthUrl} within ${timeoutMs}ms`),
          );
          return;
        }
        setTimeout(attempt, POLL_INTERVAL_MS);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

async function createWindow() {
  try {
    await waitForBlubberServer(SERVER_URL, POLL_TIMEOUT_MS);
  } catch (err) {
    dialog.showErrorBox(
      "Blubber failed to start",
      `Blubber's background server didn't come up correctly.\n\n${err.message}\n\n` +
        `Try restarting the app. If it keeps happening, restart your computer ` +
        `so any stuck Blubber process is cleared.`,
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0f0d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // target="_blank" links (e.g. onboarding's "I'll do it myself" install link)
  // are silently dead in Electron without this: route them to the system
  // browser and never open a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      electronShell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-finish-load", () => {
    console.log(`[electron] window loaded ${SERVER_URL}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error(`[electron] did-fail-load (${code}): ${desc}`);
  });
  mainWindow.loadURL(SERVER_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return; // second instance — already quitting

  // Packaged runs never assume 3000 is free — any of the customer's own dev
  // tools may hold it. Dev keeps the fixed port unless PORT overrides it.
  if (app.isPackaged && !process.env.PORT) {
    try {
      PORT = await resolveFreePort();
      SERVER_URL = `http://${HOST}:${PORT}`;
    } catch (err) {
      console.error("[electron] free-port probe failed, using default:", err);
    }
  }

  startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess && !serverProcess.killed) {
    if (process.platform === "win32") {
      // With `shell: true`, serverProcess.pid is the cmd.exe wrapper —
      // .kill() takes out the wrapper and ORPHANS the node server under it,
      // which then squats on port 3000 and breaks every future launch (and
      // any in-app full-page reload, e.g. demo mode's ?demo=1 reload, once
      // the orphan finally dies). taskkill /T fells the whole tree.
      try {
        require("node:child_process").execFileSync(
          "taskkill",
          ["/PID", String(serverProcess.pid), "/T", "/F"],
          { stdio: "ignore" },
        );
      } catch {
        /* already gone */
      }
    } else {
      serverProcess.kill();
    }
  }
});
