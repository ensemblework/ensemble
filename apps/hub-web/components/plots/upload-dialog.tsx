"use client";

import { ClipboardPaste, Link2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE, type LinkChoice } from "@ensemble/shared-types";
import { API, ApiError, api } from "@/lib/api";
import { parseTableInBrowser, usePythonStatus } from "@/lib/plots/browser-python";
import { plotsRunOnServer } from "@/lib/plots/render";
import { PlotDialog } from "@/components/plots/plot-dialog";
import { Spinner } from "@/components/ui";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";

type Dataset = {
  id: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  warnings: string[];
};

const TYPES = ["number", "date", "category", "text"] as const;
const FORMATS = ["CSV", "TSV", "JSON", "Excel", "Numbers", "Parquet", "Feather"];
const ACCEPT = ".csv,.tsv,.txt,.json,.jsonl,.ndjson,.xlsx,.xls,.xlsm,.ods,.numbers,.parquet,.feather,.arrow";

type ReportProgress = (percent: number | null, label: string) => void;

async function readBytes(file: File, onProgress: ReportProgress): Promise<Uint8Array> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress(0, "Reading the file");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(file.size ? Math.round(received / file.size * 100) : null, "Reading the file");
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function postDataset(body: unknown, onProgress: ReportProgress, processingLabel = "Reading the table"): Promise<Dataset> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/api/plots/datasets`);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.upload.onprogress = (event) => {
      onProgress(event.lengthComputable && event.total > 0 ? Math.round(event.loaded / event.total * 100) : null, "Uploading");
    };
    xhr.upload.onload = () => onProgress(null, processingLabel);
    xhr.onerror = () => reject(new ApiError("Ensemble can't reach its server right now.", 0));
    xhr.onload = () => {
      const text = xhr.responseText || "";
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(text) as { dataset: Dataset };
          onProgress(100, "Done");
          resolve(result.dataset);
        } catch {
          reject(new ApiError("Ensemble returned an unreadable table. Try again.", xhr.status));
        }
        return;
      }
      let message = "Could not read that file.";
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; code?: string };
        if (parsed.error) message = parsed.error;
        code = parsed.code;
      } catch {
        // the body was not JSON
      }
      reject(new ApiError(message, xhr.status, code));
    };
    onProgress(null, "Uploading");
    xhr.send(payload);
  });
}

function Bar({ percent, label }: { percent: number | null; label: string }) {
  const turn = percent === null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div data-upload-progress data-upload-percent={turn}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="flex items-center gap-2 text-[13px] text-muted" role="status">{turn === null ? <Spinner /> : null}{label}</span>
        {turn !== null ? <span className="text-[20px] font-medium tabular-nums leading-none">{turn}%</span> : null}
      </div>
      {turn !== null ? <div className="h-1 overflow-hidden rounded-full" style={{ background: "var(--line)" }} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={turn}>
        <div className="h-full rounded-full" style={{ width: `${turn}%`, background: "var(--accent)" }} />
      </div> : null}
    </div>
  );
}

export function UploadDialog({
  open,
  existing,
  onClose,
  onAccept,
}: {
  open: boolean;
  existing: Array<{ name: string; type: string; source: string }>;
  onClose: () => void;
  onAccept: (dataset: Dataset, links: Record<string, LinkChoice>) => void;
}) {
  const [percent, setPercent] = useState<number | null>(null);
  const [label, setLabel] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const showProgress = useDelayedFlag(busy);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [pending, setPending] = useState<Dataset | null>(null);
  const [links, setLinks] = useState<Record<string, LinkChoice>>({});
  // A workbook read in the browser with more than one sheet: which one to add.
  const [choose, setChoose] = useState<{ file: File; bytes: Uint8Array; sheets: string[]; sheet: string } | null>(null);
  const python = usePythonStatus();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const report: ReportProgress = (next, text) => {
    setPercent(next);
    setLabel(text);
  };

  const reset = () => {
    setBusy(false);
    setError("");
    setPending(null);
    setChoose(null);
    setPercent(null);
    setLabel("Ready");
    setLinks({});
  };

  const finish = (dataset: Dataset) => {
    const next: Record<string, LinkChoice> = {};
    for (const column of dataset.columns) {
      if (existing.some((item) => item.name === column.name)) next[column.name] = "separate";
    }
    setLinks(next);
    setPending(dataset);
    setBusy(false);
    report(100, "Done");
  };

  /**
   * Ensemble on the web reads spreadsheets and Arrow files in the browser (the server runs Python only
   * for its operator): the plot runtime's own reader, then the table is saved as columns and rows.
   */
  const addInBrowser = async (file: File, bytes: Uint8Array, sheet = "") => {
    setBusy(true);
    setChoose(null);
    report(null, "Reading in your browser");
    const table = await parseTableInBrowser(file.name, bytes, sheet);
    if (!sheet && table.sheets.length > 1) {
      setChoose({ file, bytes, sheets: table.sheets, sheet: table.sheet });
      setBusy(false);
      return;
    }
    if (!table.columns.length) throw new Error("That sheet has no table.");
    const dataset = await postDataset({ name: file.name.replace(/\.[^.]+$/, ""), columns: table.columns, rows: table.rows }, report);
    finish({ ...dataset, warnings: [...table.warnings, ...dataset.warnings] });
  };

  const sendFile = async (file: File) => {
    // Refused before it is read, so a large file never fills the browser's memory.
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(UPLOAD_TOO_LARGE);
      return;
    }
    setBusy(true);
    setError("");
    setPending(null);
    try {
      const bytes = await readBytes(file, report);
      const textLike = /\.(csv|tsv|txt|json|jsonl)$/i.test(file.name) || file.type.startsWith("text/");
      if (textLike) {
        const text = new TextDecoder().decode(bytes);
        finish(await postDataset({ name: file.name.replace(/\.[^.]+$/, ""), filename: file.name, text }, report));
      } else {
        if (!(await plotsRunOnServer())) return await addInBrowser(file, bytes);
        report(null, "Preparing the file");
        let binary = "";
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
        try {
          finish(await postDataset({ filename: file.name, fileBase64: btoa(binary) }, report));
        } catch (reason) {
          if (!(reason instanceof ApiError && reason.status === 403 && reason.code === "HOST_ACCESS_DENIED")) throw reason;
          await addInBrowser(file, bytes);
        }
      }
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "Could not read that file.");
    }
  };

  const collisions = pending
    ? pending.columns.flatMap((column) => {
        const matches = existing.filter((item) => item.name === column.name);
        if (!matches.length) return [];
        const sameType = matches.every((item) => item.type === column.type);
        return [{ name: column.name, type: column.type, sources: matches.map((item) => item.source), sameType }];
      })
    : [];

  return (
    <PlotDialog open={open} onClose={() => { reset(); onClose(); }} title="Add data" description="Every chart on this canvas can use the table." width={560}>
      {pending ? (
        <div data-column-summary>
          <p className="text-[14px] font-semibold">{pending.name}</p>
          <p className="mt-0.5 text-[12.5px] text-muted">{pending.rowCount.toLocaleString()} rows · {pending.columns.length} columns · check each column’s type</p>
          <ul className="pl-col-list mt-3">
            {pending.columns.map((column) => (
              <li key={column.name} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13px]">
                <span className="min-w-0 truncate">{column.name}</span>
                <select
                  className="pl-select"
                  aria-label={`${column.name} type`}
                  value={column.type}
                  onChange={(event) => {
                    const type = event.target.value;
                    const columns = pending.columns.map((item) => item.name === column.name ? { ...item, type } : item);
                    setPending({ ...pending, columns });
                    void api.updatePlotDataset(pending.id, { columns });
                  }}
                >
                  {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </li>
            ))}
          </ul>
          {collisions.length ? (
            <div className="mt-3 rounded-xl border border-line px-3 py-2" data-duplicate-links>
              <p className="mb-2 text-[12px] text-muted">These names are already on the canvas. A key can join. A measure should stay separate.</p>
              {collisions.map((group) => (
                <div key={group.name} className="flex flex-wrap items-center gap-2 py-1 text-[13px]">
                  <span className="font-medium">{group.name}</span>
                  <button type="button" className={`rounded-md px-2 py-1 ${links[group.name] !== "join" ? "bg-accent-soft" : "text-muted"}`} aria-pressed={links[group.name] !== "join"} onClick={() => setLinks({ ...links, [group.name]: "separate" })}>Keep separate</button>
                  <button type="button" className={`rounded-md px-2 py-1 ${links[group.name] === "join" ? "bg-accent-soft" : "text-muted"}`} aria-pressed={links[group.name] === "join"} disabled={!group.sameType} onClick={() => setLinks({ ...links, [group.name]: "join" })}>Join on this column</button>
                  {!group.sameType ? <span className="text-[12px] text-faint">Types differ, so this cannot be a key.</span> : <span className="text-[12px] text-faint">{group.sources.join(" · ")}</span>}
                </div>
              ))}
            </div>
          ) : null}
          {pending.warnings.length ? <p className="mt-2 text-[12px] text-warn">{pending.warnings.join(" ")}</p> : null}
          <div className="pl-dialog-footer">
            <button type="button" className="pl-btn" onClick={() => { void api.deletePlotDataset(pending.id); reset(); }}>Cancel</button>
            <button type="button" className="btn-primary pl-primary" onClick={() => { onAccept(pending, links); reset(); onClose(); }}>OK</button>
          </div>
        </div>
      ) : choose ? (
        <div className="space-y-3" data-sheet-choice>
          <p className="text-[13px]">{choose.file.name} has {choose.sheets.length} sheets. Which one?</p>
          <select className="pl-select w-full" aria-label="Sheet" value={choose.sheet} onChange={(event) => setChoose({ ...choose, sheet: event.target.value })}>
            {choose.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
          </select>
          <div className="pl-dialog-footer">
            <button type="button" className="pl-btn" onClick={reset}>Cancel</button>
            <button
              type="button"
              className="btn-primary pl-primary"
              onClick={() => void addInBrowser(choose.file, choose.bytes, choose.sheet).catch((reason: unknown) => {
                setBusy(false);
                setError(reason instanceof Error ? reason.message : "Could not read that file.");
              })}
            >
              Use this sheet
            </button>
          </div>
        </div>
      ) : busy ? (
        <div className="min-h-[120px] py-6" data-upload-busy aria-busy="true">
          <div style={{ visibility: showProgress ? "visible" : "hidden" }}>
            <Bar percent={percent} label={python === "loading" ? "Starting Python in your browser" : label} />
            {python === "loading" ? <p className="mt-3 text-[12px] text-muted">The first download is about 30 MB. Your browser keeps it for next time.</p> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-4" data-upload-start>
          <div
            className="pl-drop"
            data-plot-drop
            data-dragging={dragging ? "1" : undefined}
            onDragOver={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void sendFile(file);
            }}
          >
            <span className="pl-drop-icon" aria-hidden><UploadCloud size={22} /></span>
            <span className="block text-[14px] font-semibold">Drop a file here</span>
            <span className="block text-[12px] text-muted">Up to {MAX_UPLOAD_BYTES / (1024 * 1024)} MB</span>
            <button type="button" className="btn-primary pl-primary mt-1" onClick={() => fileInput.current?.click()}>Choose a file</button>
            <span className="mt-1 flex flex-wrap justify-center gap-1">
              {FORMATS.map((format) => <span key={format} className="pl-format">{format}</span>)}
            </span>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept={ACCEPT}
              tabIndex={-1}
              data-plot-file
              aria-label="Upload file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void sendFile(file);
              }}
            />
          </div>
          <div className="pl-or" aria-hidden><span>or</span></div>
          <div>
            <label className="pl-field-label" htmlFor="plot-sheet-link"><Link2 size={13} aria-hidden />Public link</label>
            <div className="pl-inline">
              <input id="plot-sheet-link" className="pl-input" aria-label="Sheet link" value={url} placeholder="Google Sheets, Drive, OneDrive, or SharePoint" onChange={(event) => setUrl(event.target.value)} />
              <button
                type="button"
                className="pl-btn"
                disabled={!url.trim()}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void postDataset({ url: url.trim() }, report, "Fetching the link").then(finish).catch((reason: unknown) => {
                    setBusy(false);
                    // On Ensemble on the web the server does not read spreadsheets; the browser can, from a file.
                    if (reason instanceof ApiError && reason.status === 403 && reason.code === "HOST_ACCESS_DENIED") {
                      setError("That link is a spreadsheet. Download it (as Excel or CSV) and add the file here: it is read in your browser.");
                      return;
                    }
                    setError(reason instanceof Error ? reason.message : "Could not fetch that link.");
                  });
                }}
              >
                Fetch link
              </button>
            </div>
          </div>
          <div>
            <label className="pl-field-label" htmlFor="plot-paste"><ClipboardPaste size={13} aria-hidden />Paste a table</label>
            <textarea id="plot-paste" className="pl-input pl-textarea" aria-label="Paste table" placeholder={"epoch,loss\n1,0.92\n2,0.71"} value={paste} onChange={(event) => setPaste(event.target.value)} />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="pl-btn"
                disabled={!paste.trim()}
                onClick={() => {
                  if (new Blob([paste]).size > MAX_UPLOAD_BYTES) {
                    setError(UPLOAD_TOO_LARGE);
                    return;
                  }
                  setBusy(true);
                  setError("");
                  void postDataset({ text: paste, filename: "pasted.csv" }, report).then(finish).catch((reason: unknown) => {
                    setBusy(false);
                    setError(reason instanceof Error ? reason.message : "Could not read that paste.");
                  });
                }}
              >
                Use paste
              </button>
            </div>
          </div>
          {error ? <p className="text-[12.5px] text-danger" role="alert">{error}</p> : null}
        </div>
      )}
    </PlotDialog>
  );
}
