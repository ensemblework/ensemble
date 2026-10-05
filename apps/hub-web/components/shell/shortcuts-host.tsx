"use client";

import { SHORTCUTS, matchShortcut } from "@ensemble/shared-types";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isApplePlatform } from "@/lib/platform";

const GO: Record<string, string> = {
  "go-today": "/today",
  "go-board": "/board",
  "go-needs": "/needs-me",
  "go-meetings": "/meetings",
  "go-recap": "/recap",
  "go-settings": "/settings",
  "go-diagrams": "/diagrams",
  "go-plots": "/plots",
};

function typingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest("input, textarea, select, [contenteditable=true], .cm-editor"));
}

/** Global chords and left-hand sequences from the shared shortcut list. */
export function ShortcutsHost({
  onPalette,
  onHelp,
  onCapture,
  onAsk,
}: {
  onPalette: () => void;
  onHelp: () => void;
  onCapture: () => void;
  onAsk: () => void;
}) {
  const router = useRouter();
  const buffer = useRef("");
  const actions = useRef({ onPalette, onHelp, onCapture, onAsk });
  actions.current = { onPalette, onHelp, onCapture, onAsk };

  useEffect(() => {
    const sequences = SHORTCUTS.filter((binding) => binding.scope === "global" && binding.sequence?.length);
    let timer = 0;
    const clear = () => {
      buffer.current = "";
      window.clearTimeout(timer);
    };
    const run = (id: string) => {
      const href = GO[id];
      if (href) {
        router.push(href);
        return;
      }
      if (id === "palette") actions.current.onPalette();
      else if (id === "help") actions.current.onHelp();
      else if (id === "capture" || id === "capture-key") actions.current.onCapture();
      else if (id === "ask") actions.current.onAsk();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "q") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") return;
      if (event.altKey && event.key.toLowerCase() === "f4") return;
      const typing = typingTarget(event);
      const apple = isApplePlatform();
      const chord = matchShortcut(event, apple, typing);
      if (chord && (chord.id === "palette" || chord.id === "help" || chord.id === "capture" || chord.id === "ask")) {
        event.preventDefault();
        clear();
        run(chord.id);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const key = event.key.toLowerCase();
      buffer.current = (buffer.current + key).slice(-2);
      const hit = sequences.find((binding) => binding.sequence?.join("") === buffer.current);
      if (hit) {
        event.preventDefault();
        clear();
        run(hit.id);
        return;
      }
      const prefix = sequences.some((binding) => (binding.sequence ?? []).join("").startsWith(buffer.current));
      window.clearTimeout(timer);
      if (!prefix) buffer.current = "";
      else timer = window.setTimeout(clear, 700);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [router]);

  return null;
}
