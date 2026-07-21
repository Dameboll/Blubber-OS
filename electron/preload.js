/**
 * electron/preload.js
 *
 * Intentionally minimal. The renderer loads the exact same Next.js UI as
 * any browser tab hitting http://127.0.0.1:<port> -- it talks to the app
 * over normal fetch()/WebSocket calls and has no reason to reach into
 * Node or Electron APIs directly. contextIsolation + sandbox are both on
 * (see main.js webPreferences), and nodeIntegration is off, so nothing is
 * exposed here.
 *
 * This file exists so main.js has a concrete preload script to point at,
 * and as the one place to add a `contextBridge.exposeInMainWorld(...)`
 * call later if a real native-integration need ever comes up (native
 * notifications, file-system dialogs, etc). Until then: no-op.
 */
