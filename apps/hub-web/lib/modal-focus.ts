import { useEffect, useRef, type RefObject } from "react";

const stack: HTMLElement[] = [];
const hidden = new Map<HTMLElement, boolean>();
const focusable = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function surfaces(root: HTMLElement): HTMLElement[] {
  const id = root.dataset.modalLayer;
  return [root, ...Array.from(document.querySelectorAll<HTMLElement>("[data-modal-owner]")).filter((node) => node.dataset.modalOwner === id)];
}

function updateBackground() {
  for (const [node, inert] of hidden) node.inert = inert;
  hidden.clear();
  const top = stack.at(-1);
  if (!top) return;
  const allowed = surfaces(top);
  const hideSiblings = (parent: HTMLElement) => {
    for (const node of Array.from(parent.children)) {
      if (!(node instanceof HTMLElement) || allowed.includes(node)) continue;
      if (allowed.some((surface) => node.contains(surface))) { hideSiblings(node); continue; }
      hidden.set(node, node.inert === true);
      node.inert = true;
    }
  };
  hideSiblings(document.body);
}

/** Only the top modal owns focus. Its portalled popovers belong to the same focus scope. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const opener = useRef<HTMLElement | null>(null);
  const previous = useRef(false);
  if (open && !previous.current && typeof document !== "undefined") opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previous.current = open;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    stack.push(root);
    updateBackground();
    const observer = new MutationObserver(updateBackground);
    observer.observe(document.body, { childList: true, subtree: true });
    const items = () => surfaces(root).flatMap((surface) => Array.from(surface.querySelectorAll<HTMLElement>(focusable)))
      .filter((node) => {
        if (node.tabIndex < 0 || node.matches(":disabled") || node.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
        for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      });
    if (!root.contains(document.activeElement)) {
      const fields = items();
      (fields.find((node) => node.matches("input, textarea, select")) ?? fields[0] ?? root).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (stack.at(-1) !== root || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === "Tab") {
        const fields = items();
        const index = fields.indexOf(document.activeElement as HTMLElement);
        if (!fields.length || index < 0 || (event.shiftKey ? index === 0 : index === fields.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? fields.at(-1) : fields[0] ?? root)?.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (stack.at(-1) !== root || surfaces(root).some((surface) => surface.contains(event.target as Node))) return;
      (items()[0] ?? root).focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      stack.splice(stack.indexOf(root), 1);
      updateBackground();
      // Strict Mode immediately re-enters the scope. Actual removal restores its opener.
      queueMicrotask(() => {
        if (!stack.includes(root) && opener.current?.isConnected && !opener.current.closest("[inert]")) opener.current.focus();
      });
    };
  }, [open, ref]);
}
