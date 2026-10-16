/**
 * The system folder picker inside the desktop app (tauri-plugin-dialog via
 * `withGlobalTauri`). `undefined` means there is no native picker here, so the
 * caller falls back to the API route or a typed path. The chosen path is only
 * a suggestion: hub-api resolves and validates it like a typed one.
 */
type TauriDialog = { open: (options: { directory: boolean; multiple: boolean; title?: string }) => Promise<string | string[] | null> };

export async function pickFolderNative(title: string): Promise<string | null | undefined> {
  if (typeof window === "undefined") return undefined;
  const dialog = (window as unknown as { __TAURI__?: { dialog?: TauriDialog } }).__TAURI__?.dialog;
  const core = (window as unknown as { __TAURI__?: { core?: { invoke: (command: string, args: unknown) => Promise<string | string[] | null> } } }).__TAURI__?.core;
  if (!dialog?.open && !core?.invoke) return undefined;
  const options = { directory: true, multiple: false, title };
  const chosen = dialog?.open ? await dialog.open(options) : await core!.invoke("plugin:dialog|open", { options });
  if (Array.isArray(chosen)) return chosen[0] ?? null;
  return chosen ?? null;
}
