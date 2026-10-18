"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useLayoutEffect, useRef, type SyntheticEvent, type TextareaHTMLAttributes, type UIEvent } from "react";
import { composerRanges, splitAtRanges } from "@/lib/mentions/text";
import { cx } from "../ui";
import type { MentionMenu } from "./mention-menu";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "children"> & {
  menu: MentionMenu<HTMLTextAreaElement>;
  value: string;
  /** Classes for the wrapper, which takes the box's place in the layout. `className` styles the box. */
  fieldClassName?: string;
};

/**
 * A textarea with the @ menu whose mentions are tinted as they are typed: the
 * ones picked from the menu, a bare `@people:`, and the token being picked for.
 * The tint is a copy of the text behind the transparent box, with the box's own
 * classes, padding and wrapping, so the caret, selection, undo, paste and IME
 * stay the browser's. Render `<MentionPopover menu={menu} />` next to it as usual.
 */
export function MentionTextarea({ menu, value, className, fieldClassName, onChange, onSelect, onBlur, onScroll, ...rest }: Props) {
  const mirror = useRef<HTMLDivElement>(null);
  const field = menu.ref;
  const ranges = composerRanges(value, menu.takeMentions(value), menu.typing);

  const sync = () => {
    const box = field.current;
    const copy = mirror.current;
    if (!box || !copy) return;
    // A scrollbar narrows the box's text; the copy has none, so it gets the same room as padding.
    const style = getComputedStyle(box);
    const bar = box.offsetWidth - box.clientWidth - (Number.parseFloat(style.borderLeftWidth) || 0) - (Number.parseFloat(style.borderRightWidth) || 0);
    copy.style.paddingRight = bar > 0 ? `${(Number.parseFloat(style.paddingRight) || 0) + bar}px` : "";
    copy.scrollTop = box.scrollTop;
    copy.scrollLeft = box.scrollLeft;
  };

  useLayoutEffect(() => {
    sync();
    // An auto-growing parent sets the height after this runs.
    const frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  });

  useEffect(() => {
    const box = field.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => sync());
    observer.observe(box);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  const both =
    <E extends SyntheticEvent<HTMLTextAreaElement>>(first: ((event: E) => void) | undefined, second: ((event: E) => void) | undefined) =>
    (event: E) => {
      first?.(event);
      second?.(event);
    };

  return (
    <div className={cx("mention-field", fieldClassName)}>
      <div ref={mirror} className={cx(className, "mention-field-mirror")} aria-hidden="true" data-mention-mirror="">
        {splitAtRanges(value, ranges).map((piece, index) =>
          piece.range ? (
            <span key={index} className="mention-mark" data-kind={piece.range.kind ?? undefined}>
              {piece.text}
            </span>
          ) : (
            piece.text
          ),
        )}
        {"\u200b"}
      </div>
      <textarea
        ref={field}
        value={value}
        {...menu.inputProps}
        {...rest}
        onChange={both(menu.inputProps.onChange, onChange)}
        onSelect={both(menu.inputProps.onSelect, onSelect)}
        onBlur={both(menu.inputProps.onBlur, onBlur)}
        onScroll={(event: UIEvent<HTMLTextAreaElement>) => {
          sync();
          onScroll?.(event);
        }}
        className={cx(className, "mention-field-input")}
      />
    </div>
  );
}
