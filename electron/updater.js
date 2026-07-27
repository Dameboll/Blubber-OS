/**
 * electron/updater.js
 *
 * Auto-update for the packaged Windows app, via electron-updater against the
 * public GitHub releases of Dameboll/Blubber-OS (provider config lives in
 * electron-builder.yml `publish`).
 *
 * HOW IT WORKS: electron-updater reads `latest.yml` from the newest non-draft,
 * non-prerelease GitHub release, compares its version to the running app's, and
 * if it's newer downloads `Blubber.Setup.<version>.exe` in the background. The
 * user is only interrupted once, at the end, with a "restart now / later"
 * choice. Picking "later" still installs on next quit (autoInstallOnAppQuit).
 *
 * THE RELEASE MUST CARRY `latest.yml` AND THE `.blockmap`, not just the .exe.
 * scripts/release.ps1 stage 10 fails the release if electron-builder didn't
 * produce them, and docs/RELEASING.md has the exact upload command. Without
 * latest.yml on the release, every installed copy silently finds no update
 * forever -- the failure is invisible from the developer's side, which is
 * exactly why the pipeline checks for it instead of trusting the upload.
 *
 * UNSIGNED BUILDS: the installer has no Authenticode signature (see the known
 * gap in electron-builder.yml), so `publisherName` is deliberately NOT set and
 * electron-updater skips publisher verification. Integrity still rests on the
 * sha512 in latest.yml, fetched over HTTPS from GitHub -- the same trust chain
 * as a customer downloading the .exe by hand. Signing raises that bar for both
 * paths at once; it is not a prerequisite for this file to be correct.
 *
 * FAILURES ARE SILENT BY DESIGN. A missing release, an offline machine, a
 * GitHub outage, or a rate limit must never produce an error box or block
 * startup -- the app works fine on an old version. Errors are logged and
 * dropped. The ONLY dialog this module ever shows is the one after an update
 * has already downloaded successfully.
 */

const { app, dialog } = require("electron");

// Deliberately long: the first minutes after launch belong to the server boot,
// the first paint, and whatever the user actually opened Blubber to do. An
// update that lands 30s later than it could costs nothing.
const FIRST_CHECK_DELAY_MS = 30_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let recheckTimer = null;
let promptOpen = false;

/**
 * Wire up background update checks. Safe to call unconditionally -- it
 * no-ops in dev and under the BLUBBER_DISABLE_UPDATER kill switch.
 *
 * @param {() => (import("electron").BrowserWindow | null)} getWindow
 *   Resolves the current main window at prompt time. Passed as a getter, not a
 *   window, because the window is created after this runs and can be destroyed
 *   and recreated (see createWindow / the "activate" handler in main.js).
 */
function initAutoUpdater(getWindow) {
  // Dev runs point at whatever is on disk; there is no installed app for NSIS
  // to update and no version to compare against a release.
  if (!app.isPackaged) return;
  if (process.env.BLUBBER_DISABLE_UPDATER === "1") {
    console.log("[updater] disabled via BLUBBER_DISABLE_UPDATER");
    return;
  }

  // Required lazily: electron-updater pulls in a chunk of dependencies, and
  // dev launches should not pay for a module they will never use.
  const { autoUpdater } = require("electron-updater");

  autoUpdater.logger = {
    info: (m) => console.log(`[updater] ${m}`),
    warn: (m) => console.warn(`[updater] ${m}`),
    error: (m) => console.error(`[updater] ${m}`),
    debug: () => {},
  };

  // Download as soon as something newer is found; prompt only once it is on
  // disk and ready. Prompting first would mean the user says yes and then
  // waits ~190 MB for a download that could have happened in the background.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // This app ships the plain `nsis` target, never `nsis-web`, so the web-installer
  // code path can never apply. electron-updater warns when this is left at its
  // current default of false and says it will default to true in a future version;
  // setting it explicitly silences the warning and keeps a path we do not use from
  // ever being taken.
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] update available: ${info?.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[updater] already on the newest version");
  });
  autoUpdater.on("download-progress", (p) => {
    console.log(`[updater] downloading ${Math.round(p?.percent ?? 0)}%`);
  });
  autoUpdater.on("error", (err) => {
    // Swallowed on purpose -- see the file header. An update problem is not
    // the user's problem.
    console.error(`[updater] check/download failed: ${err?.message ?? err}`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    // A second prompt while the first is open would stack modal dialogs on the
    // same window. Only one can ever be in flight.
    if (promptOpen) return;
    promptOpen = true;

    // Nothing further to download, and re-checking would only re-fire this.
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }

    const win = getWindow();
    try {
      const { response } = await dialog.showMessageBox(
        win && !win.isDestroyed() ? win : undefined,
        {
          type: "info",
          buttons: ["Restart now", "Later"],
          defaultId: 0,
          cancelId: 1,
          title: "Update ready",
          message: `Blubber ${info?.version} is ready to install.`,
          detail:
            "Blubber will close for a few seconds while it updates, then reopen. " +
            "Choose Later to install it the next time you quit.",
        },
      );

      if (response === 0) {
        // isSilent=true so the NSIS wizard does not reappear on an update the
        // user already agreed to (the first install is assisted --
        // oneClick:false -- but a re-install to the SAME location has nothing
        // left to ask). isForceRunAfter=true reopens Blubber afterwards.
        //
        // before-quit in main.js still runs, so the child server process is
        // taskkill'd before the installer swaps the files underneath it.
        autoUpdater.quitAndInstall(true, true);
      }
    } catch (err) {
      console.error(`[updater] prompt failed: ${err?.message ?? err}`);
    } finally {
      promptOpen = false;
    }
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error(`[updater] check threw: ${err?.message ?? err}`);
    });
  };

  // Release rehearsal: BLUBBER_UPDATER_CHECK_NOW=1 collapses the startup delay
  // so a packaged build can be launched and observed reaching the real feed,
  // instead of the update path only ever being exercised by customers.
  const firstDelay =
    process.env.BLUBBER_UPDATER_CHECK_NOW === "1" ? 0 : FIRST_CHECK_DELAY_MS;
  setTimeout(check, firstDelay);
  // Catches long-running installs -- Blubber is the kind of app that stays
  // open for days, and a launch-only check would never see a release shipped
  // in the meantime.
  recheckTimer = setInterval(check, RECHECK_INTERVAL_MS);

  app.on("before-quit", () => {
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
  });
}

module.exports = { initAutoUpdater };
