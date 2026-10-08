"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, Download, RefreshCw, Search, Trash2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { api, type DocumentRecord } from "@/lib/api";
import { documentSummaryLine, summaryTagTone } from "@/lib/document-summary";
import { bytes, dateTime, plural, relative } from "@/lib/format";
import { useToast } from "../toast";
import { Dialog, Empty, Spinner, Tag, cx } from "../ui";

const ACCEPT = ".docx,.pptx,.pdf,.md,.markdown,.txt,.csv,.json,.yaml,.yml";
const MAX = 20 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function DocumentDetail({ document }: { document: DocumentRecord }) {
  const client = useQueryClient();
  const [reading, setReading] = useState(false);
  const text = useQuery({ queryKey: ["document-text", document.id], queryFn: () => api.documentText(document.id), enabled: reading });
  const remove = useMutation({
    mutationFn: () => api.deleteDocument(document.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["documents"] }),
  });
  return (
    <div className="tile min-w-0 rounded-lg bg-panel p-4 text-[13px]">
      <h3 className="text-[16px] font-semibold">{document.filename}</h3>
      <div className="mt-1 flex items-center gap-2">
        <Tag tone={document.parseStatus === "ready" ? "green" : document.parseStatus === "failed" ? "red" : "yellow"}>
          {document.parseStatus === "ready" ? "Ready" : document.parseStatus}
        </Tag>
        {document.enrichmentStatus !== "skipped" ? (
          <Tag tone={summaryTagTone(document.enrichmentStatus)}>summary: {document.enrichmentStatus}</Tag>
        ) : null}
      </div>
      <div className="mt-3 space-y-1 text-[12.5px] text-muted">
        <div>
          {document.format.toUpperCase()} | {document.byteSize.toLocaleString()} bytes | {document.textCharacters.toLocaleString()} text characters
        </div>
        <div>Uploaded {dateTime(document.createdAt)} | Parser: ensemble-documents/1</div>
        <div className="break-all font-mono text-[11.5px]">SHA-256: {document.sha256}</div>
        {document.warnings.map((warning) => (
          <div key={warning} className="text-warn">
            {warning}
          </div>
        ))}
      </div>
      <h4 className="mt-4 font-semibold">Model summary</h4>
      <p className={`mt-1 leading-5 ${document.enrichmentStatus === "failed" ? "text-danger" : "text-ink/85"}`}>
        {documentSummaryLine(document)}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a href={api.documentUrl(document.id)} className="btn">
          <Download size={13} /> Download original
        </a>
        <button type="button" className="btn" onClick={() => setReading(true)} disabled={!document.textCharacters}>
          <BookOpenText size={13} /> Read text
        </button>
        <button type="button" className="btn" onClick={() => remove.mutate()}>
          <Trash2 size={13} /> Remove
        </button>
      </div>
      <Dialog open={reading} onClose={() => setReading(false)} title={document.filename} width={760}>
        {text.isLoading ? <Spinner /> : <pre className="whitespace-pre-wrap text-[12.5px] leading-5">{text.data?.text}</pre>}
      </Dialog>
    </div>
  );
}

export function ArtifactsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [summarize, setSummarize] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const documents = useQuery({ queryKey: ["documents", search], queryFn: () => api.documents(search || undefined) });
  const artifacts = useQuery({ queryKey: ["artifacts", "sync"], queryFn: () => api.artifacts({}) });

  const upload = useMutation({
    mutationFn: async () => {
      for (const file of files) {
        if (file.size > MAX) throw new Error(`${file.name} is over 20 MiB.`);
        await api.uploadDocument({
          filename: file.name,
          mediaType: file.type || "application/octet-stream",
          dataBase64: await toBase64(file),
          summarize,
        });
      }
    },
    onSuccess: () => {
      toast(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}.`, { tone: "ok" });
      setFiles([]);
      void client.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const list = documents.data?.documents ?? [];
  const selected = list.find((row) => row.id === selectedId) ?? list[0];

  return (
    <div className="space-y-6">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          setFiles(Array.from(event.dataTransfer.files));
        }}
        className={cx("tile rounded-lg border-dashed bg-panel p-5", dragging && "border-accent bg-accent-soft")}
      >
        <h3 className="text-[18px] font-semibold">Document library</h3>
        <p className="mt-0.5 text-[13px] text-muted">Drop reference files here, then link them to your work.</p>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            <UploadCloud size={13} /> Choose files
          </button>
          <span className="text-[12.5px] text-muted">
            {files.length ? files.map((file) => `${file.name} (${bytes(file.size)})`).join(", ") : "No files chosen"}
          </span>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </div>
        <p className="mt-2 text-[12px] text-muted">
          DOCX, PPTX, PDF, Markdown, TXT and common text formats. Up to 20 MiB per file. No OCR or encrypted documents.
        </p>
        <label className="mt-2 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={summarize} onChange={(event) => setSummarize(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" />
          Summarize and suggest tags with AI
        </label>
        <p className="ml-6 text-[12px] text-faint">Optional · one bounded model request per document attempt</p>
        <button type="button" className="btn-primary mt-3" disabled={!files.length || upload.isPending} onClick={() => upload.mutate()}>
          {upload.isPending ? <Spinner /> : null}
          Upload
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1">
          <Search size={13} className="text-faint" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search uploaded filenames"
            className="search-line w-56 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </div>
        <button type="button" className="btn" onClick={() => void client.invalidateQueries({ queryKey: ["documents"] })}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {documents.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>No documents yet.</Empty>
      ) : (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4">
          <div className="space-y-2">
            {list.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelectedId(row.id)}
                data-active={row.id === selected?.id || undefined}
                className="tile block w-full rounded-md bg-panel px-3 py-2 text-left text-[12.5px]"
              >
                <div className="text-[13px] font-semibold leading-4">{row.filename}</div>
                <div className="mt-1 text-muted">{row.parseStatus === "ready" ? "Ready" : row.parseStatus}</div>
                {row.enrichmentStatus === "failed" ? <div className="text-danger">Summary failed</div> : null}
                <div className="text-faint">{bytes(row.byteSize)}</div>
              </button>
            ))}
          </div>
          {selected ? <DocumentDetail document={selected} /> : null}
        </div>
      )}

      <section>
        <h3 className="mb-2 text-[15px] font-semibold">Sync</h3>
        {(artifacts.data?.sync ?? []).length === 0 ? (
          <Empty>No source has synced yet.</Empty>
        ) : (
          <div className="divide-y divide-[var(--line)] rounded-md border border-line text-[13px]">
            {artifacts.data!.sync.map((row) => (
              <div key={row.connector} className="flex items-center justify-between px-3 py-2">
                <span className="font-medium">{row.connector}</span>
                <span className={row.lastError ? "text-[#ffb4ae]" : "text-muted"}>
                  {row.lastError ?? `${plural(row.itemCount, "item")} · ${relative(row.lastSyncAt)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
