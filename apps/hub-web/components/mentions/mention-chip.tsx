"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { mentionHref, type PageMention } from "@ensemble/shared-types";
import Link from "next/link";
import type { MouseEvent } from "react";
import { inItemView } from "@/lib/api";
import { KIND_LABEL } from "@/lib/mentions/menu";

const stop = (event: MouseEvent) => event.stopPropagation();

/**
 * A mention outside the page editor: the same chip as on a page, tinted by its kind.
 * It opens the record in the app. A shared item or public link cannot reach the
 * owner's records, so there it is not a link.
 */
export function MentionChip({ mention }: { mention: PageMention }) {
  const href = inItemView() ? undefined : mentionHref(mention);
  const name = `${KIND_LABEL[mention.kind] ?? mention.kind}: ${mention.label}`;
  const body = (
    <>
      <span className="mention-at" aria-hidden="true">@</span>
      {mention.label}
    </>
  );
  if (!href) {
    return <span className="mention" data-kind={mention.kind} data-id={mention.id} title={name}>{body}</span>;
  }
  return (
    <Link href={href} className="mention" data-kind={mention.kind} data-id={mention.id} title={name} aria-label={name} onClick={stop}>
      {body}
    </Link>
  );
}
