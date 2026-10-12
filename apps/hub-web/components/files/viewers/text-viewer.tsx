"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMemo, useState } from "react";
import { MarkdownText } from "../../markdown-text";
import { Segmented } from "../../ui";
import { Toolbar, type ViewerProps } from "./shared";

const FULL_LINES = 20_000;
const COMPACT_LINES = 20;

export function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Text and code: code with line numbers and its language, prose wrapped, Markdown formatted. */
export default function TextViewer({ file, format, bytes, compact }: ViewerProps) {
  const text = useMemo(() => decodeText(bytes), [bytes]);
  const markdown = format.ext === "md" || format.ext === "markdown";
  const [mode, setMode] = useState<"formatted" | "plain">(markdown ? "formatted" : "plain");
  const allLines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  const limit = compact ? COMPACT_LINES : FULL_LINES;
  const lines = allLines.slice(0, limit);
  const cut = allLines.length - lines.length;
  const code = format.kind === "code";
  const shown = lines.join("\n");

  const body =
    markdown && mode === "formatted" ? (
      <div className="mx-auto max-w-[760px] px-5 py-4">
        <MarkdownText text={shown} />
      </div>
    ) : code ? (
      <div className="flex min-w-max font-mono text-[12.5px] leading-[1.6]">
        <pre aria-hidden className="select-none border-r border-line px-3 py-3 text-right text-faint">
          {lines.map((_, index) => index + 1).join("\n")}
        </pre>
        <pre className="px-3 py-3 text-ink" data-language={format.language}>
          {shown}
        </pre>
      </div>
    ) : (
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-ink">{shown}</pre>
    );

  return (
    <div className="flex h-full min-h-0 flex-col" data-file-text={file.id}>
      {compact ? null : (
        <Toolbar>
          <span className="px-1">
            {format.label}
            {format.language && format.kind === "code" ? ` · ${format.language}` : ""} · {allLines.length.toLocaleString()} {allLines.length === 1 ? "line" : "lines"}
          </span>
          {markdown ? (
            <span className="ml-auto">
              <Segmented
                label="Show Markdown as"
                value={mode}
                onChange={setMode}
                options={[
                  { id: "formatted", label: "Formatted" },
                  { id: "plain", label: "Plain text" },
                ]}
              />
            </span>
          ) : null}
        </Toolbar>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {body}
        {cut > 0 ? (
          <p className="px-4 pb-3 text-[12px] text-faint">
            {compact ? `${cut.toLocaleString()} more ${cut === 1 ? "line" : "lines"}. Open the file to see all of it.` : `Showing the first ${limit.toLocaleString()} lines. Download the file to see the other ${cut.toLocaleString()}.`}
          </p>
        ) : null}
      </div>
    </div>
  );
}
