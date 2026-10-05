"use client";

import { useState } from "react";
import { stagePercent, type LinkChoice } from "@ensemble/shared-types";
import { API, ApiError, api } from "@/lib/api";
import { PlotDialog } from "@/components/plots/plot-dialog";

type Dataset = {
  id: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  warnings: string[];
};

const TYPES = ["number", "date", "category", "text"] as const;
const FORMATS = ["CSV", "TSV", "JSON", "Excel", "Numbers", "Parquet", "Feather"];

async function readBytes(file: File, onProgress: (percent: number, label: string) => void): Promise<Uint8Array> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(stagePercent("read", file.size ? received / file.size : 1), "Reading");
    if (file.size > 20_000) await new Promise((resolve) => setTimeout(resolve, 16));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function scanText(text: string, onProgress: (percent: number, label: string) => void) {
  const steps = text.length > 20_000 ? 12 : 1;
  for (let step = 1; step <= steps; step += 1) {
    onProgress(stagePercent("scan", step / steps), "Reading columns");
    if (steps > 1) await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function postDataset(body: unknown, onProgress: (percent: number, label: string) => void): Promise<Dataset> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/api/plots/datasets`);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(stagePercent("upload", event.loaded / event.total), "Uploading");
    };
    xhr.onerror = () => reject(new ApiError("Ensemble can't reach its server right now.", 0));
    xhr.onload = () => {
      const text = xhr.responseText || "";
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(stagePercent("done", 1), "Done");
        resolve((JSON.parse(text) as { dataset: Dataset }).dataset);
        return;
      }
      let message = "Could not read that file.";
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // the body was not JSON
      }
      reject(new ApiError(message, xhr.status));
    };
    xhr.send(payload);
  });
}

function Bar({ percent, label }: { percent: number; label: string }) {
  const turn = Math.max(0, Math.min(100, percent));
  return (
    <div data-upload-progress data-upload-percent={turn}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[28px] font-semibold leading-none">{turn}%</span>
        <span className="text-[13px] text-muted">{label}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
        <div className="h-full rounded-full" style={{ width: `${turn}%`, background: "var(--accent)" }} />
      </div>
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
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [pending, setPending] = useState<Dataset | null>(null);
  const [links, setLinks] = useState<Record<string, LinkChoice>>({});

  const report = (next: number, text: string) => {
    setPercent(next);
    setLabel(text);
  };

  const reset = () => {
    setBusy(false);
    setError("");
    setPending(null);
    setPercent(0);
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

  const sendFile = async (file: File) => {
    setBusy(true);
    setError("");
    setPending(null);
    try {
      const bytes = await readBytes(file, report);
      const textLike = /\.(csv|tsv|txt|json|jsonl)$/i.test(file.name) || file.type.startsWith("text/");
      if (textLike) {
        const text = new TextDecoder().decode(bytes);
        await scanText(text, report);
        finish(await postDataset({ name: file.name.replace(/\.[^.]+$/, ""), filename: file.name, text }, report));
      } else {
        report(stagePercent("scan", 1), "Reading columns");
        let binary = "";
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
        finish(await postDataset({ filename: file.name, fileBase64: btoa(binary) }, report));
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
    <PlotDialog open={open} onClose={() => { reset(); onClose(); }} title="Add data" width={560}>
      {pending ? (
        <div data-column-summary>
          <p className="text-[14px] font-medium">{pending.name}</p>
          <p className="mt-1 text-[13px] text-muted">{pending.rowCount.toLocaleString()} rows · {pending.columns.length} columns</p>
          <ul className="mt-3 divide-y divide-line">
            {pending.columns.map((column) => (
              <li key={column.name} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
                <span className="min-w-0 truncate">{column.name}</span>
                <select
                  className="field h-8"
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
            <div className="mt-3 rounded-lg border border-line px-3 py-2" data-duplicate-links>
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
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => { void api.deletePlotDataset(pending.id); reset(); }}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => { onAccept(pending, links); reset(); onClose(); }}>OK</button>
          </div>
        </div>
      ) : busy ? (
        <div className="py-6" data-upload-busy>
          <Bar percent={percent} label={label} />
          <p className="mt-3 text-[12px] text-muted">Parsing finishes when the bar reaches 100. Nothing here spins.</p>
        </div>
      ) : (
        <div className="space-y-3" data-upload-start>
          <label className="block rounded-xl border border-dashed border-line px-4 py-8 text-center" data-plot-drop>
            <span className="block text-[14px] font-medium">Drop a file, or choose one</span>
            <span className="mt-2 flex flex-wrap justify-center gap-1">
              {FORMATS.map((format) => <span key={format} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{format}</span>)}
            </span>
            <input
              className="mt-3 block w-full text-[12px]"
              type="file"
              data-plot-file
              aria-label="Upload file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void sendFile(file);
              }}
            />
          </label>
          <label className="block text-[12px] text-muted">Public link
            <input className="field mt-1 w-full" aria-label="Sheet link" value={url} placeholder="Google Sheets, Drive, OneDrive, or SharePoint" onChange={(event) => setUrl(event.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!url.trim()}
            onClick={() => {
              setBusy(true);
              setError("");
              report(stagePercent("upload", 0), "Fetching the link");
              void postDataset({ url: url.trim() }, report).then(finish).catch((reason: unknown) => {
                setBusy(false);
                setError(reason instanceof Error ? reason.message : "Could not fetch that link.");
              });
            }}
          >
            Fetch link
          </button>
          <label className="block text-[12px] text-muted">Paste
            <textarea className="field mt-1 h-24 w-full" aria-label="Paste table" value={paste} onChange={(event) => setPaste(event.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!paste.trim()}
            onClick={() => {
              setBusy(true);
              setError("");
              void scanText(paste, report).then(() => postDataset({ text: paste, filename: "pasted.csv" }, report)).then(finish).catch((reason: unknown) => {
                setBusy(false);
                setError(reason instanceof Error ? reason.message : "Could not read that paste.");
              });
            }}
          >
            Use paste
          </button>
          {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
        </div>
      )}
    </PlotDialog>
  );
}
