"use client";

import { confirmAction } from "@/components/ask-dialog";

/** Settings forms with typed changes that are not saved yet, by name. Settings saves everything else as you go. */
const unsaved = new Set<string>();

export function markUnsaved(key: string, on: boolean): void {
  if (on) unsaved.add(key);
  else unsaved.delete(key);
}

export function hasUnsaved(): boolean {
  return unsaved.size > 0;
}

/** Before leaving a Settings tab: true when nothing is unsaved, or the person chose to discard it. */
export async function confirmLeaveSettings(): Promise<boolean> {
  if (!unsaved.size) return true;
  const leave = await confirmAction({
    title: "Discard unsaved changes?",
    body: "Your profile or password changes on this tab are not saved. Discard them, or cancel and save them first.",
    confirm: "Discard changes",
    danger: true,
  });
  if (leave) unsaved.clear();
  return leave;
}
