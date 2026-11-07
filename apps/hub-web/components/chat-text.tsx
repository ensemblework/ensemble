"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { PageMention } from "@ensemble/shared-types";
import { Fragment, type ReactNode } from "react";
import { LinkifiedText } from "./linkified-text";

const ITEM = /^( *)(?:([-*+\u2022\u25E6\u25AA])|(\d{1,9})([.)]))( {1,4})(\[([ xX])\] )?(.*)$/;
const GLYPHS = ["\u2022", "\u25E6", "\u25AA"];
// No lookbehind: Safari before 16.4 cannot parse one, and the whole file would fail to load.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*)/g;

type Row = { kind: "text"; text: string } | { kind: "item"; depth: number; marker: string; task: boolean | null; text: string };

/** Lines into text and list items; an indented line under an item continues it; nothing in a ``` fence is a list. */
export function chatRows(source: string): Row[] {
  const rows: Row[] = [];
  const open: Array<{ indent: number; content: number }> = [];
  let fence = false;
  for (const line of source.split("\n")) {
    if (/^ *(```|~~~)/.test(line)) fence = !fence;
    const match = fence || /^ *(```|~~~)/.test(line) ? null : ITEM.exec(line);
    const last = rows[rows.length - 1];
    if (match) {
      const indent = match[1]!.length;
      while (open.length && open[open.length - 1]!.indent >= indent) open.pop();
      const depth = open.length;
      const content = indent + (match[2] ?? `${match[3]}${match[4]}`).length + match[5]!.length;
      open.push({ indent, content });
      rows.push({ kind: "item", depth, marker: match[2] ? GLYPHS[depth % GLYPHS.length]! : `${match[3]}${match[4]}`, task: match[6] ? match[7]!.toLowerCase() === "x" : null, text: match[8]! });
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (last?.kind === "item" && line.trim() && open.length && indent >= open[open.length - 1]!.content) {
      last.text += `\n${line.trim()}`;
      continue;
    }
    if (line.trim() || !open.length) open.length = 0;
    if (last?.kind === "text") last.text += `\n${line}`;
    else rows.push({ kind: "text", text: line });
  }
  return rows;
}

/** **Bold**, *italic*, `code` and ~~struck~~ text; the rest keeps its links and mention chips. */
function Inline({ text, mentions }: { text: string; mentions?: PageMention[] | null }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(<LinkifiedText key={`t${at}`} text={text.slice(last, at)} mentions={mentions} />);
    const token = match[0];
    if (match[1]) parts.push(<code key={at} className="chat-code">{token.slice(1, -1)}</code>);
    else if (match[2]) parts.push(<strong key={at}><LinkifiedText text={token.slice(2, -2)} mentions={mentions} /></strong>);
    else if (match[3]) parts.push(<s key={at}><LinkifiedText text={token.slice(2, -2)} mentions={mentions} /></s>);
    else parts.push(<em key={at}><LinkifiedText text={token.slice(1, -1)} mentions={mentions} /></em>);
    last = at + token.length;
  }
  if (last < text.length) parts.push(<LinkifiedText key={`t${last}`} text={text.slice(last)} mentions={mentions} />);
  return <>{parts}</>;
}

/**
 * What a person wrote in a chat, as they wrote it, with lists shown as lists (nested by indentation,
 * numbered as typed) and light inline formatting. White space comes from the parent (pre-wrap).
 */
export function ChatText({ text, mentions }: { text: string; mentions?: PageMention[] | null }) {
  const rows = chatRows(text);
  if (rows.length === 1 && rows[0]!.kind === "text") return <Inline text={text} mentions={mentions} />;
  return (
    <>
      {rows.map((row, index) =>
        row.kind === "text" ? (
          <Fragment key={index}>
            {index > 0 && rows[index - 1]!.kind === "text" ? "\n" : null}
            <span className="chat-text-block"><Inline text={row.text} mentions={mentions} /></span>
          </Fragment>
        ) : (
          <span key={index} className="chat-li" style={{ paddingLeft: `${row.depth * 1.25}em` }}>
            <span className="chat-li-marker" aria-hidden data-ordered={/\d/.test(row.marker) || undefined}>
              {row.task === null ? row.marker : row.task ? "☑" : "☐"}
            </span>
            <span className="chat-li-text"><Inline text={row.text} mentions={mentions} /></span>
          </span>
        ),
      )}
    </>
  );
}
