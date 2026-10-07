"use client";

import { Check, Undo2 } from "lucide-react";
import { forwardRef } from "react";
import type { FileDiff } from "@/lib/api";
import { cx } from "../ui";

export const DiffView = forwardRef<
  HTMLDivElement,
  {
    diff: FileDiff;
    decisions: Map<string, string>;
    current: number;
    kind: "review" | "repo";
    busy: boolean;
    onDecide: (key: string, decision: "accepted" | "rejected") => void;
    onFocusHunk: (index: number) => void;
  }
>(function DiffView({ diff, decisions, current, kind, busy, onDecide, onFocusHunk }, ref) {
  if (diff.binary) return <div className="p-8 text-[13px] text-muted">Binary file, open it in your editor.</div>;
  if (!diff.hunks.length) {
    return <div className="p-8 text-[13px] text-muted">No remaining changes in this file. Every hunk was accepted or put back.</div>;
  }
  return (
    <div ref={ref} className="font-mono text-[12.5px] leading-[20px]">
      {diff.hunks.map((hunk, index) => {
        const decided = decisions.get(hunk.key);
        const active = index === current;
        return (
          <div
            key={hunk.key}
            data-hunk={index}
            onMouseDown={() => onFocusHunk(index)}
            className={cx("relative border-y border-transparent", active && "border-y-accent/40")}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between bg-raised/95 px-3 py-1 text-[11.5px] text-muted backdrop-blur">
              <span className="truncate">{hunk.header}</span>
              <span className="flex shrink-0 items-center gap-1.5 font-sans">
                {decided ? (
                  <span className={cx("tag", decided === "accepted" ? "text-ok" : "text-danger")} style={{ background: "var(--tag-gray-bg)" }}>
                    {decided === "accepted" ? "Accepted" : "Rejected"}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDecide(hunk.key, "rejected")}
                  className="btn px-2 py-0 text-[11.5px]"
                  title={kind === "review" ? "Put the old lines back on disk (N)" : "Discard this hunk (N)"}
                >
                  <Undo2 size={11} /> Reject
                </button>
                <button
                  type="button"
                  disabled={busy || decided === "accepted"}
                  onClick={() => onDecide(hunk.key, "accepted")}
                  className="btn-primary px-2 py-0 text-[11.5px]"
                  title={kind === "review" ? "Keep this change (Y)" : "Stage this hunk (Y)"}
                >
                  <Check size={11} /> {kind === "review" ? "Accept" : "Stage"}
                </button>
              </span>
            </div>
            <div className="overflow-x-auto">
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={cx(
                  "flex w-max min-w-full",
                  line.type === "add" && "ide-diff-add",
                  line.type === "del" && "ide-diff-del",
                  decided === "accepted" && "opacity-60",
                )}
              >
                <span className="w-10 shrink-0 select-none pr-2 text-right text-faint sm:w-12">{line.oldNo ?? ""}</span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-faint sm:w-12">{line.newNo ?? ""}</span>
                <span
                  className={cx(
                    "w-5 shrink-0 select-none text-center",
                    line.type === "add" ? "text-ok" : line.type === "del" ? "text-danger" : "text-faint",
                  )}
                >
                  {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre pr-4">{line.text || " "}</span>
              </div>
            ))}
            </div>
          </div>
        );
      })}
    </div>
  );
});
