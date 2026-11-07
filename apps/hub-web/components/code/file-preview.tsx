"use client";

import { useEffect, useMemo, useState } from "react";
import { MarkdownText } from "@/components/markdown-text";
import { Spinner } from "@/components/ui";
import type { CodeApi, Source } from "@/lib/code-target";
import { previewOf } from "@/lib/file-kinds";
import { codeImageUrl } from "./code-menus";

const MAX_ROWS = 500;

/** A CSV or TSV line split into cells; quoted cells keep their commas and doubled quotes. */
function splitRow(line: string, separator: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === separator) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function Table({ text, path }: { text: string; path: string }) {
  const rows = useMemo(() => {
    const separator = path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    return text.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1).slice(0, MAX_ROWS + 1).map((line) => splitRow(line, separator));
  }, [text, path]);
  const [head, ...body] = rows;
  const total = text.split(/\r?\n/).filter(Boolean).length - 1;
  return (
    <div className="code-preview-table">
      <table>
        <thead><tr>{head?.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, index) => <tr key={index}>{row.map((cell, at) => <td key={at}>{cell}</td>)}</tr>)}</tbody>
      </table>
      {total > MAX_ROWS ? <p className="px-3 py-2 text-[11.5px] text-faint">The first {MAX_ROWS.toLocaleString()} of {total.toLocaleString()} rows.</p> : null}
    </div>
  );
}

function Picture({ code, source, path }: { code: CodeApi; source: Source; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    setError(null);
    codeImageUrl(code, source, path).then(
      (next) => {
        made = next;
        if (live) setUrl(next);
        else URL.revokeObjectURL(next);
      },
      (failure: Error) => live && setError(failure.message),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [code, source, path]);
  if (error) return <div className="p-6 text-[13px] text-danger">{error}</div>;
  if (!url) return <div className="p-6"><Spinner /></div>;
  return (
    <div className="code-preview-canvas">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={path.split("/").pop()} onLoad={(event) => setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} />
      {size ? <span className="code-preview-size">{size}</span> : null}
    </div>
  );
}

/** What the file looks like rendered: Markdown, a web page (no scripts), an SVG, an image or a table. */
export function FilePreview({ path, text, code, source }: { path: string; text: string; code: CodeApi; source: Source }) {
  const kind = previewOf(path);
  if (kind === "markdown") {
    return (
      <div className="code-preview-scroll">
        <article className="code-preview-markdown">
          <MarkdownText text={text} className="space-y-3 text-[14px] leading-[1.7]" />
        </article>
      </div>
    );
  }
  if (kind === "html") return <iframe title={`Preview of ${path}`} className="h-full w-full border-0 bg-white" sandbox="" srcDoc={text} />;
  if (kind === "svg") {
    return (
      <div className="code-preview-canvas">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={path.split("/").pop()} />
      </div>
    );
  }
  if (kind === "csv") return <div className="code-preview-scroll"><Table text={text} path={path} /></div>;
  if (kind === "image") return <Picture code={code} source={source} path={path} />;
  return null;
}
