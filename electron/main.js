/**
 * electron/main.js
 *
 * Electron shell around the existing custom Next.js server (server.js).
 * This file does NOT reimplement anything server.js already does -- it
 * spawns the real server.js as a child process and points a BrowserWindow
 * at it, same as opening http://127.0.0.1:<port> in a normal browser tab.
 *
 * NODE RUNTIME FOR THE CHILD PROCESS -- two modes, one env var:
 *
 * Default today: spawn the system `node` found on PATH, exactly like
 * `npm run dev` already does. better-sqlite3/node-pty are compiled against
 * system Node's ABI as installed by plain `npm install`, so this "just
 * works" with zero extra build tooling. This is what
 * `npm run electron:dev` actually uses out of the box.
 *
 * Future (packaged installer) mode: set BLUBBER_ELECTRON_SPAWN_AS_NODE=1
 * to instead spawn Electron's OWN binary with ELECTRON_RUN_AS_NODE=1,
 * which makes Electron's bundled binary behave exactly like `node <script>`.
 * That removes the dependency on the end user having Node.js installed at
 * all -- necessary for a real standalone installer. It requires
 * better-sqlite3/node-pty to be rebuilt against Electron's Node ABI first
 * (see scripts/electron-rebuild.mjs / `npm run rebuild:electron`), which in
 * turn requires a native build toolchain (Visual Studio Build Tools on
 * Windows) to be present -- not assumed to exist on every dev machine, so
 * it isn't the default for this scaffold pass. Once that toolchain is
 * available, flip the env var and the postinstall step does the rest.
 *
 * KNOWN TRADEOFF when the future mode IS used: once better-sqlite3/node-pty
 * are rebuilt for Electron's ABI, the plain `npm run dev` / `npm start`
 * path (system `node server.js`, no Electron) will throw a
 * NODE_MODULE_VERSION mismatch until `npm run rebuild:system-node` flips
 * them back. Documented, not a bug.
 */

const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow, dialog, shell: electronShell } = require("electron");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "127.0.0.1";
const SERVER_URL = `http://${HOST}:${PORT}`;

const POLL_INTERVAL_MS = 300;
const POLL_TIMEOUT_MS = 15000;

let serverProcess = null;
let mainWindow = null;
let quitting = false;

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

  const runAsElectronNode = process.env.BLUBBER_ELECTRON_SPAWN_AS_NODE === "1";
  const env = {
    ...process.env,
    PORT: String(PORT),
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

/** Poll SERVER_URL until it answers, or give up after timeoutMs. */
function waitForServer(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start >= timeoutMs) {
          reject(
            new Error(`Server did not respond at ${url} within ${timeoutMs}ms`),
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
    await waitForServer(SERVER_URL, POLL_TIMEOUT_MS);
  } catch (err) {
    dialog.showErrorBox(
      "Blubber failed to start",
      `Could not reach the local server at ${SERVER_URL}.\n\n${err.message}\n\n` +
        `Check that nothing else is already using port ${PORT}.`,
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

app.whenReady().then(() => {
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
    serverProcess.kill();
  }
});
