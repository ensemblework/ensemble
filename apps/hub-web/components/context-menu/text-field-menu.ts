/**
 * Ensemble's right-click menu in a title (a page's, a task's, a project's, a meeting's, a deliverable's):
 * spelling suggestions for the word under the pointer, Search for picked text, Cut · Copy · Paste and
 * Select all, then whatever the place adds ("Page ▸", "Task ▸"). Other text boxes keep the browser's
 * menu. On touch the phone's own text menu stays.
 */
import { Clipboard, Copy, Scissors, Search, TextSelect } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { copyText, openPalette } from "./builders";
import { lastPointer, openContextMenu, type MenuSection, type MenuSpec } from "./menu-store";
import { spellingSection, warmSpelling, wordAt } from "./spelling";

type Field = HTMLInputElement | HTMLTextAreaElement;

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Written as Ctrl+X: the menu shows it as ⌘X on a Mac. */
const key = (letter: string) => `Ctrl+${letter}`;

/** `document.execCommand`, where the browser still has it. */
const command = (name: string, value?: string) => typeof document.execCommand === "function" && document.execCommand(name, false, value);

/** Puts `text` in place of start…end the way typing would (the field's own undo keeps it). */
function insert(field: Field, start: number, end: number, text: string): void {
  field.focus({ preventScroll: true });
  field.setSelectionRange(start, end);
  if (command("insertText", text)) return;
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The word under the pointer (or at the caret, opened from the keyboard). */
function wordUnder(field: Field, event: MouseEvent): ReturnType<typeof wordAt> {
  const keyboard = event.clientX === 0 && event.clientY === 0;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  if (!keyboard) {
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    const at = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (at && at.offsetNode === field) return wordAt(field.value, at.offset);
  }
  // macOS picks the word under the pointer on a right-click; elsewhere the caret moved to it.
  const hit = wordAt(field.value, start);
  return hit && (start === end || (hit.start === start && hit.end === end)) ? hit : null;
}

export function textFieldMenu(field: Field, event: MouseEvent, extra: MenuSection[] = []): MenuSpec {
  const editable = !field.readOnly && !field.disabled;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  const picked = field.value.slice(start, end);
  const sections: MenuSection[] = [];
  const spot = editable && field.spellcheck !== false ? wordUnder(field, event) : null;
  const spelling = spot
    ? spellingSection(spot.word, (next) => {
        if (field.isConnected && field.value.slice(spot.start, spot.end) === spot.word) insert(field, spot.start, spot.end, next);
      })
    : null;
  if (spelling) sections.push(spelling);
  const firstLine = picked.trim().split("\n")[0]!.slice(0, 200);
  if (firstLine) sections.push({ items: [{ id: "search", label: `Search for “${firstLine.length > 22 ? `${firstLine.slice(0, 21)}…` : firstLine}”`, icon: Search, run: () => openPalette(firstLine) }] });
  const clip = (kind: "copy" | "cut") => () => {
    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
    if (command(kind)) return;
    void copyText(picked);
    if (kind === "cut") insert(field, start, end, "");
  };
  const paste = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      throw new Error(`The browser kept the clipboard closed. Press ${MAC ? "⌘V" : "Ctrl+V"} to paste.`);
    }
    insert(field, start, end, text);
  };
  sections.push({
    items: [
      {
        id: "clipboard",
        row: [
          ...(editable ? [{ id: "cut", label: "Cut", icon: Scissors, hint: key("X"), run: clip("cut"), disabled: !picked }] : []),
          { id: "copy", label: "Copy", icon: Copy, hint: key("C"), run: clip("copy"), disabled: !picked },
          ...(editable ? [{ id: "paste", label: "Paste", icon: Clipboard, hint: key("V"), run: paste, disabled: typeof navigator === "undefined" || !navigator.clipboard?.readText }] : []),
        ],
      },
      {
        id: "select-all",
        label: "Select all",
        icon: TextSelect,
        hint: key("A"),
        disabled: !field.value,
        run: () => {
          field.focus({ preventScroll: true });
          field.select();
        },
      },
    ],
  });
  sections.push(...extra);
  return { title: field.getAttribute("aria-label") ?? undefined, sections };
}

/** For a title's `onContextMenu`. `extra` adds the place's own items below. */
export function openTextFieldMenu(event: ReactMouseEvent<Field>, extra?: () => MenuSection[]): void {
  if (lastPointer() === "touch") return;
  const field = event.currentTarget;
  warmSpelling();
  openContextMenu(event, () => textFieldMenu(field, event.nativeEvent, extra?.() ?? []), { inFields: true });
}

/** Props that give a title this menu, and load the dictionary when it is focused. */
export function titleMenuProps(extra?: () => MenuSection[]) {
  return {
    "data-cm-text": "",
    onFocus: () => warmSpelling(),
    onContextMenu: (event: ReactMouseEvent<Field>) => openTextFieldMenu(event, extra),
  };
}
