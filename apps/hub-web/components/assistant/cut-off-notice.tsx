"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { MarkdownText } from "../markdown-text";

const CUT_OFF_LINE = /^\[Cut off:\s*(.+)\s+Reason: .+\]$/;

/**
 * Separate the saved cut-off marker from the partial answer.
 * Only the first line is the notice. A later "[Cut off:" line is part of the answer.
 */
export function splitCutOffReply(content: string): { body: string; notice: string | null } {
  const lines = content.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!first.startsWith("[Cut off:")) return { body: content.trim(), notice: null };
  const matched = CUT_OFF_LINE.exec(first);
  const notice = matched?.[1]?.trim() || first.replace(/^\[Cut off:\s*/, "").replace(/\]$/, "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { body, notice };
}

/** Partial text stays visible. The notice says the reply stopped early. */
export function AssistantAnswer({ content }: { content: string }) {
  const { body, notice } = splitCutOffReply(content);
  return (
    <>
      {body ? <MarkdownText text={body} /> : null}
      {notice ? (
        <p className="text-[12px] leading-5 text-faint" data-cutoff-notice>
          {notice}
        </p>
      ) : null}
    </>
  );
}
