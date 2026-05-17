/**
 * Desktop (Tauri) runtime bridges.
 *
 * H228 — file-system save export/import via the Tauri 2.x dialog
 * and fs plugins. Browsers can't open a native "save as" dialog
 * (the H160 path falls back to blob+download-anchor); on desktop
 * users expect a real picker so they can drop saves into a
 * specific folder.
 *
 * Talks to Tauri through `window.__TAURI_INTERNALS__.invoke` —
 * the global that withGlobalTauri=true exposes in tauri.conf.json.
 * No `@tauri-apps/api` import needed; the plugins are registered
 * on the Rust side and reached via their standard invoke command
 * names (`plugin:dialog|save`, etc).
 *
 * Every helper is async + best-effort: returns null/false on
 * failure rather than throwing, so callers can fall through to
 * the browser-path equivalent without try/catch.
 */

/** Narrow type for the global Tauri invoke surface. We don't pull
 *  in the SDK types so the browser build doesn't need the package
 *  installed. */
interface TauriGlobal {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface TauriWindow {
  __TAURI_INTERNALS__?: TauriGlobal;
  __TAURI__?: { invoke?: TauriGlobal['invoke'] };
}

function getTauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as TauriWindow;
  // Tauri 2.x stable: __TAURI_INTERNALS__ is the canonical
  // global. Tauri 1.x legacy fallback: __TAURI__.invoke (kept
  // for any pre-2.x dev environments).
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__;
  if (w.__TAURI__?.invoke) return { invoke: w.__TAURI__.invoke };
  return null;
}

/** True when running inside a Tauri webview. Caller branches on
 *  this to pick between the native and the browser file paths. */
export function isTauriRuntime(): boolean {
  return getTauri() !== null;
}

/** Open a native "save as" dialog, write the given content to the
 *  chosen path. Returns true on success, false on cancel / error.
 *
 *  Filter is JSON-only by default. Caller picks the suggested file
 *  name (defaultPath); the user can change it in the dialog. */
export async function saveFileNative(
  content: string,
  defaultFileName: string,
): Promise<boolean> {
  const t = getTauri();
  if (!t) return false;
  try {
    const path = await t.invoke('plugin:dialog|save', {
      options: {
        defaultPath: defaultFileName,
        filters: [{ name: 'Driver City save', extensions: ['json'] }],
      },
    });
    if (typeof path !== 'string' || path.length === 0) return false;
    await t.invoke('plugin:fs|write_text_file', { path, contents: content });
    return true;
  } catch {
    return false;
  }
}

/** Open a native file picker, return the chosen file's contents.
 *  Returns null on cancel / error. JSON-only filter by default. */
export async function openFileNative(): Promise<string | null> {
  const t = getTauri();
  if (!t) return null;
  try {
    const path = await t.invoke('plugin:dialog|open', {
      options: {
        multiple: false,
        directory: false,
        filters: [{ name: 'Driver City save', extensions: ['json'] }],
      },
    });
    if (typeof path !== 'string' || path.length === 0) return null;
    const contents = await t.invoke('plugin:fs|read_text_file', { path });
    return typeof contents === 'string' ? contents : null;
  } catch {
    return null;
  }
}
