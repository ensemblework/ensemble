"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { Editor } from "@tiptap/core";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FolderOpen, Plug, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileFormat, type FileRecord } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { placeAnchoredPanel } from "@/lib/place-layer";
import { fileKindIcon } from "../files/file-embed";
import { insertFile, uploadFiles } from "./file-attach";

const WIDTH = 320;

/** What `/file` opens at the cursor: upload, pick from Files, or bring one in from a connected app. */
export function FileChooser({ editor, pos, onClose }: { editor: Editor; pos: number; onClose: () => void }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<"menu" | "files">("menu");
  const [search, setSearch] = useState("");
  const term = search.trim();
  const files = useQuery({ queryKey: FILE_QUERY.list(term), queryFn: () => filesApi.list(term), enabled: mode === "files", placeholderData: keepPreviousData });
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const close = useCallback(() => {
    onClose();
    if (!editor.isDestroyed) editor.commands.focus();
  }, [editor, onClose]);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [close, onClose]);

  useLayoutEffect(() => {
    const place = () => {
      let anchor: { top: number; right: number; bottom: number; left: number };
      try {
        anchor = editor.view.coordsAtPos(Math.min(pos, editor.state.doc.content.size));
      } catch {
        return;
      }
      const next = placeAnchoredPanel({
        anchor,
        panelWidth: WIDTH,
        panelHeight: panel.current?.scrollHeight || 220,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap: 6,
      });
      setBox({ left: next.left, top: next.top, maxHeight: Math.min(next.maxHeight, 380) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [editor, pos, mode]);

  const upload = (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (!chosen.length) return;
    close();
    void uploadFiles(editor, chosen, { pos, client });
  };

  const pick = (file: FileRecord) => {
    onClose();
    insertFile(editor, file, pos);
  };

  const rows = files.data?.files ?? [];
  const option = "row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]";

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Attach a file"
      className="pop-in overflow-auto rounded-lg bg-raised p-1.5 shadow-pop"
      style={{ position: "fixed", zIndex: 90, width: WIDTH, left: box?.left ?? 0, top: box?.top ?? 0, maxHeight: box?.maxHeight ?? 380, visibility: box ? "visible" : "hidden" }}
    >
      {mode === "menu" ? (
        <>
          <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-muted">Attach a file</div>
          <button type="button" className={option} autoFocus onClick={() => input.current?.click()}>
            <Upload size={14} className="shrink-0 text-muted" aria-hidden />
            Upload from this computer
          </button>
          <button type="button" className={option} onClick={() => setMode("files")}>
            <FolderOpen size={14} className="shrink-0 text-muted" aria-hidden />
            Choose from Files
          </button>
          <a href="/files" className={option}>
            <Plug size={14} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0">
              <span className="block">From your apps</span>
              <span className="block text-[12px] text-muted">Bring it in from Drive, OneDrive, Dropbox or email in Files, then @mention it here.</span>
            </span>
          </a>
          <input ref={input} type="file" multiple hidden aria-label="Files to upload" onChange={(event) => upload(event.target.files)} />
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 border-b border-line px-1 pb-1.5">
            <button type="button" className="icon-btn" aria-label="Back" onClick={() => setMode("menu")}>
              <ArrowLeft size={14} />
            </button>
            <Search size={13} className="shrink-0 text-muted" aria-hidden />
            <input
              autoFocus
              aria-label="Search files"
              placeholder="Search files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && rows[0]) {
                  event.preventDefault();
                  pick(rows[0]);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
          </div>
          <div className="pt-1">
            {files.isLoading ? (
              <p className="px-2 py-2 text-[12.5px] text-muted">Loading files…</p>
            ) : files.error ? (
              <p role="alert" className="px-2 py-2 text-[12.5px] text-danger">{files.error.message}</p>
            ) : !rows.length ? (
              <p className="px-2 py-2 text-[12.5px] text-muted">{term ? "No files match." : "No files yet. Upload one from this computer."}</p>
            ) : (
              rows.map((file) => {
                const Icon = fileKindIcon(file.kind);
                return (
                  <button key={file.id} type="button" className={option} onClick={() => pick(file)}>
                    <Icon size={14} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate">{file.filename}</span>
                      <span className="block truncate text-[12px] text-muted">{`${fileFormat(file.filename).label} · ${formatBytes(file.byteSize)}`}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
