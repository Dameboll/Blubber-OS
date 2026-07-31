/**
 * Thin, SSR-safe wrapper around the Electron preload bridge (electron/preload.js).
 * In a packaged Blubber window `window.blubberNative` exists; in a plain browser
 * tab (or during SSR) it doesn't, so every call degrades gracefully.
 */

interface BlubberNative {
  isElectron: boolean;
  pickFolder(options?: { title?: string }): Promise<string | null>;
}

export type ProjectRootKind = "project" | "container";

export interface AddProjectRootResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  root?: { id: string; label: string; path: string; custom: boolean; kind: ProjectRootKind };
}

declare global {
  interface Window {
    blubberNative?: BlubberNative;
  }
}

/** True only inside the packaged Electron app (where native dialogs work). */
export function isElectron(): boolean {
  return typeof window !== "undefined" && Boolean(window.blubberNative?.isElectron);
}

/**
 * Open the OS folder picker. Returns the chosen absolute path, or null if the
 * user cancelled OR we're not in Electron (caller should fall back to a manual
 * path field in that case).
 */
export async function pickFolder(title?: string): Promise<string | null> {
  if (typeof window === "undefined" || !window.blubberNative) return null;
  return window.blubberNative.pickFolder({ title });
}

/** Ask Electron's trusted main process to pick and register a projects folder.
 * The absolute selected path never comes from renderer-controlled JSON. */
export async function addProjectRoot(
  title?: string,
  kind: ProjectRootKind = "project",
): Promise<AddProjectRootResult | null> {
  if (typeof window === "undefined" || !window.blubberNative) return null;
  const native = window.blubberNative as BlubberNative & {
    addProjectRoot?: (options?: { title?: string; kind?: ProjectRootKind }) => Promise<AddProjectRootResult>;
  };
  if (typeof native.addProjectRoot !== "function") return null;
  return native.addProjectRoot({ title, kind });
}

// Shopify checkout for the Starter Kit. The free build's "Get the Starter Kit"
// button opens this in the user's real browser (window.open -> Electron's
// setWindowOpenHandler -> openExternal).
//
// ⚠️ REPLACE BEFORE LAUNCH: this must be the PUBLIC storefront product URL, not
// the admin.shopify.com editor link (customers can't open that — it's login-
// gated). Public form: https://flubberos.myshopify.com/products/<product-handle>
// (or the custom domain once the store is live). Best-guess handle below —
// confirm the real handle in Shopify → Products → the kit → "View".
export const SHOPIFY_KIT_URL = "https://flubberos.myshopify.com/products/blubber-starter-kit";
