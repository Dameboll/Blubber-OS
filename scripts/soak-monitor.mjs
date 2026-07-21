/**
 * soak-monitor — long-running unattended soak test for memory/SSE/WebGL
 * leaks (see scripts/soak-load-loop.mjs for the browser half).
 *
 * What this does, end to end:
 *   1. Spawns `node server.js` as a CHILD process on an isolated port
 *      (default 3210 -- never 3000, the normal dev port, or 3100, the
 *      Playwright e2e suite's port, see playwright.config.ts) and with an
 *      isolated Next dist dir (NEXT_DIST_DIR=.next-soak) so this run can
 *      never clobber or be clobbered by a real `npm run dev` or `npm run
 *      build` happening at the same time (see next.config.js's own header
 *      comment on why sharing a dist dir between two live processes
 *      corrupts both).
 *   2. Waits for that server to actually answer HTTP requests.
 *   3. Every SAMPLE_INTERVAL_MS (default 5 min), samples the SERVER
 *      child's OS-level memory (working set / private bytes / handle
 *      count) via `Get-Process` -- NOT process.memoryUsage(), which would
 *      only ever report THIS (monitor) process's own heap, never the
 *      server child's -- and appends it to the log.
 *   4. Launches a real headless Chromium via Playwright and hands it to
 *      soak-load-loop.mjs, which continuously cycles through every nav
 *      screen and opens/closes real terminal tabs for the soak duration.
 *   5. After DURATION_MS (default 4.5h) -- or if the load loop gives up
 *      early -- tears everything down: closes the browser, force-kills the
 *      ENTIRE server process tree (taskkill /T /F, so any `claude` PTY
 *      processes the load loop spawned along the way get cleaned up too,
 *      not just the top-level node.exe), and writes a final summary line.
 *
 * Usage:
 *   node scripts/soak-monitor.mjs
 *
 * Overridable via env vars (all optional -- used for the short smoke-test
 * run before the real 4.5h soak, see the header comment in this repo's soak
 * verification notes):
 *   SOAK_PORT                 (default 3210)
 *   SOAK_DURATION_MS          (default 4.5 * 60 * 60 * 1000)
 *   SOAK_SAMPLE_INTERVAL_MS   (default 5 * 60 * 1000)
 *
 * Reading the results later:
 *   - Log lives at logs/soak-<ISO-timestamp>.log (gitignored -- this script
 *     and its sibling are the committed artifacts, not the log output).
 *   - A HEALTHY run: `[memory]` RSS climbs during initial warmup (JIT
 *     warming, Next dev-mode route compilation, module caches filling) then
 *     PLATEAUS -- later samples bounce in a stable band rather than
 *     climbing every single sample.
 *   - A CONCERNING run: RSS (or handle count) climbs on nearly every
 *     `[memory]` sample with no plateau, especially if the slope tracks the
 *     number of `[loop] cycle N complete` lines seen so far -- that's the
 *     signature of a per-nav-cycle leak (an unmounted <Flubber3D> WebGL
 *     context never disposed, an SSE EventSource never closed, a PTY
 *     process/handle never released). Also grep the log for
 *     `[browser:console:error]`, `[browser:pageerror]`, `[browser:CRASH]`,
 *     and `[server:stderr]` -- any of those appearing repeatedly (not just
 *     once at startup) is worth investigating even if memory looks flat.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runLoadLoop } from './soak-load-loop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.SOAK_PORT || '3210';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DURATION_MS = Number(process.env.SOAK_DURATION_MS) || 4.5 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = Number(process.env.SOAK_SAMPLE_INTERVAL_MS) || 5 * 60 * 1000;
const SERVER_BOOT_TIMEOUT_MS = 90_000;
// Isolated Next dist dir -- see header comment. Never `.next` (real dev
// server) or `.next-build` (production build output).
const NEXT_DIST_DIR = '.next-soak';

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const logDir = path.join(ROOT, 'logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `soak-${stamp}.log`);

function log(line) {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

log(
  `=== SOAK TEST START === port=${PORT} durationHrs=${(DURATION_MS / 3_600_000).toFixed(2)} ` +
    `sampleEveryMin=${(SAMPLE_INTERVAL_MS / 60_000).toFixed(1)} monitorPid=${process.pid}`,
);

// ---------------------------------------------------------------------------
// 1. Spawn the server as a real child process (not required in-process --
//    we need its OS-level PID to sample memory independently of this
//    monitor's own memory).
// ---------------------------------------------------------------------------
const serverEnv = { ...process.env, PORT, NEXT_DIST_DIR };
const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
log(`[monitor] server child spawned pid=${serverProc.pid}`);

serverProc.stdout.on('data', (buf) => {
  for (const line of buf.toString().split(/\r?\n/)) {
    if (line.trim()) log(`[server:stdout] ${line}`);
  }
});
serverProc.stderr.on('data', (buf) => {
  for (const line of buf.toString().split(/\r?\n/)) {
    if (line.trim()) log(`[server:stderr] ${line}`);
  }
});
serverProc.on('exit', (code, signal) => {
  log(`[monitor] server process exited unexpectedly code=${code} signal=${signal}`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet, or still compiling -- keep polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** OS-level memory sample for an arbitrary PID via PowerShell's Get-Process
 * -- works regardless of how that PID was spawned, unlike
 * process.memoryUsage() which only ever sees the calling process itself. */
function sampleMemory(pid) {
  return new Promise((resolve) => {
    const psCommand =
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ` +
      `Select-Object WorkingSet64,PrivateMemorySize64,NonpagedSystemMemorySize64,Handles,` +
      `@{Name='ThreadCount';Expression={$_.Threads.Count}} | ` +
      `ConvertTo-Json -Compress`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

let sampleTimer = null;
function startSampling(pid) {
  const mb = (bytes) => (bytes / 1_048_576).toFixed(1);
  const doSample = async () => {
    const mem = await sampleMemory(pid);
    if (!mem) {
      log(`[memory] pid=${pid} sample FAILED (process may have exited or PowerShell call failed)`);
      return;
    }
    log(
      `[memory] pid=${pid} RSS=${mb(mem.WorkingSet64)}MB private=${mb(mem.PrivateMemorySize64)}MB ` +
        `nonpaged=${mb(mem.NonpagedSystemMemorySize64)}MB handles=${mem.Handles} threads=${mem.ThreadCount}`,
    );
  };
  doSample();
  sampleTimer = setInterval(doSample, SAMPLE_INTERVAL_MS);
}
function stopSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
}

/** Force-kills the server's ENTIRE process tree. Plain `serverProc.kill()`
 * only guarantees the top-level node.exe dies -- any `claude` PTY child
 * processes the load loop spawned via TabBar's terminal tabs (see
 * src/server/pty-manager.ts) are separate OS processes that a bare kill()
 * can leave orphaned after an unattended multi-hour run. `taskkill /T /F`
 * kills the whole tree in one shot. */
function killServerTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) log(`[monitor] taskkill for pid=${pid} reported: ${stderr || err.message}`);
      else log(`[monitor] taskkill for pid=${pid} succeeded: ${stdout.trim()}`);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Shutdown / teardown
// ---------------------------------------------------------------------------
let browser = null;
let shuttingDown = false;

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`=== SHUTTING DOWN === reason=${reason}`);
  stopSampling();

  try {
    await browser?.close();
    log('[monitor] browser closed');
  } catch (err) {
    log(`[monitor] browser close error: ${err?.stack || err}`);
  }

  try {
    await killServerTree(serverProc.pid);
  } catch (err) {
    log(`[monitor] server teardown error: ${err?.stack || err}`);
  }

  const finishedAt = new Date();
  log(
    `=== SOAK TEST END === startedAt=${startedAt.toISOString()} endedAt=${finishedAt.toISOString()} ` +
      `elapsedMin=${((finishedAt - startedAt) / 60_000).toFixed(1)} reason=${reason}`,
  );
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => log(`[monitor:uncaughtException] ${err?.stack || err}`));
process.on('unhandledRejection', (err) => log(`[monitor:unhandledRejection] ${err?.stack || err}`));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const ready = await waitForServer(BASE_URL, SERVER_BOOT_TIMEOUT_MS);
  if (!ready) {
    log(`[monitor] server never became ready at ${BASE_URL} within ${SERVER_BOOT_TIMEOUT_MS}ms -- aborting`);
    await shutdown('server-boot-failed');
    return;
  }
  log(`[monitor] server ready at ${BASE_URL}`);
  startSampling(serverProc.pid);

  browser = await chromium.launch({ headless: true });
  log('[monitor] headless Chromium launched');

  // Hard safety-net timer: whatever the load loop is doing, the process
  // self-terminates at (approximately) the requested duration no matter
  // what. The loop itself is also handed a slightly earlier deadline (30s
  // buffer) so it has time to close its own browser context cleanly before
  // this fires.
  const hardTimer = setTimeout(() => shutdown('duration-elapsed'), DURATION_MS);
  hardTimer.unref?.();

  const loopDeadline = Date.now() + DURATION_MS - 30_000;

  try {
    await runLoadLoop({ browser, baseUrl: BASE_URL, deadlineTs: loopDeadline, log });
  } catch (err) {
    log(`[monitor] load loop threw: ${err?.stack || err}`);
  }

  clearTimeout(hardTimer);
  await shutdown('loop-complete');
})();
