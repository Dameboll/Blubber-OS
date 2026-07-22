// SSE endpoint: GET /api/live
// Streams `event: usage\ndata: {"tokensInDelta":N,"tokensOutDelta":N,"totalToday":N}\n\n`
// fed by the module-level live-usage-watcher pub-sub. One-directional by
// design (per PLAN.md) -- this is intentionally NOT the WebSocket channel
// used for PTY sessions.

import { liveUsageWatcher, type UsagePayload } from "../../../server/live-usage-watcher";
import { isWorkspaceConnected } from "../../../server/connected-store";
import { getDemoLiveTick } from "../../../server/demo-dataset";

// This route depends on live server state (fs polling + in-memory
// EventEmitter) and must never be static-optimized or edge-bundled.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function encodeUsageEvent(payload: UsagePayload): string {
  return `event: usage\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET() {
  const encoder = new TextEncoder();

  // Placeholder until connected: never subscribe to the real live-usage
  // watcher (that's the machine's actual token burn) before a workspace has
  // been connected. One synthetic tick so the meter renders, then a quiet stream.
  if (!isWorkspaceConnected()) {
    const demoStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(encodeUsageEvent(getDemoLiveTick())));
      },
    });
    return new Response(demoStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: UsagePayload) => {
        try {
          controller.enqueue(encoder.encode(encodeUsageEvent(payload)));
        } catch {
          // Controller already closed (client disconnected); the listener
          // gets torn down in cancel() below.
        }
      };

      // Give a freshly-connected client today's running total immediately
      // instead of making it wait for the next real delta.
      send(liveUsageWatcher.getSnapshot());

      liveUsageWatcher.on("usage", send);

      // Comment-only heartbeat so long-idle connections (nothing running)
      // don't get reaped by an intermediary/dev-proxy timeout.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // ignore -- cleanup handles teardown
        }
      }, 15000);

      cleanup = () => {
        liveUsageWatcher.off("usage", send);
        clearInterval(heartbeat);
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable any buffering proxy in front of this (harmless locally,
      // correct if this ever runs behind nginx/etc.).
      "X-Accel-Buffering": "no",
    },
  });
}
