"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

const EnsemblePanel = dynamic(() => import("./panel").then((mod) => mod.EnsemblePanel), { ssr: false });

export function AskShell({
  surface,
  anchorKey,
  entityIds,
  selection,
  codeText,
  path,
  line,
  projectId,
  contextLabel,
  onCitations,
  onClose,
  anchor,
}: {
  surface: string;
  anchorKey: string;
  entityIds?: string[];
  selection?: string;
  codeText?: string;
  path?: string;
  line?: number;
  projectId?: string;
  contextLabel?: string;
  onCitations?: (ids: string[]) => void;
  onClose: () => void;
  anchor: { top: number; left: number };
}) {
  const id = useId();
  const [box, setBox] = useState(anchor);
  useEffect(() => {
    const place = () => {
      const width = Math.min(400, window.innerWidth - 16);
      const height = Math.min(420, window.innerHeight - 16);
      setBox({
        top: Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor.top, anchor.left]);
  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) onClose();
    };
    window.addEventListener("ensemble-open", onOpen);
    window.dispatchEvent(new CustomEvent("ensemble-open", { detail: id }));
    return () => window.removeEventListener("ensemble-open", onOpen);
  }, [id, onClose]);
  return createPortal(
    <div
      className="fixed z-[90] w-[400px] max-w-[calc(100vw-16px)]"
      style={{ top: box.top, left: box.left }}
      data-ensemble-panel
      data-surface={surface}
    >
      <EnsemblePanel
        surface={surface}
        anchorKey={anchorKey}
        entityIds={entityIds}
        selection={selection}
        codeText={codeText}
        path={path}
        line={line}
        projectId={projectId}
        contextLabel={contextLabel}
        onClose={onClose}
        onCitations={onCitations}
      />
    </div>,
    document.body,
  );
}
