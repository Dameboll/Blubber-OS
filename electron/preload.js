/**
 * electron/preload.js
 *
 * Bridges the one native capability the renderer can't do over plain fetch:
 * opening the OS "choose a folder" dialog. Everything else (external links,
 * data) still goes through window.open / normal fetch. contextIsolation is on
 * and nodeIntegration is off, so this is the ONLY surface exposed to the page —
 * a single, named, promise-returning function, no raw ipcRenderer or Node.
 *
 * window.blubberNative.pickFolder({ title }) -> Promise<string | null>
 *   Resolves to the chosen absolute directory path, or null if the user
 *   cancelled. In a plain browser tab window.blubberNative is undefined, so
 *   callers must handle its absence and fall back (e.g. a manual path input).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blubberNative", {
  isElectron: true,
  pickFolder: (options) => ipcRenderer.invoke("blubber:pick-folder", options ?? {}),
  addProjectRoot: (options) => ipcRenderer.invoke("blubber:add-project-root", options ?? {}),
});
