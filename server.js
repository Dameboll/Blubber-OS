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
const port = parseInt(process.env.PORT || "3000", 10);
const WS_PATH = "/ws";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);
    if (pathname !== WS_PATH) {
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
          `Another DameOS (or process) is holding it. Kill that process, or start with a different port:\n` +
          `  PORT=3001 npm run dev\n`,
      );
      process.exit(1);
    }
    console.error("[server] listen error:", err);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`> DameOS ready on http://${hostname}:${port} (ws: ${WS_PATH})`);
  });
});
