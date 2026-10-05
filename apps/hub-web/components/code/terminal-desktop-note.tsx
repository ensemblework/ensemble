"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Fingerprint } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopShell } from "@/lib/desktop-param";

/**
 * The terminal opens only after a platform passkey check (Touch ID, Windows
 * Hello). The desktop webview cannot run that check yet, and the desktop
 * token alone must never open the terminal, because agents use that token
 * too. So the desktop app says why the terminal is not there instead of
 * showing a set-up flow that cannot finish.
 */
export const TERMINAL_DESKTOP_TITLE = "The terminal isn't available in the desktop app yet";
export const TERMINAL_DESKTOP_BODY =
  "The terminal only opens after your computer confirms it's you with Touch ID or Windows Hello, so no agent or script can run commands in it. The desktop app can't ask for that check yet. Until it can, use your computer's own terminal app.";

/** `null` until mounted: the static export is rendered without the desktop bridge. */
export function useDesktopShell(): boolean | null {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => setDesktop(desktopShell()), []);
  return desktop;
}

export function TerminalDesktopNote() {
  return (
    <div role="note" data-testid="terminal-desktop-note" className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <Fingerprint size={28} className="term-dim" />
      <div className="text-[13px] font-medium">{TERMINAL_DESKTOP_TITLE}</div>
      <div className="term-dim max-w-md text-[13px]">{TERMINAL_DESKTOP_BODY}</div>
    </div>
  );
}
