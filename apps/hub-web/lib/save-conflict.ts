import { resolveSave, type SaveConflict, type SaveObject } from "@ensemble/shared-types/save-merge";

type Pending = { conflict: SaveConflict; resolve: (choice: "saved" | "yours" | null) => void };
const queue: Pending[] = [];
let changed: (() => void) | null = null;

export function chooseSave(conflict: SaveConflict): Promise<{ patch: SaveObject; base: SaveObject } | null> {
  return new Promise((resolve) => {
    queue.push({ conflict, resolve: (choice) => resolve(choice ? { patch: resolveSave(conflict, choice), base: conflict.current } : null) });
    changed?.();
  });
}

export function listenSaveChoices(listener: () => void): () => void {
  changed = listener;
  listener();
  return () => { changed = null; };
}

export function pendingSaveChoice() { return queue[0]?.conflict ?? null; }
export function answerSaveChoice(choice: "saved" | "yours" | null) {
  queue.shift()?.resolve(choice);
  changed?.();
}

export function saveValueLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const text = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    if ("text" in node && typeof node.text === "string") return node.text;
    if ("type" in node && node.type === "image") return "Image";
    if ("content" in node && Array.isArray(node.content)) return node.content.map(text).join("type" in node && node.type === "paragraph" ? "" : "\n");
    return "";
  };
  if (typeof value === "object" && "type" in value && value.type === "doc") return text(value) || "Empty document";
  if (Array.isArray(value) && value.every(node => node && typeof node === "object" && "type" in node)) return value.map(text).join("\n") || "Empty document";
  return JSON.stringify(value, (key, entry) => /^(id|userId|accountId)$/.test(key) ? undefined : entry, 2);
}
