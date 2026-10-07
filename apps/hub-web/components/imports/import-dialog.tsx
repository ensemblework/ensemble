"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FileUp, Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, type TaskStatus } from "@/lib/api";
import {
  ACTIVE_IMPORT,
  importsApi,
  type CsvField,
  type ImportAs,
  type ImportCredentials,
  type ImportJobRecord,
  type ImportPreview,
  type ImportSourceInfo,
} from "@/lib/api-imports";
import { BrandLogo } from "../connectors/brand-logo";
import { Dialog, cx } from "../ui";
import { ImportSummary, plural, summaryTitle } from "./import-summary";

type Step = "source" | "connect" | "choose" | "review" | "progress" | "summary";

export const STATUS_CHOICES: Array<{ value: TaskStatus; label: string }> = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
  { value: "proposed", label: "Proposed" },
];

const FIELD_LABEL: Partial<Record<CsvField, string>> = {
  title: "Title",
  due: "Due date",
  start: "Start date",
  labels: "Labels / tags",
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  description: "Description",
  project: "Project",
  url: "Link",
  id: "ID (for re-runs)",
  done: "Done checkbox",
};

const FILE_ACCEPT: Record<string, string> = { zip: ".zip", csv: ".csv,.txt", tsv: ".tsv,.txt", json: ".json" };

function message(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

/** The import flow in a dialog: pick an app, connect or upload, choose, review, watch it run, undo if needed. */
export function ImportDialog({ open, onClose, initialSource }: { open: boolean; onClose: () => void; initialSource?: string }) {
  return (
    <Dialog open={open} onClose={onClose} title="Import from other apps" width={680}>
      {open ? <ImportFlow initialSource={initialSource} onClose={onClose} /> : null}
    </Dialog>
  );
}

function StepHeading({ children, step }: { children: React.ReactNode; step: Step }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [step]);
  return (
    <h4 ref={ref} tabIndex={-1} className="mb-1 text-[14px] font-semibold outline-none">
      {children}
    </h4>
  );
}

export function ImportFlow({ initialSource, onClose }: { initialSource?: string; onClose: () => void }) {
  const client = useQueryClient();
  const [step, setStep] = useState<Step>("source");
  const [sources, setSources] = useState<ImportSourceInfo[] | null>(null);
  const [source, setSource] = useState<ImportSourceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
  const [importAs, setImportAs] = useState<Record<string, ImportAs>>({});
  const [columns, setColumns] = useState<Record<string, Partial<Record<CsvField, string[]>>>>({});
  const [job, setJob] = useState<ImportJobRecord | null>(null);

  useEffect(() => {
    let live = true;
    importsApi
      .sources()
      .then(({ sources: list }) => {
        if (!live) return;
        setSources(list);
        const wanted = initialSource ? list.find((entry) => entry.id === initialSource || entry.connectorId === initialSource) : undefined;
        if (wanted) {
          setSource(wanted);
          setStep("connect");
        }
      })
      .catch((caught) => live && setError(message(caught)));
    return () => {
      live = false;
    };
  }, [initialSource]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const applyPreview = useCallback((next: ImportPreview, keepChoices = false) => {
    setPreview(next);
    setStatusMap((current) => {
      const out: Record<string, TaskStatus> = keepChoices ? { ...current } : {};
      for (const status of next.mapping.statuses) {
        const key = status.value.toLowerCase();
        if (!(key in out)) out[key] = status.proposed;
      }
      return out;
    });
    if (!keepChoices) {
      setImportAs(Object.fromEntries(next.containers.map((container) => [container.id, container.importAs])));
      setColumns(Object.fromEntries(next.mapping.tables.map((table) => [table.containerId, table.columns])));
    }
  }, []);

  const connected = useCallback(
    (next: ImportPreview) => {
      applyPreview(next);
      const all = next.containers.map((container) => container.id);
      if (next.via === "file") {
        setSelected(all);
        setStep(all.length === 1 ? "review" : "choose");
      } else {
        setSelected(all.length <= 5 ? all : []);
        setStep("choose");
      }
    },
    [applyPreview],
  );

  const review = () =>
    run(async () => {
      if (!preview) return;
      const next = await importsApi.refine(preview.previewId, selected, preview.via === "file" ? { columns } : { options: { includeCompleted } });
      applyPreview(next, true);
      setStep("review");
    });

  const start = () =>
    run(async () => {
      if (!preview) return;
      const result = await importsApi.start({
        previewId: preview.previewId,
        containers: selected,
        statusMap,
        importAs: Object.fromEntries(selected.map((id) => [id, importAs[id] ?? "tasks"])),
        ...(preview.via === "file" ? { columns } : { options: { includeCompleted } }),
      });
      setJob(result.job);
      setStep(ACTIVE_IMPORT.has(result.job.status) ? "progress" : "summary");
    });

  const jobId = job?.id;
  useEffect(() => {
    if (step !== "progress" || !jobId) return;
    let live = true;
    const timer = window.setInterval(() => {
      importsApi
        .job(jobId)
        .then(({ job: fresh }) => {
          if (!live) return;
          setJob(fresh);
          if (!ACTIVE_IMPORT.has(fresh.status)) {
            setStep("summary");
            void client.invalidateQueries();
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [step, jobId, client]);

  const back = () => {
    setError(null);
    if (step === "connect") {
      setSource(null);
      setPreview(null);
      setStep("source");
    } else if (step === "choose") setStep("connect");
    else if (step === "review") setStep(preview && preview.containers.length > 1 ? "choose" : "connect");
  };

  return (
    <div className="space-y-3 text-[13px]" data-import-step={step}>
      {step === "connect" || step === "choose" || step === "review" ? (
        <button type="button" className="btn-ghost -ml-1" onClick={back} disabled={busy}>
          <ArrowLeft size={13} aria-hidden /> Back
        </button>
      ) : null}
      {step === "source" ? (
        <SourceStep
          sources={sources}
          onPick={(picked) => {
            setSource(picked);
            setStep("connect");
          }}
        />
      ) : null}
      {step === "connect" && source ? (
        <ConnectStep
          source={source}
          busy={busy}
          onConnect={(credentials) => run(async () => connected(await importsApi.connect(source.id, credentials)))}
          onUpload={(file) => run(async () => connected(await importsApi.upload(source.id, file)))}
        />
      ) : null}
      {step === "choose" && preview ? (
        <ChooseStep
          preview={preview}
          selected={selected}
          onSelected={setSelected}
          includeCompleted={includeCompleted}
          onIncludeCompleted={setIncludeCompleted}
          busy={busy}
          onNext={review}
        />
      ) : null}
      {step === "review" && preview ? (
        <ReviewStep
          preview={preview}
          selected={selected}
          statusMap={statusMap}
          onStatusMap={setStatusMap}
          importAs={importAs}
          onImportAs={setImportAs}
          columns={columns}
          onColumns={(next) => {
            setColumns(next);
            void importsApi
              .refine(preview.previewId, selected, { columns: next })
              .then((fresh) => applyPreview(fresh, true))
              .catch((caught) => setError(message(caught)));
          }}
          busy={busy}
          onStart={start}
        />
      ) : null}
      {step === "progress" && job ? (
        <ProgressStep
          job={job}
          onCancel={() =>
            void importsApi
              .cancel(job.id)
              .then(({ job: fresh }) => setJob(fresh))
              .catch((caught) => setError(message(caught)))
          }
        />
      ) : null}
      {step === "summary" && job ? (
        <>
          <StepHeading step={step}>{summaryTitle(job)}</StepHeading>
          <ImportSummary
            job={job}
            onChange={(fresh) => {
              setJob(fresh);
              void client.invalidateQueries();
            }}
            onNavigate={onClose}
          />
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-line px-3 py-2 text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SourceStep({ sources, onPick }: { sources: ImportSourceInfo[] | null; onPick: (source: ImportSourceInfo) => void }) {
  return (
    <div>
      <StepHeading step="source">Where are you coming from?</StepHeading>
      <p className="mb-3 text-muted">
        Bring tasks, due dates, tags, status, people and pages across. Running an import again updates what came over instead of adding copies.
      </p>
      {!sources ? (
        <p className="flex items-center gap-2 text-muted" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Loading sources…
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Apps you can import from">
          {sources.map((entry) => (
            <li key={entry.id}>
              <button type="button" className="tile flex w-full items-center gap-2.5 p-2.5 text-left" onClick={() => onPick(entry)}>
                <BrandLogo id={entry.logo} name={entry.name} size={28} decorative />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{entry.name}</span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {entry.connected ? "Connected" : entry.api && entry.files.length ? "Token or export" : entry.api ? "Token" : "Upload a file"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TOKEN_FIELD_LABEL = { email: "Atlassian account email", site: "Jira site (yourteam.atlassian.net)", key: "Trello API key" } as const;

function ConnectStep({
  source,
  busy,
  onConnect,
  onUpload,
}: {
  source: ImportSourceInfo;
  busy: boolean;
  onConnect: (credentials?: ImportCredentials) => void;
  onUpload: (file: File) => void;
}) {
  const [credentials, setCredentials] = useState<ImportCredentials>({});
  const [dragging, setDragging] = useState(false);
  const fileId = useId();
  const accept = source.files.map((format) => FILE_ACCEPT[format] ?? `.${format}`).join(",");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <BrandLogo id={source.logo} name={source.name} size={32} decorative />
        <StepHeading step="connect">Import from {source.name}</StepHeading>
      </div>
      {source.brings.length ? <p className="text-muted">Brings: {source.brings.join(" · ")}</p> : null}
      {source.api && source.connected ? (
        <div className="card flex flex-wrap items-center justify-between gap-2 p-3">
          <span>Your {source.name} account is connected.</span>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onConnect()}>
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null} Use connected account
          </button>
        </div>
      ) : null}
      {source.api ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (credentials.token?.trim()) onConnect(credentials);
          }}
        >
          <p className="font-medium">{source.connected ? "Or paste a token" : "Paste a token"}</p>
          {source.tokenHint ? (
            <p className="text-muted">
              {source.tokenHint}{" "}
              {source.tokenUrl ? (
                <a href={source.tokenUrl} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
                  Where to find it ↗
                </a>
              ) : null}
            </p>
          ) : null}
          {source.tokenFields.map((field) => (
            <label key={field} className="block">
              <span className="mb-1 block text-[12px] text-muted">{TOKEN_FIELD_LABEL[field]}</span>
              <input
                className="field w-full"
                value={credentials[field] ?? ""}
                autoComplete={field === "email" ? "email" : "off"}
                onChange={(event) => setCredentials((current) => ({ ...current, [field]: event.target.value }))}
              />
            </label>
          ))}
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">{source.name} token</span>
            <input
              className="field w-full"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={credentials.token ?? ""}
              onChange={(event) => setCredentials((current) => ({ ...current, token: event.target.value }))}
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-faint">Used for this import only. Ensemble does not save it.</span>
            <button type="submit" className="btn" disabled={busy || !credentials.token?.trim()}>
              Continue
            </button>
          </div>
        </form>
      ) : null}
      {source.files.length ? (
        <div className="space-y-2">
          <p className="font-medium">{source.api ? "Or upload an export" : "Upload an export"}</p>
          {source.exportHelp ? <p className="text-muted">{source.exportHelp}</p> : null}
          <label
            htmlFor={fileId}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong p-5 text-center text-muted",
              dragging && "border-accent bg-accent-soft text-ink",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file && !busy) onUpload(file);
            }}
          >
            {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <FileUp size={18} aria-hidden />}
            <span>{busy ? "Reading the file…" : `Drop the ${source.files.map((format) => `.${format}`).join(" or ")} file here, or choose it`}</span>
            <span className="text-[11.5px] text-faint">Up to 50 MB</span>
          </label>
          <input
            id={fileId}
            type="file"
            accept={accept}
            className="sr-only"
            aria-label={`Upload a ${source.name} export`}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
              event.target.value = "";
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ChooseStep({
  preview,
  selected,
  onSelected,
  includeCompleted,
  onIncludeCompleted,
  busy,
  onNext,
}: {
  preview: ImportPreview;
  selected: string[];
  onSelected: (ids: string[]) => void;
  includeCompleted: boolean;
  onIncludeCompleted: (value: boolean) => void;
  busy: boolean;
  onNext: () => void;
}) {
  const all = preview.containers.map((container) => container.id);
  const allOn = selected.length === all.length;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !allOn;
  }, [selected.length, allOn]);
  return (
    <div className="space-y-3">
      <StepHeading step="choose">Choose what to import</StepHeading>
      <fieldset className="space-y-1">
        <legend className="sr-only">{preview.sourceLabel} items to import</legend>
        <label className="flex items-center gap-2 border-b border-line pb-2 font-medium">
          <input ref={selectAll} type="checkbox" checked={allOn} onChange={() => onSelected(allOn ? [] : all)} className="accent-[rgb(var(--accent-rgb))]" />
          Select all ({preview.containers.length})
        </label>
        <div className="max-h-[38vh] space-y-0.5 overflow-auto pr-1">
          {preview.containers.map((container) => {
            const on = selected.includes(container.id);
            return (
              <label key={container.id} className="row-tile flex items-center gap-2 rounded px-1.5 py-1">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onSelected(on ? selected.filter((id) => id !== container.id) : [...selected, container.id])}
                  className="accent-[rgb(var(--accent-rgb))]"
                />
                <span className="min-w-0 flex-1 truncate">{container.name}</span>
                {container.parent ? <span className="truncate text-[11.5px] text-faint">{container.parent}</span> : null}
                <span className="shrink-0 text-[12px] text-muted">{container.count === null ? "" : plural(container.count, "item")}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {preview.via !== "file" ? (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeCompleted} onChange={(event) => onIncludeCompleted(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" />
          Include completed items
        </label>
      ) : null}
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={busy || !selected.length} onClick={onNext}>
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null} Review
        </button>
      </div>
    </div>
  );
}

function ReviewStep({
  preview,
  selected,
  statusMap,
  onStatusMap,
  importAs,
  onImportAs,
  columns,
  onColumns,
  busy,
  onStart,
}: {
  preview: ImportPreview;
  selected: string[];
  statusMap: Record<string, TaskStatus>;
  onStatusMap: (value: Record<string, TaskStatus>) => void;
  importAs: Record<string, ImportAs>;
  onImportAs: (value: Record<string, ImportAs>) => void;
  columns: Record<string, Partial<Record<CsvField, string[]>>>;
  onColumns: (value: Record<string, Partial<Record<CsvField, string[]>>>) => void;
  busy: boolean;
  onStart: () => void;
}) {
  const chosen = preview.containers.filter((container) => selected.includes(container.id));
  const tables = preview.mapping.tables.filter((table) => selected.includes(table.containerId));
  const choosable = preview.source === "notion" || preview.via === "file";
  const total = useMemo(() => {
    if (preview.via === "file" && preview.summary.items !== null) return preview.summary.items;
    return chosen.every((container) => container.count !== null) ? chosen.reduce((sum, container) => sum + (container.count ?? 0), 0) : null;
  }, [preview, chosen]);
  const fields = (Object.keys(FIELD_LABEL) as CsvField[]).filter((field) => preview.mapping.fields.includes(field));
  const nameOf = (id: string) => chosen.find((container) => container.id === id)?.name ?? "file";
  return (
    <div className="space-y-4">
      <StepHeading step="review">Check how it comes across</StepHeading>
      {preview.formatLabel ? (
        <p className="text-muted">
          Read as {preview.formatLabel}
          {preview.fileName ? ` (${preview.fileName})` : ""}.
        </p>
      ) : null}

      {tables.map((table) => (
        <section key={table.containerId} aria-label={`Columns for ${nameOf(table.containerId)}`} className="space-y-1.5">
          <h5 className="font-medium">
            Columns{tables.length > 1 ? ` · ${nameOf(table.containerId)}` : ""} <span className="font-normal text-muted">({table.presetLabel})</span>
          </h5>
          <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {fields.map((field) => {
              const current = columns[table.containerId]?.[field] ?? [];
              return (
                <label key={field} className="flex items-center justify-between gap-2">
                  <span className="text-muted">{FIELD_LABEL[field]}</span>
                  <select
                    className="field w-[55%] py-0.5"
                    value={current[0] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      const next = { ...(columns[table.containerId] ?? {}) };
                      if (value) next[field] = [value];
                      else delete next[field];
                      onColumns({ ...columns, [table.containerId]: next });
                    }}
                  >
                    <option value="">Not imported</option>
                    {table.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </section>
      ))}

      {preview.mapping.statuses.length ? (
        <section aria-label="Status mapping" className="space-y-1.5">
          <h5 className="font-medium">Status</h5>
          <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {preview.mapping.statuses.map((status) => {
              const key = status.value.toLowerCase();
              return (
                <label key={key} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {status.value} <span className="text-faint">({status.count})</span>
                  </span>
                  <select
                    className="field w-[50%] py-0.5"
                    aria-label={`Ensemble status for ${status.value}`}
                    value={statusMap[key] ?? status.proposed}
                    onChange={(event) => onStatusMap({ ...statusMap, [key]: event.target.value as TaskStatus })}
                  >
                    {STATUS_CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          {preview.summary.sampled ? (
            <p className="text-[12px] text-faint">From a sample. Other values are matched by name (done, closed and resolved count as done).</p>
          ) : null}
        </section>
      ) : null}

      {choosable ? (
        <section aria-label="Import as" className="space-y-1.5">
          <h5 className="font-medium">Import as</h5>
          {chosen.map((container) => (
            <label key={container.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{container.name}</span>
              <select
                className="field w-[50%] py-0.5"
                aria-label={`Import ${container.name} as`}
                value={importAs[container.id] ?? container.importAs}
                onChange={(event) => onImportAs({ ...importAs, [container.id]: event.target.value as ImportAs })}
              >
                <option value="tasks">Tasks on the board</option>
                <option value="pages">Pages</option>
              </select>
            </label>
          ))}
        </section>
      ) : null}

      {preview.samples.length ? (
        <section aria-label="Sample" className="space-y-1.5">
          <h5 className="font-medium">Sample</h5>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-muted">
                <tr>
                  <th scope="col" className="px-2 py-1 font-medium">Title</th>
                  <th scope="col" className="px-2 py-1 font-medium">Status</th>
                  <th scope="col" className="px-2 py-1 font-medium">Due</th>
                  <th scope="col" className="px-2 py-1 font-medium">Labels</th>
                  <th scope="col" className="px-2 py-1 font-medium">Project</th>
                </tr>
              </thead>
              <tbody>
                {preview.samples.map((row, index) => (
                  <tr key={`${row.containerId}-${index}`} className="border-t border-line">
                    <td className="max-w-[220px] truncate px-2 py-1">{row.title}</td>
                    <td className="px-2 py-1 text-muted">{row.status ?? "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-muted">{row.due ? row.due.slice(0, 10) : "—"}</td>
                    <td className="max-w-[160px] truncate px-2 py-1 text-muted">{row.labels.join(", ") || "—"}</td>
                    <td className="max-w-[140px] truncate px-2 py-1 text-muted">{row.project ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-faint">Running this again later updates these items instead of adding copies.</span>
        <button type="button" className="btn-primary" disabled={busy || !selected.length} onClick={onStart}>
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
          {total !== null ? `Import ${plural(total, "item")}` : "Start import"}
        </button>
      </div>
    </div>
  );
}

function ProgressStep({ job, onCancel }: { job: ImportJobRecord; onCancel: () => void }) {
  const { written, fetched, total } = job.progress;
  const max = total && total >= written ? total : null;
  const percent = max ? Math.min(100, Math.round((written / Math.max(max, 1)) * 100)) : null;
  return (
    <div className="space-y-3">
      <StepHeading step="progress">Importing from {job.sourceLabel}…</StepHeading>
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
        aria-valuenow={max ? written : undefined}
        aria-valuetext={max ? `${written} of ${max}` : `${written} imported`}
        className="h-2 w-full overflow-hidden rounded-full bg-line"
      >
        <div className={cx("h-full bg-accent transition-[width]", percent === null && "animate-pulse")} style={{ width: `${percent ?? 35}%` }} />
      </div>
      <p aria-live="polite" className="text-muted">
        {max ? `${written.toLocaleString()} of ${max.toLocaleString()} done` : `${written.toLocaleString()} done, ${fetched.toLocaleString()} read`}
        {job.status === "cancelling" ? " · stopping after this batch…" : ""}
      </p>
      <p className="text-[12px] text-faint">You can close this window. The import keeps going and shows under Recent imports.</p>
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onCancel} disabled={job.status === "cancelling"}>
          Cancel import
        </button>
      </div>
    </div>
  );
}
