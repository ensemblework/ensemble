"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isApplePlatform } from "@/lib/platform";
import { formatBinding, SHORTCUTS } from "@ensemble/shared-types";
import { useShortcuts } from "@/lib/shortcut-store";
import { useToast } from "../toast";
import { plainMentions } from "@/lib/mentions/text";
import { MentionPopover, useMentionMenu } from "../mentions/mention-menu";

export function QuickCapture({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const mention = useMentionMenu({ value: text, onValue: setText, inputRef: input });
  // The person's own chord when they changed it in Settings → Shortcuts.
  const { bindings } = useShortcuts();
  const apple = isApplePlatform();
  const label = formatBinding(bindings.find((binding) => binding.id === "capture") ?? SHORTCUTS.find((binding) => binding.id === "capture")!, apple);
  const saveKeys = apple ? "⌘↩" : "Ctrl+Enter";

  useEffect(() => {
    if (!open) return;
    setText("");
    const frame = requestAnimationFrame(() => input.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const save = useMutation({
    // Capture reads names from plain text, so `@people:Priya Shah` goes as `Priya Shah`.
    mutationFn: () => api.capture(plainMentions(text).trim()),
    onSuccess: (result) => {
      const due = result.parsed.dueLabel ? ` · due ${result.parsed.dueLabel}` : "";
      const who = result.parsed.matched.map((person) => person.name).concat(result.parsed.unmatched);
      const people = who.length ? ` · ${who.join(", ")}` : "";
      const entryId = result.undoEntryId;
      toast(`Saved “${result.task.title}”${people}${due}`, {
        action: entryId
          ? {
              label: "Undo",
              run: () => {
                void api
                  .undo(entryId)
                  .then(() => client.invalidateQueries({ queryKey: ["desk-live"] }))
                  .catch((error: Error) => toast(error.message, { tone: "error" }));
              },
            }
          : undefined,
      });
      void client.invalidateQueries({ queryKey: ["desk-live"] });
      onClose();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[75] flex items-start justify-center bg-black/45 px-4 pt-[18vh]" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-label="Quick capture"
        className="pop-in w-full max-w-[520px] rounded-xl border border-line-strong bg-panel p-4 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) save.mutate();
        }}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">Quick capture</h2>
          <span className="kbd" title="Opens Quick capture from anywhere in Ensemble">{label}</span>
        </div>
        <p id="quick-capture-hint" className="mb-3 text-[12.5px] text-muted">Type a reminder. A name and a day become a person and a due date. {saveKeys} saves.</p>
        <MentionPopover menu={mention} />
        <textarea
          ref={input}
          value={text}
          {...mention.inputProps}
          onKeyDown={(event) => {
            if (mention.onKeyDown(event) || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            if (text.trim() && !save.isPending) save.mutate();
          }}
          aria-label="Reminder to capture"
          aria-describedby="quick-capture-hint"
          rows={3}
          placeholder="Remind Priya about the contract Friday"
          className="field w-full resize-none"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={!text.trim() || save.isPending}>
            {save.isPending ? "Saving…" : "Save task"}
          </button>
        </div>
      </form>
    </div>
  );
}
