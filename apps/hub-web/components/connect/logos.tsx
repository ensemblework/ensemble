import type { ReactNode } from "react";
import type { AppId } from "@/lib/connect/catalog";

/** Small original marks so each app is recognizable. Decorative. */
export function AppMark({ id, size = 28 }: { id: AppId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      {MARKS[id]}
    </svg>
  );
}

const MARKS: Record<AppId, ReactNode> = {
  vscode: (
    <>
      <path fill="#007ACC" d="M18.2 4.2 7.6 14.1 4.4 11.6 2 13.2l3.4 2.8L2 18.8l2.4 1.6 3.2-2.5 10.6 9.9 11.2-5.4V9.6L18.2 4.2Z" />
      <path fill="#fff" fillOpacity=".92" d="M18.4 8.2 10.2 16l8.2 7.8V8.2Z" />
    </>
  ),
  copilot: (
    <>
      <rect width="32" height="32" rx="8" fill="#24292f" />
      <path fill="#fff" d="M16 7.2a5.2 5.2 0 0 0-1.6 10.1v1.4H12v2h2.4V23h2.2v-2.3H19v-2h-2.4v-1.5A5.2 5.2 0 0 0 16 7.2Zm0 2.2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />
    </>
  ),
  cursor: (
    <>
      <rect width="32" height="32" rx="8" fill="#111" />
      <path fill="#fff" d="M9 7.5 23.2 16 9 24.5V7.5Z" />
    </>
  ),
  "claude-code": (
    <>
      <rect width="32" height="32" rx="8" fill="#d97757" />
      <path fill="#fff" d="M16 6.5 18.2 13h6.8l-5.5 4.1 2.1 6.6L16 19.7 10.4 23.7l2.1-6.6L7 13h6.8L16 6.5Z" />
    </>
  ),
  "claude-desktop": (
    <>
      <rect width="32" height="32" rx="8" fill="#c96442" />
      <circle cx="16" cy="16" r="6.2" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="16" cy="16" r="2" fill="#fff" />
    </>
  ),
  codex: (
    <>
      <rect width="32" height="32" rx="8" fill="#10a37f" />
      <path fill="#fff" d="M16 6.2 19.2 13 26.4 14l-5.2 4.6 1.6 6.6L16 21.8 9.2 25.2l1.6-6.6L5.6 14 12.8 13 16 6.2Z" />
    </>
  ),
  windsurf: (
    <>
      <rect width="32" height="32" rx="8" fill="#0b6e6a" />
      <path fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" d="M6 18c2.2-4 4-4 6.2 0s4 4 6.2 0 4-4 6.2 0" />
      <path fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".7" d="M6 13c2.2-3 4-3 6.2 0s4 3 6.2 0 4-3 6.2 0" />
    </>
  ),
  zed: (
    <>
      <rect width="32" height="32" rx="8" fill="#1c1c1c" />
      <path fill="#f5d90a" d="M8.5 8h12.2L14 16.2h8.8L11.2 24H8.5l8.2-7.8H8.5V8Z" />
    </>
  ),
  jetbrains: (
    <>
      <rect width="32" height="32" rx="7" fill="#fe315d" />
      <path fill="#fff" d="M9 8h14v4.2h-6.2V24H12.6V12.2H9V8Z" />
    </>
  ),
  cline: (
    <>
      <rect width="32" height="32" rx="8" fill="#5b4dff" />
      <path fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M10 12.5 16 18l6-5.5M10 8.5 16 14l6-5.5" />
    </>
  ),
  continue: (
    <>
      <rect width="32" height="32" rx="8" fill="#3b82f6" />
      <path fill="none" stroke="#fff" strokeWidth="2.2" d="M10 16a6 6 0 1 1 2.2 4.7" />
      <path fill="#fff" d="M16.2 11.2 19 16l-2.8 4.8h-2.3L16.6 16l-2.7-4.8h2.3Z" />
    </>
  ),
  http: (
    <>
      <rect width="32" height="32" rx="8" fill="rgb(var(--accent-rgb))" />
      <circle cx="10" cy="16" r="2.2" fill="#fff" />
      <circle cx="22" cy="16" r="2.2" fill="#fff" />
      <path stroke="#fff" strokeWidth="1.8" d="M12.2 16h7.6" />
    </>
  ),
};
