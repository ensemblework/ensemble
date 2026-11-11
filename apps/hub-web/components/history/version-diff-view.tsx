"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useMemo, useState, type ReactNode } from "react";
import { ChevronsUpDown, File, Image as ImageIcon, Square, SquareCheck } from "lucide-react";
import type { PageDocument } from "@ensemble/shared-types";
import { MarkdownText } from "../markdown-text";
import { InfoTip, Toggle } from "../ui";
import { plural } from "@/lib/format";
import { usePersistentState } from "@/lib/prefs";
import { changeCount, diffPage, pageBlocks, wordDiff, type DiffBlock, type Segment } from "./version-diff";

/** Unchanged blocks kept around a change; longer unchanged runs fold. */
const CONTEXT = 2;

function Words({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.change === "added" ? <ins key={index}>{segment.text}</ins> : segment.change === "removed" ? <del key={index}>{segment.text}</del> : <span key={index}>{segment.text}</span>,
      )}
    </>
  );
}

function Block({ row }: { row: DiffBlock }) {
  const { block } = row;
  const text: ReactNode =
    row.change === "edited" ? <Words segments={row.segments} /> : row.change === "added" ? <ins>{block.text}</ins> : row.change === "removed" ? <del>{block.text}</del> : block.text;
  const marker =
    block.kind === "bullet" ? <span className="vh-marker" aria-hidden>•</span>
    : block.kind === "ordered" ? <span className="vh-marker" aria-hidden>{block.number}.</span>
    : block.kind === "task" ? <span className="vh-marker" aria-label={block.checked ? "Done" : "Not done"}>{block.checked ? <SquareCheck size={14} /> : <Square size={14} />}</span>
    : block.kind === "toggle" ? <span className="vh-marker" aria-hidden>▸</span>
    : block.kind === "image" ? <span className="vh-marker" aria-hidden><ImageIcon size={14} /></span>
    : block.kind === "embed" ? <span className="vh-marker" aria-hidden><File size={14} /></span>
    : null;
  if (block.kind === "rule") return <hr className="vh-block vh-rule" data-change={row.change} />;
  return (
    <div className={`vh-block vh-${block.kind}`} data-change={row.change} data-checked={block.checked ? "" : undefined} style={block.depth ? { paddingLeft: `${block.depth * 22}px` } : undefined} role={/^h\d$/.test(block.kind) ? "heading" : undefined} aria-level={/^h\d$/.test(block.kind) ? 3 + Number(block.kind[1]) : undefined}>
      {marker}
      {block.kind === "code" ? <pre>{text}</pre> : <span className="vh-text">{text}</span>}
    </div>
  );
}

type Shown = { kind: "row"; row: DiffBlock; at: number } | { kind: "fold"; from: number; to: number };

/** Every row near a change, with longer unchanged runs folded into one line. */
function folded(diff: readonly DiffBlock[], opened: ReadonlySet<number>): Shown[] {
  if (!diff.some((row) => row.change !== "same")) return diff.map((row, at) => ({ kind: "row", row, at }));
  const near = diff.map(() => false);
  diff.forEach((row, at) => {
    if (row.change === "same") return;
    for (let k = Math.max(0, at - CONTEXT); k <= Math.min(diff.length - 1, at + CONTEXT); k += 1) near[k] = true;
  });
  const out: Shown[] = [];
  for (let at = 0; at < diff.length; ) {
    if (near[at]) {
      out.push({ kind: "row", row: diff[at]!, at });
      at += 1;
      continue;
    }
    let end = at;
    while (end < diff.length && !near[end]) end += 1;
    if (end - at < 3 || opened.has(at)) for (let k = at; k < end; k += 1) out.push({ kind: "row", row: diff[k]!, at: k });
    else out.push({ kind: "fold", from: at, to: end });
    at = end;
  }
  return out;
}

/**
 * A saved page version, with what differs from the page now marked: highlighted text is only in
 * this version (restoring brings it back), struck text is only on the page now (restoring removes
 * it). Off, the version shows as plain Markdown.
 */
export function PageVersionPreview({ version, current, unavailable = false }: {
  version: { title: string; content: PageDocument | null; markdown: string };
  /** The page now; null while it loads. */
  current: { title: string | null; content: PageDocument | null } | null;
  /** The page now could not be read: the version shows plain. */
  unavailable?: boolean;
}) {
  const [showChanges, setShowChanges] = usePersistentState("ensemble.history.changes", true);
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const diff = useMemo(() => (current ? diffPage(pageBlocks(version.content), pageBlocks(current.content)) : null), [version.content, current]);
  const count = diff ? changeCount(diff) : 0;
  const titleChanged = Boolean(current?.title && current.title !== version.title);
  const changes = count + (titleChanged ? 1 : 0);
  const marking = showChanges && diff !== null;
  return (
    <div className="vh-doc">
      <div className="vh-doc-bar">
        <span className="vh-doc-count">
          {unavailable ? "Could not read the page now to compare" : !current ? "Comparing with the page now…" : changes ? `${plural(changes, "change")} from the page now` : "Same as the page now"}
        </span>
        {marking && changes ? (
          <span className="vh-legend">
            <ins>In this version</ins>
            <del>On the page now</del>
            <InfoTip label="About the highlights" text="Highlighted text is only in this version, so restoring brings it back. Struck text is only on the page now, so restoring removes it." />
          </span>
        ) : null}
        <label className="vh-doc-toggle">
          <span>Show changes</span>
          <Toggle checked={showChanges} onChange={setShowChanges} label="Show changes" disabled={!current} />
        </label>
      </div>
      {marking ? (
        <div className="vh-page" data-changes="">
          <div className="vh-block vh-title" data-change={titleChanged ? "edited" : "same"} role="heading" aria-level={3}>
            {titleChanged ? <Words segments={wordDiff(current!.title!, version.title)} /> : version.title || "Untitled"}
          </div>
          {diff!.length ? (
            folded(diff!, opened).map((item) =>
              item.kind === "row" ? (
                <Block key={item.at} row={item.row} />
              ) : (
                <button key={`fold-${item.from}`} type="button" className="vh-fold" onClick={() => setOpened((set) => new Set(set).add(item.from))}>
                  <ChevronsUpDown size={13} aria-hidden />
                  {plural(item.to - item.from, "unchanged block")}
                </button>
              ),
            )
          ) : (
            <p className="vh-blank">This version is empty.</p>
          )}
        </div>
      ) : (
        <div className="prose-page vh-plain">
          <h2 className="mb-4 text-[24px] font-semibold">{version.title}</h2>
          <MarkdownText text={version.markdown} />
        </div>
      )}
    </div>
  );
}
