"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Plus, Save, Trash2, Undo2, Pencil, FileSpreadsheet } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FILE_FORMATS, type FileRecord } from "@ensemble/shared-types";
import { filesApi } from "@/lib/api-files";
import { baseName } from "@/lib/files/formats";
import { buildSheetPatch, cellText, columnName, looksLikeHeader, parseCellInput, readDelimited, readWorkbook, toDelimited, type CellValue, type SheetData, type WorkingRow } from "@/lib/files/sheet";
import { emitToast } from "@/lib/toast-bus";
import { Dialog, Spinner, cx } from "../../ui";
import { useFileSaved } from "../use-file";
import { DownloadButton, Toolbar, ViewerNote, type ViewerProps } from "./shared";

const ROW = 28;
const OVERSCAN = 12;
const GUTTER = 52;
const COMPACT_ROWS = 15;
const XLSX_TYPE = FILE_FORMATS.find((format) => format.ext === "xlsx")!.mime;

type Book = { sheets: SheetData[]; delimited?: { separator: string; bom: boolean; newline: string } };
type Mode = "cells" | "text" | "copy" | "readonly";
type Cell = { r: number; c: number };

function useBook(bytes: ArrayBuffer, ext: string): { book: Book | null; error: string | null } {
  const [state, setState] = useState<{ book: Book | null; error: string | null }>({ book: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ book: null, error: null });
    const done = (book: Book) => live && setState({ book, error: null });
    const fail = () => live && setState({ book: null, error: "This spreadsheet could not be read. It may be damaged or password-protected." });
    if (ext === "csv" || ext === "tsv") {
      const separator = ext === "tsv" ? "\t" : ",";
      const timer = window.setTimeout(() => {
        try {
          const { sheet, bom, newline } = readDelimited(new Uint8Array(bytes), separator);
          done({ sheets: [sheet], delimited: { separator, bom, newline } });
        } catch {
          fail();
        }
      }, 0);
      return () => {
        live = false;
        window.clearTimeout(timer);
      };
    }
    void import("xlsx")
      .then((XLSX) => done({ sheets: readWorkbook(XLSX, new Uint8Array(bytes)) }))
      .catch(fail);
    return () => {
      live = false;
    };
  }, [bytes, ext]);
  return state;
}

/** Asks before leaving with unsaved edits: closing the tab, and links inside the app. */
function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link || link.getAttribute("target") === "_blank" || link.hasAttribute("download")) return;
      if (window.confirm("You have unsaved changes in this spreadsheet. Leave without saving them?")) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [active]);
}

function startRows(sheet: SheetData): WorkingRow[] {
  return sheet.rows.map((row, index) => ({ origin: index + 1, values: row.map((cell) => cell?.value ?? null) }));
}

function originalValues(sheet: SheetData): CellValue[][] {
  return sheet.rows.map((row) => row.map((cell) => cell?.value ?? null));
}

type GridProps = {
  sheet: SheetData;
  rows: WorkingRow[] | null;
  header: boolean;
  limit?: number;
  editable: boolean;
  textValues: boolean;
  selected: Cell;
  onSelect: (cell: Cell) => void;
  onChange: (cell: Cell, value: CellValue) => void;
};

function Grid({ sheet, rows, header, limit, editable, textValues, selected, onSelect, onChange }: GridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [edit, setEdit] = useState<{ cell: Cell; text: string } | null>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setViewport(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.min(limit ?? Number.POSITIVE_INFINITY, rows ? rows.length : sheet.rows.length);
  const extra = rows ? Math.max(0, ...rows.slice(0, 2000).map((row) => row.values.length)) : 0;
  const columns = Math.max(sheet.columns, extra, 1);
  const widths = Array.from({ length: columns }, (_, col) => sheet.widths[col] ?? 96);
  const total = GUTTER + widths.reduce((sum, width) => sum + width, 0);
  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);

  const cellAt = (r: number, c: number): { text: string; value: CellValue; formula?: string } => {
    const working = rows?.[r];
    const original = working ? (working.origin ? sheet.rows[working.origin - 1]?.[c] : null) : sheet.rows[r]?.[c];
    if (!working) return original ? { text: original.text, value: original.value, formula: original.formula } : { text: "", value: null };
    const value = working.values[c] ?? null;
    if (original && (original.value === value || (original.value === null && value === ""))) return { text: original.text, value, formula: original.formula };
    return { text: cellText(value), value };
  };
  const label = (r: number) => (rows ? (rows[r]?.origin ?? null) : r + 1);

  const reveal = useCallback(
    (cell: Cell) => {
      const node = scroller.current;
      if (!node) return;
      const top = cell.r * ROW;
      const headerHeight = ROW;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + ROW > node.scrollTop + node.clientHeight - headerHeight) node.scrollTop = top + ROW - node.clientHeight + headerHeight;
      const left = widths.slice(0, cell.c).reduce((sum, width) => sum + width, 0);
      const width = widths[cell.c] ?? 96;
      if (left < node.scrollLeft) node.scrollLeft = left;
      else if (GUTTER + left + width > node.scrollLeft + node.clientWidth) node.scrollLeft = GUTTER + left + width - node.clientWidth;
    },
    [widths],
  );

  const move = (cell: Cell) => {
    const next = { r: Math.max(0, Math.min(rowCount - 1, cell.r)), c: Math.max(0, Math.min(columns - 1, cell.c)) };
    onSelect(next);
    reveal(next);
  };
  // Removing the input can blur it; the ref keeps a cancelled or finished edit from saving twice.
  const live = useRef(edit);
  live.current = edit;
  const commit = (cell: Cell, text: string) => {
    if (!live.current) return;
    live.current = null;
    setEdit(null);
    onChange(cell, textValues ? (text === "" ? null : text) : parseCellInput(text));
    scroller.current?.focus();
  };
  const cancel = () => {
    live.current = null;
    setEdit(null);
    scroller.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (edit) return;
    const { r, c } = selected;
    const moves: Record<string, Cell> = { ArrowUp: { r: r - 1, c }, ArrowDown: { r: r + 1, c }, ArrowLeft: { r, c: c - 1 }, ArrowRight: { r, c: c + 1 }, Tab: { r, c: event.shiftKey ? c - 1 : c + 1 } };
    if (moves[event.key]) {
      event.preventDefault();
      move(moves[event.key]!);
      return;
    }
    if (!editable || !rowCount) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      const current = cellAt(r, c);
      setEdit({ cell: selected, text: current.formula && !textValues ? cellText(current.value) : current.text });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onChange(selected, null);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setEdit({ cell: selected, text: event.key });
    }
  };

  return (
    <div
      ref={scroller}
      tabIndex={0}
      role="grid"
      aria-label={`${sheet.name} cells`}
      aria-rowcount={rowCount}
      aria-colcount={columns}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="h-full overflow-auto outline-none"
      data-sheet-grid
    >
      <table className="border-separate border-spacing-0 text-[12.5px]" style={{ tableLayout: "fixed", width: total }}>
        <colgroup>
          <col style={{ width: GUTTER }} />
          {widths.map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ height: ROW }}>
            <th className="sticky left-0 top-0 z-20 border-b border-r border-line bg-raised" />
            {widths.map((_, col) => (
              <th key={col} scope="col" className={cx("sticky top-0 z-10 border-b border-r border-line bg-raised px-2 text-center font-normal text-faint", selected.c === col && "text-ink")}>
                {columnName(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 ? <tr aria-hidden style={{ height: start * ROW }} /> : null}
          {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
            const r = start + offset;
            const isHeader = header && (rows ? rows[r]?.origin === 1 : r === 0);
            const number = label(r);
            return (
              <tr key={r} style={{ height: ROW }} aria-rowindex={r + 1} data-row={r}>
                <th scope="row" className={cx("sticky left-0 z-10 border-b border-r border-line bg-raised px-1 text-right font-normal tabular-nums text-faint", selected.r === r && "text-ink")}>
                  {number ?? "+"}
                </th>
                {widths.map((_, c) => {
                  const active = selected.r === r && selected.c === c;
                  if (edit && edit.cell.r === r && edit.cell.c === c) {
                    return (
                      <td key={c} className="border-b border-r border-line p-0">
                        <input
                          autoFocus
                          aria-label={`${columnName(c)}${number ?? ""}`}
                          className="h-full w-full bg-panel px-2 text-[12.5px] text-ink outline outline-2 outline-accent"
                          value={edit.text}
                          onChange={(event) => setEdit({ cell: edit.cell, text: event.target.value })}
                          onBlur={() => commit(edit.cell, edit.text)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === "Tab") {
                              event.preventDefault();
                              commit(edit.cell, edit.text);
                              move(event.key === "Enter" ? { r: r + (event.shiftKey ? -1 : 1), c } : { r, c: c + (event.shiftKey ? -1 : 1) });
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancel();
                            }
                          }}
                        />
                      </td>
                    );
                  }
                  const cell = cellAt(r, c);
                  return (
                    <td
                      key={c}
                      role="gridcell"
                      aria-selected={active}
                      title={cell.text.length > 24 ? cell.text : undefined}
                      onMouseDown={() => onSelect({ r, c })}
                      onDoubleClick={() => {
                        if (!editable) return;
                        onSelect({ r, c });
                        setEdit({ cell: { r, c }, text: cell.formula && !textValues ? cellText(cell.value) : cell.text });
                      }}
                      className={cx(
                        "truncate border-b border-r border-line px-2",
                        typeof cell.value === "number" ? "text-right tabular-nums" : "text-left",
                        isHeader ? "bg-hover font-semibold text-ink" : "text-ink/90",
                        active && "shadow-[inset_0_0_0_2px_var(--accent)]",
                      )}
                    >
                      {cell.text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {end < rowCount ? <tr aria-hidden style={{ height: (rowCount - end) * ROW }} /> : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Spreadsheets: sheet tabs and a fast grid. Excel workbooks (.xlsx, .xlsm) are edited and
 * saved into the same file on the server, which keeps their formatting; CSV and TSV are
 * saved as text; older formats can be turned into an editable .xlsx.
 */
export default function SheetViewer({ file, format, bytes, compact }: ViewerProps) {
  const { book, error } = useBook(bytes, format.ext);
  const mode: Mode = format.edit === "cells" ? "cells" : format.edit === "text" ? "text" : ["xls", "ods", "numbers"].includes(format.ext) ? "copy" : "readonly";
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<Cell>({ r: 0, c: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<number, WorkingRow[]>>({});
  const [changed, setChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState<"ask" | "busy" | null>(null);
  const saved = useFileSaved();
  useLeaveGuard(changed);

  useEffect(() => {
    setDraft({});
    setChanged(false);
    setEditing(false);
  }, [bytes]);

  const sheet = book?.sheets[Math.min(active, (book?.sheets.length ?? 1) - 1)];
  const header = useMemo(() => (sheet ? looksLikeHeader(sheet.rows) : false), [sheet]);
  if (error) return <ViewerNote title={error} file={file} bytes={bytes} compact={compact} />;
  if (!book || !sheet) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const tooBig = book.sheets.some((entry) => entry.truncated);
  const canEdit = (mode === "cells" || mode === "text") && !tooBig && !compact;
  const rows = draft[active] ?? null;
  const change = (cell: Cell, value: CellValue) => {
    const working = draft[active] ?? startRows(sheet);
    const next = working.map((row, index) => {
      if (index !== cell.r) return row;
      const values = [...row.values];
      while (values.length <= cell.c) values.push(null);
      values[cell.c] = value;
      return { ...row, values };
    });
    setDraft({ ...draft, [active]: next });
    setChanged(true);
  };
  const addRow = () => {
    const working = draft[active] ?? startRows(sheet);
    setDraft({ ...draft, [active]: [...working, { origin: null, values: [] }] });
    setSelected({ r: working.length, c: 0 });
    setChanged(true);
  };
  const deleteRow = () => {
    const working = draft[active] ?? startRows(sheet);
    if (!working.length) return;
    setDraft({ ...draft, [active]: working.filter((_, index) => index !== selected.r) });
    setSelected({ r: Math.max(0, Math.min(selected.r, working.length - 2)), c: selected.c });
    setChanged(true);
  };
  const discard = () => {
    setDraft({});
    setChanged(false);
    setEditing(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      let result: { file: FileRecord } | null = null;
      if (mode === "cells") {
        const patch = buildSheetPatch(
          book.sheets.flatMap((entry, index) => (draft[index] ? [{ name: entry.name, original: originalValues(entry), rows: draft[index]! }] : [])),
        );
        if (patch.sheets.length) result = await filesApi.saveCells(file.id, patch);
      } else if (book.delimited) {
        const values = (draft[0] ?? startRows(book.sheets[0]!)).map((row) => row.values);
        const text = toDelimited(values, book.delimited.separator, book.delimited.newline);
        result = await filesApi.replace(file.id, { bytes: new TextEncoder().encode(book.delimited.bom ? `\uFEFF${text}` : text) });
      }
      setChanged(false);
      setEditing(false);
      setDraft({});
      if (result) {
        saved(result.file);
        emitToast(`Saved ${result.file.filename}.`, { tone: "ok" });
      }
    } catch (caught) {
      emitToast(caught instanceof Error ? caught.message : "Could not save the spreadsheet.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const makeCopy = async () => {
    setCopying("busy");
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(new Uint8Array(bytes), { type: "array", cellFormula: true, cellStyles: true, cellNF: true });
      const out = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
      const result = await filesApi.replace(file.id, { bytes: out, filename: `${baseName(file.filename)}.xlsx`, mediaType: XLSX_TYPE });
      saved(result.file);
      emitToast(`${result.file.filename} is ready to edit.`, { tone: "ok" });
      setCopying(null);
    } catch (caught) {
      emitToast(caught instanceof Error ? caught.message : "Could not make the .xlsx copy.", { tone: "error" });
      setCopying("ask");
    }
  };

  const count = rows ? rows.length : sheet.rows.length;
  const current = (() => {
    const working = rows?.[selected.r];
    const original = working ? (working.origin ? sheet.rows[working.origin - 1]?.[selected.c] : null) : sheet.rows[selected.r]?.[selected.c];
    const value = working ? (working.values[selected.c] ?? null) : (original?.value ?? null);
    if (original?.formula && original.value === value) return `=${original.formula}`;
    return working ? cellText(value) : (original?.text ?? "");
  })();

  if (compact) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-sheet-compact>
        <div className="min-h-0 flex-1">
          {sheet.rows.length ? (
            <Grid sheet={sheet} rows={null} header={header} limit={COMPACT_ROWS} editable={false} textValues={mode === "text"} selected={selected} onSelect={setSelected} onChange={() => undefined} />
          ) : (
            <ViewerNote title="This sheet is empty." compact />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-2 py-1 text-[11.5px] text-faint">
          <span className="truncate">{sheet.name}</span>
          <span>·</span>
          <span>
            {sheet.rows.length.toLocaleString()} {sheet.rows.length === 1 ? "row" : "rows"}
            {book.sheets.length > 1 ? ` · ${book.sheets.length} sheets` : ""}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-sheet-viewer data-editing={editing ? "true" : "false"}>
      <Toolbar>
        <span className="w-14 shrink-0 rounded border border-line bg-panel px-1.5 py-0.5 text-center font-mono text-[12px] text-ink" aria-label="Selected cell">
          {columnName(selected.c)}
          {rows ? (rows[selected.r]?.origin ?? "+") : selected.r + 1}
        </span>
        <span className="min-w-0 flex-1 truncate rounded border border-line bg-panel px-2 py-0.5 font-mono text-[12px] text-ink" aria-label="Cell contents" title={current}>
          {current || " "}
        </span>
        {editing ? (
          <span className="flex flex-wrap items-center gap-1">
            {changed ? <span className="px-1 text-warn">Unsaved changes</span> : null}
            <button type="button" className="btn-ghost" onClick={addRow}>
              <Plus size={13} aria-hidden /> Add row
            </button>
            <button type="button" className="btn-ghost" onClick={deleteRow} disabled={!count}>
              <Trash2 size={13} aria-hidden /> Delete row
            </button>
            <button type="button" className="btn-ghost" onClick={discard} disabled={saving}>
              <Undo2 size={13} aria-hidden /> {changed ? "Discard" : "Done"}
            </button>
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={!changed || saving}>
              {saving ? <Spinner size={12} /> : <Save size={13} aria-hidden />} Save
            </button>
          </span>
        ) : canEdit ? (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            <Pencil size={13} aria-hidden /> Edit
          </button>
        ) : mode === "copy" ? (
          <button type="button" className="btn" onClick={() => setCopying("ask")}>
            <FileSpreadsheet size={13} aria-hidden /> Make an editable .xlsx copy
          </button>
        ) : null}
      </Toolbar>
      {tooBig ? <p className="border-b border-line px-3 py-1.5 text-[12px] text-muted">Showing the first 50,000 rows. Sheets this large can be viewed here but not edited; download the file to edit it.</p> : null}
      {editing ? (
        <p className="border-b border-line px-3 py-1.5 text-[12px] text-muted">
          {mode === "cells"
            ? "Double-click a cell or start typing to change it. Saving keeps the file's formatting; a cell you change keeps a value, not its formula."
            : "Double-click a cell or start typing to change it. Saving writes the file back as plain text."}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {count ? (
          <Grid sheet={sheet} rows={rows} header={header} editable={editing} textValues={mode === "text"} selected={selected} onSelect={setSelected} onChange={change} />
        ) : (
          <ViewerNote title="This sheet is empty.">{editing ? "Use Add row to start it." : null}</ViewerNote>
        )}
      </div>
      {book.sheets.length > 1 ? (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-t border-line px-2 py-1" role="tablist" aria-label="Sheets">
          {book.sheets.map((entry, index) => (
            <button
              key={`${entry.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => {
                setActive(index);
                setSelected({ r: 0, c: 0 });
              }}
              className={cx("shrink-0 rounded-md px-2.5 py-1 text-[12.5px]", index === active ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {entry.name}
              {draft[index] ? " •" : ""}
            </button>
          ))}
        </div>
      ) : null}
      <Dialog open={copying !== null} onClose={() => setCopying(null)} title="Make an editable copy" width={460}>
        <div className="space-y-3 text-[13px] leading-5">
          <p>
            {format.label} files cannot be edited here. Ensemble can turn <span className="font-medium">{file.filename}</span> into <span className="font-medium">{baseName(file.filename)}.xlsx</span>, which you can edit and save.
          </p>
          <p className="text-muted">This replaces the file in Ensemble. Values, formulas and every sheet come across; some formatting, charts and pictures may not. Download the original first if you want to keep it.</p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <DownloadButton file={file} bytes={bytes} label="Download original" className="mr-auto" />
            <button type="button" className="btn-ghost" onClick={() => setCopying(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={copying === "busy"} onClick={() => void makeCopy()}>
              {copying === "busy" ? <Spinner size={12} /> : null} Make .xlsx copy
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
