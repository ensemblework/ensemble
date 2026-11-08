"use client";

/**
 * The Ensemble desktop app (docs/DESKTOP.md §1). With an account, its window shows this web app from
 * the account's own site; local-only, it shows the bundled Hub on the computer's own runtime
 * (`__ENSEMBLE_DESKTOP__.apiBase` is set only there). Both can ask the app for a few native actions.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type NativeWindow = Window & {
  __ENSEMBLE_DESKTOP__?: { apiBase?: string; version?: string; mode?: string };
  __TAURI__?: { core?: { invoke?: Invoke } };
};

function native(): NativeWindow["__ENSEMBLE_DESKTOP__"] | null {
  if (typeof window === "undefined") return null;
  return (window as NativeWindow).__ENSEMBLE_DESKTOP__ ?? null;
}

function invoker(): Invoke | null {
  if (typeof window === "undefined") return null;
  return (window as NativeWindow).__TAURI__?.core?.invoke ?? null;
}

/** The desktop app's window showing this account's web app (not the bundled Hub). */
export function inAccountApp(): boolean {
  const info = native();
  return Boolean(info?.version && !info.apiBase && invoker());
}

/** The bundled Hub inside the desktop app (local-only, on this computer's runtime). */
export function inLocalApp(): boolean {
  return Boolean(native()?.apiBase && invoker());
}

/**
 * Shows the app's own sign-in screen: the browser sign-in (any method works there) that signs this
 * window in, or, local-only, the one-time move to an account. False outside the app.
 */
export async function showAppAccountScreen(): Promise<boolean> {
  const invoke = invoker();
  if (!invoke || (!inAccountApp() && !inLocalApp())) return false;
  try {
    await invoke("show_account");
    return true;
  } catch {
    return false;
  }
}

/**
 * A connected app's sign-in in the app's window would finish in the system browser, which does not
 * share the window's session. The app opens this page in the browser instead, where the person
 * connects; the window picks up the new connection.
 */
export async function continueInBrowser(path: string): Promise<boolean> {
  const invoke = invoker();
  if (!invoke || !inAccountApp()) return false;
  try {
    await invoke("open_in_browser", { url: new URL(path, window.location.origin).toString() });
    return true;
  } catch {
    return false;
  }
}
