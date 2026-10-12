"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Plus } from "lucide-react";
import { useState } from "react";
import type { AppItem } from "@ensemble/shared-types";
import { AppItemPicker } from "./app-item-picker";
import { sourceInfo, useAppItemSources } from "./use-app-items";

export function appItemLine(item: AppItem, app: string): string {
  return `From ${app}: “${item.title}”${item.url ? ` ${item.url}` : ""}`;
}

/** Puts a line naming an item from a connected app into the assistant's message, so the person can ask about it. */
export function AddAppItemToMessage({ onInsert }: { onInsert: (line: string) => void }) {
  const { sources } = useAppItemSources();
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <>
      <button type="button" className="flex items-center gap-1 hover:text-ink" onClick={() => setOpen(true)}>
        <Plus size={12} aria-hidden /> From your apps
      </button>
      <AppItemPicker
        open={open}
        onClose={() => setOpen(false)}
        title="Ask about something in your apps"
        actionLabel="Add to message"
        onPick={(item) => {
          onInsert(appItemLine(item, sourceInfo(sources, item.source).name));
          setOpen(false);
        }}
      />
    </>
  );
}
