"use client";

import { useState } from "react";
import { claimEnsemble } from "./claim";
import type { AskShell } from "./ask-shell";

type Shell = typeof AskShell;

export function AskEnsemble({
  surface,
  anchorKey,
  label,
  entityIds,
  selection,
  codeText,
  path,
  line,
  projectId,
  contextLabel,
  onCitations,
  prominent,
}: {
  surface: string;
  anchorKey: string;
  label: string;
  entityIds?: string[];
  selection?: string;
  codeText?: string;
  path?: string;
  line?: number;
  projectId?: string;
  contextLabel?: string;
  onCitations?: (ids: string[]) => void;
  prominent?: boolean;
}) {
  const [Shell, setShell] = useState<Shell | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  const place = (rect?: DOMRect) => {
    const width = 400;
    const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) : 16;
    const top = rect ? Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 440)) : 72;
    return { top, left };
  };

  const open = (rect?: DOMRect) => {
    setAnchor(place(rect));
    void import("./ask-shell").then((mod) => setShell(() => mod.AskShell));
  };

  return (
    <span
      className="inline-flex"
      onMouseEnter={() => {
        claimEnsemble(() => open());
        void import("./ask-shell");
      }}
      onFocus={() => {
        claimEnsemble(() => open());
        void import("./ask-shell");
      }}
    >
      <button
        type="button"
        className={prominent ? "btn-primary min-h-8 px-3 text-[14px]" : "btn h-7 px-2 text-[12px]"}
        aria-label={label}
        onClick={(event) => open(event.currentTarget.getBoundingClientRect())}
      >
        {prominent ? label.replace(/^Ask Ensemble about /i, "Ask about ") : "Ask"}
      </button>
      {Shell && anchor ? (
        <Shell
          surface={surface}
          anchorKey={anchorKey}
          entityIds={entityIds}
          selection={selection}
          codeText={codeText}
          path={path}
          line={line}
          projectId={projectId}
          contextLabel={contextLabel}
          onCitations={onCitations}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </span>
  );
}
