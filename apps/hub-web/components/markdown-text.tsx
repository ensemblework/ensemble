"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { ReactNode } from "react";

/** Small safe markdown: bold, italics, code, links, lists. No raw HTML. */
export function MarkdownText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2 text-[13.5px] leading-[1.6]">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Heading({ level, text }: { level: number; text: string }) {
  const className = level <= 2 ? "text-[16px] font-semibold" : "text-[14.5px] font-semibold";
  if (level <= 1) return <h2 className={className}>{inline(text)}</h2>;
  if (level === 2) return <h3 className={className}>{inline(text)}</h3>;
  return <h4 className={className}>{inline(text)}</h4>;
}

function Block({ block }: { block: string }) {
  const lines = block.split("\n");
  const nodes: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    nodes.push(
      <ul key={`list-${nodes.length}`} className="list-disc space-y-1 pl-5">
        {items.map((line, index) => (
          <li key={index}>{inline(line)}</li>
        ))}
      </ul>,
    );
  };
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      nodes.push(<Heading key={`h-${index}`} level={heading[1].length} text={heading[2]} />);
      return;
    }
    if (/^[-*] /.test(line.trim())) {
      list.push(line.trim().replace(/^[-*] /, ""));
      return;
    }
    flush();
    nodes.push(
      <p key={`p-${index}`}>
        {inline(line)}
      </p>,
    );
  });
  flush();
  return <div className="space-y-2">{nodes}</div>;
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Code and bold win over italics. Italics do not match snake_case or spaced multiplication.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))|(?<![A-Za-z0-9])\*(?!\*|\s)([^*\n]*?[^\s*])\*(?!\*)(?![A-Za-z0-9])|(?<![A-Za-z0-9])_(?!_|\s)([^_\n]*?[^\s_])_(?!_)(?![A-Za-z0-9])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) nodes.push(<code key={key++} className="rounded bg-panel px-1 font-mono text-[12px]">{token.slice(1, -1)}</code>);
    else if (match[2]) nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (match[4] || match[5]) nodes.push(<em key={key++}>{match[4] ?? match[5]}</em>);
    else {
      const link = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(token);
      if (link) {
        nodes.push(
          <a key={key++} href={link[2]} target="_blank" rel="noreferrer noopener" className="text-accent underline">
            {link[1]}
          </a>,
        );
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
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
