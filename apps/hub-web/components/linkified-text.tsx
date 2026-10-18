"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { PageMention } from "@ensemble/shared-types";
import { Fragment, type MouseEvent, type ReactNode } from "react";
import { linkPieces } from "@/lib/linkify";
import { mentionRanges, splitAtRanges } from "@/lib/mentions/text";
import { MentionChip } from "./mentions/mention-chip";

/** Links in text: accent, underlined, and a long address wraps instead of widening its box. */
export const LINK_CLASS = "text-accent underline underline-offset-2 [overflow-wrap:anywhere]";

// A link inside something clickable (a click-to-edit field, a row that expands) opens only the link.
const stop = (event: MouseEvent) => event.stopPropagation();

/** One address. Web addresses open in a new tab; `mailto:` hands off to the mail app. */
export function TextLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const web = /^https?:/i.test(href);
  return (
    <a href={href} {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})} className={className ?? LINK_CLASS} onClick={stop}>
      {children}
    </a>
  );
}

/** The addresses in `text` as links; the rest stays text. */
export function linkify(text: string): ReactNode[] {
  return linkPieces(text).map((piece, index) =>
    piece.kind === "link" ? (
      <TextLink key={index} href={piece.href}>
        {piece.text}
      </TextLink>
    ) : (
      piece.text
    ),
  );
}

/**
 * Plain text with clickable addresses and, when the exact `mentions` are known,
 * `@kind:Label` written as mention chips. White space and fonts come from the
 * parent, so it works inside `<pre>` and `whitespace-pre-wrap` boxes.
 */
export function LinkifiedText({ text, mentions }: { text: string; mentions?: PageMention[] | null }) {
  const ranges = mentions?.length ? mentionRanges(text, mentions) : [];
  return (
    <>
      {splitAtRanges(text, ranges).map((piece, index) =>
        piece.range?.mention ? <MentionChip key={index} mention={piece.range.mention} /> : <Fragment key={index}>{linkify(piece.text)}</Fragment>,
      )}
    </>
  );
}
