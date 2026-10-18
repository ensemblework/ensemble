"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { PageMention } from "@ensemble/shared-types";
import Link from "next/link";
import { Fragment, createContext, useContext, useState, type ReactNode } from "react";
import { ADDRESS_SOURCE, addressLink } from "@/lib/linkify";
import { LINK_CLASS, LinkifiedText, TextLink, linkify } from "./linkified-text";

const Mentions = createContext<PageMention[] | null>(null);

/**
 * Small safe Markdown for model output: headings, paragraphs, bold, italics, code, links, bullet,
 * numbered and task lists (nested by indent), quotes, fenced code, tables and rules. No raw HTML.
 * Bare addresses become links. With `mentions`, `@kind:Label` for those exact mentions shows as a chip.
 */
export function MarkdownText({ text, className, mentions }: { text: string; className?: string; mentions?: PageMention[] | null }) {
  return (
    <div className={className ?? "space-y-2 text-[13.5px] leading-[1.6]"}>
      <Mentions.Provider value={mentions?.length ? mentions : null}>
        <Blocks blocks={parseBlocks(text)} />
      </Mentions.Provider>
    </div>
  );
}

function Plain({ text }: { text: string }) {
  return <LinkifiedText text={text} mentions={useContext(Mentions)} />;
}

type ListItem = { text: string; checked: boolean | null; ordered: boolean; start: number; children: ListItem[] };
type Align = "left" | "center" | "right" | null;
export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "rule" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** Text → blocks. Exported for tests. */
export function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(marker)) body.push(lines[index++]!);
      index += 1;
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && lines[index + 1]!.includes("|") && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      flush();
      const header = cells(line);
      const align = cells(lines[index + 1]!).map(alignOf);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) rows.push(cells(lines[index++]!));
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (index < lines.length && lines[index]!.trim() && QUOTE.test(lines[index]!)) body.push(QUOTE.exec(lines[index++]!)![1]!);
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      const parsed = parseList(lines, index);
      blocks.push({ kind: "list", items: parsed.items });
      index = parsed.next;
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
}

/** A list and the lists nested in it, by indent. A blank line between items keeps the list going. */
function parseList(lines: string[], from: number): { items: ListItem[]; next: number } {
  const root: ListItem[] = [];
  const stack: Array<{ indent: number; items: ListItem[] }> = [{ indent: -1, items: root }];
  let last: ListItem | null = null;
  let index = from;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      const next = lines.slice(index + 1).find((row) => row.trim());
      if (next && ITEM.test(next)) {
        index += 1;
        continue;
      }
      break;
    }
    const item = ITEM.exec(line);
    if (!item) {
      // An indented line under an item continues it; anything else ends the list.
      if (last && /^\s+/.test(line) && !FENCE.test(line)) {
        last.text += `\n${line.trim()}`;
        index += 1;
        continue;
      }
      break;
    }
    const indent = item[1]!.replace(/\t/g, "  ").length;
    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
    let level = stack[stack.length - 1]!;
    const parent = level.items[level.items.length - 1];
    if (indent > level.indent + 1 && parent && stack.length < 6) {
      stack.push({ indent, items: parent.children });
      level = stack[stack.length - 1]!;
    } else if (indent > level.indent) level.indent = indent;
    const marker = item[2]!;
    const ordered = /\d/.test(marker);
    let body = item[3]!;
    let checked: boolean | null = null;
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(body);
    if (task) {
      checked = task[1]!.toLowerCase() === "x";
      body = task[2]!;
    }
    last = { text: body, checked, ordered, start: ordered ? Number.parseInt(marker, 10) : 1, children: [] };
    level.items.push(last);
    index += 1;
  }
  return { items: root, next: index };
}

function Blocks({ blocks, depth = 0 }: { blocks: MdBlock[]; depth?: number }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} depth={depth} />
      ))}
    </>
  );
}

function BlockView({ block, depth }: { block: MdBlock; depth: number }) {
  switch (block.kind) {
    case "heading": {
      const className = block.level <= 2 ? "pt-1 text-[16px] font-semibold" : "pt-0.5 text-[14.5px] font-semibold";
      if (block.level <= 1) return <h2 className={className}>{inline(block.text)}</h2>;
      if (block.level === 2) return <h3 className={className}>{inline(block.text)}</h3>;
      return <h4 className={className}>{inline(block.text)}</h4>;
    }
    case "paragraph":
      return <p>{lineBreaks(block.lines)}</p>;
    case "list":
      return <List items={block.items} />;
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "quote":
      return (
        <blockquote className="space-y-2 border-l-2 border-line pl-3 text-muted">
          {depth < 3 ? <Blocks blocks={parseBlocks(block.text)} depth={depth + 1} /> : block.text}
        </blockquote>
      );
    case "table":
      return (
        <div className="max-w-full overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-raised">
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} className="border-b border-line px-2.5 py-1.5 text-left font-semibold" style={block.align[index] ? { textAlign: block.align[index]! } : undefined}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-line last:border-b-0">
                  {block.header.map((_, index) => (
                    <td key={index} className="px-2.5 py-1.5 align-top" style={block.align[index] ? { textAlign: block.align[index]! } : undefined}>
                      {inline(row[index] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="border-line" />;
  }
}

function List({ items }: { items: ListItem[] }) {
  const ordered = items[0]?.ordered ?? false;
  const tasks = items.every((item) => item.checked !== null);
  const children = items.map((item, index) => (
    <li key={index} className={cx(tasks && "flex list-none items-start gap-2")}>
      {item.checked !== null ? <input type="checkbox" checked={item.checked} readOnly disabled className="mt-[5px] shrink-0" aria-label={item.checked ? "Done" : "Not done"} /> : null}
      <div className="min-w-0">
        <span className="whitespace-pre-line">{inline(item.text)}</span>
        {item.children.length ? <List items={item.children} /> : null}
      </div>
    </li>
  ));
  if (ordered) {
    return (
      <ol className="list-decimal space-y-1 pl-5" start={items[0]?.start && items[0].start !== 1 ? items[0].start : undefined}>
        {children}
      </ol>
    );
  }
  return <ul className={cx("space-y-1", tasks ? "pl-0.5" : "list-disc pl-5")}>{children}</ul>;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative overflow-hidden rounded-md border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1 text-[11px] text-faint">
        <span className="font-mono">{lang || "text"}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[420px] overflow-auto p-2.5 font-mono text-[12px] leading-[1.55]">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** A paragraph keeps the line breaks the model wrote. */
function lineBreaks(lines: string[]): ReactNode {
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index ? <br /> : null}
      {inline(line)}
    </Fragment>
  ));
}

// Code and bold win over italics. Italics do not match snake_case or spaced multiplication.
// A bare address is matched here too, so emphasis never cuts through one.
const INLINE = new RegExp(
  [
    "(`[^`]+`)",
    String.raw`(\*\*[^*]+\*\*)`,
    String.raw`(\[([^\]]+)\]\(((?:https?:\/\/|\/(?![\/\\]))(?:[^()\s\\]|\([^()\s\\]*\))*)\))`,
    String.raw`(?<![A-Za-z0-9])\*(?!\*|\s)([^*\n]*?[^\s*])\*(?!\*)(?![A-Za-z0-9])`,
    String.raw`(?<![A-Za-z0-9])_(?!_|\s)([^_\n]*?[^\s_])_(?!_)(?![A-Za-z0-9])`,
    "(~~[^~]+~~)",
    String.raw`<((?:https?:\/\/|mailto:)[^\s<>]+|[\w.%+-]+@[^\s<>@]+)>`,
    `(${ADDRESS_SOURCE})`,
  ].join("|"),
  "gu",
);

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE.source, INLINE.flags);
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const plain = (value: string) => nodes.push(<Plain key={key++} text={value} />);
  while ((match = pattern.exec(text))) {
    let end = match.index + match[0].length;
    if (match[10]) {
      const link = addressLink(match[10]);
      if (!link) continue;
      end = match.index + link.text.length;
      pattern.lastIndex = end;
      if (match.index > last) plain(text.slice(last, match.index));
      nodes.push(<TextLink key={key++} href={link.href}>{link.text}</TextLink>);
      last = end;
      continue;
    }
    if (match.index > last) plain(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) nodes.push(<code key={key++} className="rounded bg-panel px-1 font-mono text-[12px] [overflow-wrap:anywhere]">{token.slice(1, -1)}</code>);
    else if (match[2]) nodes.push(<strong key={key++}>{linkify(token.slice(2, -2))}</strong>);
    else if (match[6] || match[7]) nodes.push(<em key={key++}>{linkify(match[6] ?? match[7]!)}</em>);
    else if (match[8]) nodes.push(<del key={key++}>{linkify(token.slice(2, -2))}</del>);
    else if (match[9]) {
      const inner = match[9];
      const link = addressLink(inner);
      const href = /^(?:https?:\/\/[\p{L}\p{N}[]|mailto:)/iu.test(inner) ? inner : link?.text === inner ? link.href : null;
      nodes.push(href ? <TextLink key={key++} href={href}>{inner}</TextLink> : <Plain key={key++} text={token} />);
    } else if (match[3]) {
      const href = match[5]!;
      nodes.push(
        /^https?:\/\//i.test(href) ? (
          <TextLink key={key++} href={href}>{match[4]}</TextLink>
        ) : (
          <Link key={key++} href={href} className={LINK_CLASS}>
            {match[4]}
          </Link>
        ),
      );
    }
    last = end;
  }
  if (last < text.length) plain(text.slice(last));
  return nodes;
}

export function choiceLines(text: string): string[] {
  const index = text.indexOf("Choices:");
  if (index < 0) return [];
  return text
    .slice(index + "Choices:".length)
    .split("\n")
    .map((line) => line.trim().replace(/^[-*] /, ""))
    .filter((line) => line.length > 0 && !line.startsWith("Nothing has changed"));
}
