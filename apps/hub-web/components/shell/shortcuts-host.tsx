"use client";

import { matchShortcut } from "@ensemble/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { isApplePlatform } from "@/lib/platform";
import { activeShortcuts, useShortcuts } from "@/lib/shortcut-store";
import { standalonePageHref } from "../pages/page-href";
import { useToast } from "../toast";

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

const HANDLED = new Set(["palette", "help", "capture", "ask", "assistant", "new-task", "new-page", ...Object.keys(GO)]);

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
  const client = useQueryClient();
  const toast = useToast();
  useShortcuts();
  const buffer = useRef("");
  const creating = useRef(false);
  const createRef = useRef<(kind: "task" | "page") => void>(() => undefined);
  createRef.current = (kind) => {
    if (creating.current) return;
    creating.current = true;
    const work =
      kind === "page"
        ? api.createPage().then(({ page }) => {
            void client.invalidateQueries({ queryKey: ["pages"] });
            router.push(standalonePageHref(page.id, true));
          })
        : api.createTask({ title: "Untitled", status: "todo" }).then(({ task }) => {
            void client.invalidateQueries({ queryKey: ["tasks"] });
            router.push(`/tasks/${task.id}`);
          });
    void work
      .catch((error: Error) => toast(error.message, { tone: "error" }))
      .finally(() => {
        creating.current = false;
      });
  };
  const actions = useRef({ onPalette, onHelp, onCapture, onAsk });
  actions.current = { onPalette, onHelp, onCapture, onAsk };

  useEffect(() => {
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
      else if (id === "assistant") window.dispatchEvent(new CustomEvent("ensemble:assistant-toggle"));
      else if (id === "new-task") createRef.current("task");
      else if (id === "new-page") createRef.current("page");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "q") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") return;
      if (event.altKey && event.key.toLowerCase() === "f4") return;
      const typing = typingTarget(event);
      const apple = isApplePlatform();
      const bindings = activeShortcuts();
      const chord = matchShortcut(event, apple, typing, bindings);
      if (chord && HANDLED.has(chord.id)) {
        event.preventDefault();
        clear();
        run(chord.id);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const key = event.key.toLowerCase();
      const sequences = bindings.filter((binding) => binding.scope === "global" && binding.sequence?.length);
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
