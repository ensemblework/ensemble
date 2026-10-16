/** "Undo: Deleted “Roadmap”". The API's labels name the action in the past tense. */
export function undoButtonLabel(verb: "Undo" | "Redo", label: string | null | undefined): string {
  const text = label?.trim();
  return text ? `${verb}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}` : verb;
}

/** Focus is where typing goes: there, Ctrl/Cmd+Z belongs to the field or editor, not the app's undo. */
export function editingText(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return Boolean(element?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false]), .cm-editor, .ProseMirror, [data-diagram-editor], .xterm"));
}
