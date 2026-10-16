"use client";

import { matchShortcut } from "@ensemble/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { isApplePlatform } from "@/lib/platform";
import { activeShortcuts, useShortcuts } from "@/lib/shortcut-store";
import { SEQUENCE_MS, sequenceStep } from "@/lib/shortcut-sequence";
import { GO_ROUTES, shortcutAvailable } from "@/lib/shortcut-help";
import { standalonePageHref } from "../pages/page-href";
import { useToast } from "../toast";

const HANDLED = new Set(["palette", "help", "capture", "ask", "assistant", "new-task", "new-page", ...Object.keys(GO_ROUTES)]);

function typingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable=true], [contenteditable=''], .cm-editor"));
}

/** A dialog keeps its letters: G then S must not navigate away from an open form or menu. */
function inDialog(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest?.("[role=dialog], [data-modal-layer], [data-layout-editing]"));
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
      const href = GO_ROUTES[id];
      if (href) {
        const binding = activeShortcuts().find((item) => item.id === id);
        const modules = client.getQueryData<{ modules?: string | null }>(["shell"])?.modules;
        if (binding && !shortcutAvailable(binding, modules)) return;
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
      const chord = matchShortcut(event, apple, typing, activeShortcuts());
      if (chord && HANDLED.has(chord.id)) {
        event.preventDefault();
        clear();
        run(chord.id);
      }
    };
    // Letter sequences run in the capture phase: a page's own key handler (a board card, a
    // Today tile) would otherwise stop the event first or act on the second letter too.
    const onSequence = (event: KeyboardEvent) => {
      const step = sequenceStep(buffer.current, event, typingTarget(event) || inDialog(event), activeShortcuts());
      buffer.current = step.buffer;
      window.clearTimeout(timer);
      if (step.hit) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clear();
        run(step.hit);
        return;
      }
      if (step.buffer) timer = window.setTimeout(clear, SEQUENCE_MS);
    };
    window.addEventListener("keydown", onSequence, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onSequence, true);
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [router, client]);

  return null;
}
