"use client";

import { useRef, useState, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import { afterInput, backspaceInList, breakInItem, enterInList, indentList, inlineMark, inList, wrapInline, type Edit } from "./chat-format";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Puts `edit` into the box as one typed change: only the part that differs is replaced, through the
 * browser's own editing (so Ctrl+Z undoes it in one step and React hears an input event). Where that is
 * not available it writes the text directly and sends the input event itself.
 */
export function applyEdit(field: HTMLTextAreaElement, edit: Edit): void {
  const before = field.value;
  if (before !== edit.value) {
    let from = 0;
    while (from < before.length && from < edit.value.length && before[from] === edit.value[from]) from += 1;
    let to = before.length;
    let end = edit.value.length;
    while (to > from && end > from && before[to - 1] === edit.value[end - 1]) {
      to -= 1;
      end -= 1;
    }
    const text = edit.value.slice(from, end);
    field.focus();
    field.setSelectionRange(from, to);
    let done = false;
    try {
      done = document.execCommand(text ? "insertText" : "delete", false, text);
    } catch {
      done = false;
    }
    if (!done || field.value !== edit.value) {
      field.value = before;
      field.setRangeText(text, from, to, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  field.setSelectionRange(edit.start, edit.end);
}

/**
 * Lists and inline formatting for a chat textarea (lib/chat-format.ts). Spread `onChange` and `onSelect`
 * onto the box and call `onKeyDown` first in its key handler: true means the key was used.
 */
export function useChatFormat(value: string, onValue: (value: string) => void) {
  const applying = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  const [listed, setListed] = useState(false);

  const put = (field: HTMLTextAreaElement, edit: Edit) => {
    applying.current = true;
    try {
      applyEdit(field, edit);
    } finally {
      applying.current = false;
    }
    onValue(edit.value);
    setListed(inList(edit.value, edit.start));
  };

  return {
    /** The caret is in a list, so Enter adds an item instead of sending. */
    inList: listed,
    onChange(event: ChangeEvent<HTMLTextAreaElement>) {
      if (applying.current || (event.nativeEvent as InputEvent).isComposing) return;
      const field = event.currentTarget;
      const edit = { value: field.value, start: field.selectionStart, end: field.selectionEnd };
      const next = afterInput(latest.current, edit);
      // After the typed text is in (React has rendered it), so the change is its own undo step.
      if (next) queueMicrotask(() => field.value === edit.value && put(field, next));
    },
    onSelect(event: SyntheticEvent<HTMLTextAreaElement>) {
      const field = event.currentTarget;
      const now = inList(field.value, field.selectionStart);
      if (now !== listed) setListed(now);
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      const native = event.nativeEvent;
      if (event.defaultPrevented || native.isComposing || native.keyCode === 229) return false;
      const field = event.currentTarget;
      const edit = { value: field.value, start: field.selectionStart, end: field.selectionEnd };
      // On a Mac, Ctrl+B and Ctrl+E move the caret (as in every text box there); the shortcuts are Cmd's.
      const mod = MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      let next: Edit | null = null;
      if (event.key === "Enter" && plain) next = event.shiftKey ? breakInItem(edit) : enterInList(edit);
      else if (event.key === "Tab" && plain) next = indentList(edit, event.shiftKey);
      else if (event.key === "Backspace" && plain && !event.shiftKey) next = backspaceInList(edit);
      else if (mod && !event.altKey) {
        const mark = inlineMark(event.key, event.shiftKey);
        if (mark) next = wrapInline(edit, mark);
      }
      if (!next) return false;
      event.preventDefault();
      put(field, next);
      return true;
    },
  };
}
