/**
 * server.js
 *
 * Custom Next.js server: one HTTP server hosting both Next's request handler
 * and a `ws` WebSocketServer, because App Router API routes don't support raw
 * WebSockets. Implements the exact message contract from PLAN.md:
 *
 *   Client -> Server: spawn / input / resize / kill
 *   Server -> Client: output / exit / spawned
 *
 * WebSocket endpoint: ws://localhost:<port>/ws
 *
 * src/server/pty-manager.ts is TypeScript, so we register ts-node in
 * transpile-only mode (forcing CommonJS output regardless of the project's
 * tsconfig `module` setting) before requiring it, so a plain `node server.js`
 * can load it with no separate build step.
 */

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
  },
});

const http = require("http");
const crypto = require("node:crypto");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");

// node-pty's internal ConPTY exit-detection helper (conpty_console_list_agent.js)
// can throw "AttachConsole failed" depending on how the parent process's console
// is attached (e.g. when launched with no visible window). That's an internal
// node-pty implementation detail unrelated to any one PTY session being broken --
// it should never be allowed to take down every terminal tab and the whole
// dashboard with it. Log it and keep serving.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] server stayed up:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] server stayed up:", reason);
});
const {
  spawnSession,
  writeToSession,
  resizeSession,
  killSession,
} = require("./src/server/pty-manager.ts");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
// The actual socket bind address (see server.listen below). Explicit IPv4
// loopback -- NOT the `hostname` string above, which is only used for Next's
// internal config and the startup log line. Passing "localhost" to
// server.listen() would go through DNS/hosts resolution and can land on
// either 127.0.0.1 or ::1 (or, on a misconfigured host, something else)
// depending on the OS. Binding the literal loopback address is what actually
// guarantees this server is unreachable from any other device on the LAN.
const BIND_HOST = "127.0.0.1";
const port = parseInt(process.env.PORT || "3000", 10);
const WS_PATH = "/ws";
// Same-origin-only token endpoint. Served directly by this file (not a Next
// route) so the token that's handed out and the token checked on WS upgrade
// are guaranteed to be the exact same in-memory value.
const WS_TOKEN_PATH = "/__ws-auth";

// A single per-process secret, generated fresh at server start. Required as
// a `?token=` query param on every PTY WebSocket upgrade. This exists
// because a localhost bind alone doesn't stop an unrelated page open in the
// same browser (e.g. a malicious tab) from trying to drive this PTY over
// WebSocket -- browsers don't apply same-origin restrictions to opening a
// WebSocket connection the way they do to reading a fetch() response. The
// token endpoint below IS same-origin-protected (default CORS blocks a
// foreign page's JS from reading the response body), so a foreign page can
// never learn the token and therefore can never open an authorized PTY
// socket. Deliberately not a full auth system -- one secret, one
// timing-safe comparison.
const wsAuthToken = crypto.randomBytes(32).toString("hex");

function isValidWsToken(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(wsAuthToken);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
// Next's own websocket upgrades (dev-mode HMR at /_next/webpack-hmr). Before
// this, the upgrade handler below destroyed EVERY non-/ws upgrade socket, so
// the dev client's HMR connection died on arrival and retried in a loop
// forever — broken hot reload AND a steady drip of doomed connection attempts
// competing for the browser's 6-per-origin connection budget.
const nextUpgradeHandler = app.getUpgradeHandler();

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname === WS_TOKEN_PATH) {
      // No CORS headers are set here on purpose: without
      // Access-Control-Allow-Origin, the browser lets the request go out but
      // blocks any foreign-origin page's JS from reading the response body,
      // so only same-origin app code can ever actually obtain the token.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ token: wsAuthToken }));
      return;
    }
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = parse(req.url, true);
    if (pathname !== WS_PATH) {
      // Hand everything that isn't OUR pty socket to Next (dev HMR etc.)
      // instead of killing it — see nextUpgradeHandler comment above.
      nextUpgradeHandler(req, socket, head);
      return;
    }
    if (!isValidWsToken(query.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    // Sessions this specific socket spawned, so we can clean up orphaned
    // `claude` processes if the browser tab/connection disappears without
    // sending an explicit `kill`.
    const ownedSessions = new Set();

    const send = (message) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
      }
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.error("[ws] received malformed message:", err);
        return;
      }

      switch (msg.type) {
        case "spawn": {
          const { sessionId, cwd, initialPrompt } = msg;
          ownedSessions.add(sessionId);
          spawnSession({
            sessionId,
            cwd,
            initialPrompt,
            onData: (data) => send({ type: "output", sessionId, data }),
            onExit: (code) => {
              send({ type: "exit", sessionId, code });
              ownedSessions.delete(sessionId);
            },
            onSpawned: () => send({ type: "spawned", sessionId }),
          });
          break;
        }
        case "input": {
          writeToSession(msg.sessionId, msg.data);
          break;
        }
        case "resize": {
          resizeSession(msg.sessionId, msg.cols, msg.rows);
          break;
        }
        case "kill": {
          killSession(msg.sessionId);
          ownedSessions.delete(msg.sessionId);
          break;
        }
        default:
          console.warn("[ws] unknown message type:", msg.type);
      }
    });

    ws.on("close", () => {
      for (const sessionId of ownedSessions) {
        killSession(sessionId);
      }
      ownedSessions.clear();
    });
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `\n[server] Port ${port} is already in use.\n` +
          `Another Blubber (or process) is holding it. Kill that process, or start with a different port:\n` +
          `  PORT=3001 npm run dev\n`,
      );
      process.exit(1);
    }
    console.error("[server] listen error:", err);
    process.exit(1);
  });

  // Node's default keepAliveTimeout is 5s. Any client that reuses a pooled
  // keep-alive socket after >5s of idle (easy when dev-mode compiles make
  // request gaps long) races the server's close and gets ECONNRESET.
  // Browsers silently retry; plain HTTP clients (Playwright's request
  // fixture, scripts, the Electron shell) surface it as a hard error.
  // Standard remedy: hold sockets open longer than any sane client pool
  // idle time, with headersTimeout kept just above it (Node requires
  // headersTimeout > keepAliveTimeout to avoid a different reset bug).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.listen(port, BIND_HOST, () => {
    console.log(`> Blubber ready on http://${hostname}:${port} (ws: ${WS_PATH})`);
  });
});
