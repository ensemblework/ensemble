"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopShell } from "@/lib/desktop-param";

/**
 * The terminal opens only for a person's signed-in browser session. The desktop app signs in with a
 * token its agents use too, so the server refuses the terminal there (`TERMINAL_DESKTOP_REFUSAL` in
 * hub-api), and the desktop app says why instead of showing a terminal that cannot run.
 */
export const TERMINAL_DESKTOP_TITLE = "The terminal isn't available in the desktop app yet";
export const TERMINAL_DESKTOP_BODY =
  "The app signs in with the same token its agents use, so it can't show a command comes from you. Use your computer's own terminal app.";

/** `null` until mounted: the static export is rendered without the desktop bridge. */
export function useDesktopShell(): boolean | null {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => setDesktop(desktopShell()), []);
  return desktop;
}

export function TerminalDesktopNote() {
  return (
    <div role="note" data-testid="terminal-desktop-note" className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <TerminalSquare size={28} className="term-dim" />
      <div className="text-[13px] font-medium">{TERMINAL_DESKTOP_TITLE}</div>
      <div className="term-dim max-w-md text-[13px]">{TERMINAL_DESKTOP_BODY}</div>
    </div>
  );
}
