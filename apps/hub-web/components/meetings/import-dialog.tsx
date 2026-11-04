"use client";

import { useMutation } from "@tanstack/react-query";
import { CalendarDays, FileText, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ImportedMeetingNote } from "@/lib/api-connected";
import { meetingsApi, type TranscriptPreview, type TranscriptSource } from "@/lib/api-meetings";
import { Dialog, InfoTip, Segmented, Spinner } from "../ui";
import { useToast } from "../toast";
import { meetingWhen } from "./meeting-time";
import { speakerTones } from "./transcript-view";

export type ImportMode = "upload" | "paste";

export type ImportTarget = {
  mode: ImportMode;
  /** The calendar meeting this transcript is for. */
  event?: { id: string; title: string; start: string } | null;
  /** Coming from a Teams meeting whose transcript can only be copied: show how. */
  guide?: "teams" | null;
};

const ACCEPT = ".vtt,.srt,.txt,.docx,.json,.md,text/vtt,text/plain,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIB = 1024 * 1024;

/** "2026-11-03T15:03" for a datetime-local input, in the browser's time zone. */
function localInput(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function TeamsCopySteps() {
  return (
    <ol className="import-steps">
      <li>In Teams, open the meeting from your calendar or its chat, then <b>Recap</b> → <b>Transcript</b>.</li>
      <li>Click inside the transcript, press <kbd className="kbd">Ctrl</kbd>/<kbd className="kbd">⌘</kbd> + <kbd className="kbd">A</kbd>, then copy.</li>
      <li>Paste it below. Names and times like “Mira Chen 0:03” become speakers and timestamps.</li>
    </ol>
  );
}

/**
 * Upload or paste a transcript (Teams, Zoom, Google Meet, Otter, Fireflies, tl;dv, captions), check
 * what Ensemble read, then save it as a meeting note. Nothing is sent to a model.
 */
export function TranscriptImportDialog({ target, fileLimit, onClose, onImported }: { target: ImportTarget; fileLimit: number; onClose: () => void; onImported: (note: ImportedMeetingNote) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<ImportMode>(target.mode);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<TranscriptPreview | null>(null);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [addPeople, setAddPeople] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const whenId = useId();
  const source: TranscriptSource | null = mode === "upload" ? (file ? { file } : null) : text.trim() ? { text } : null;

  const read = useMutation({
    mutationFn: (from: TranscriptSource) => meetingsApi.preview(from),
    onSuccess: (result) => {
      setPreview(result);
      setTitle(target.event?.title ?? result.title ?? (file ? file.name.replace(/\.[a-z0-9]+$/i, "") : ""));
      setWhen(localInput(target.event?.start ?? result.startedAt));
      setAddPeople(new Set(result.speakers.filter((row) => !row.me && !row.person && /\s/.test(row.name) && !/^speaker\b/i.test(row.name)).map((row) => row.name)));
    },
  });
  const save = useMutation({
    mutationFn: () =>
      meetingsApi.importTranscript(source!, {
        title: title.trim() || undefined,
        occurredAt: when ? new Date(when).toISOString() : null,
        eventId: target.event?.id ?? null,
        addPeople: [...addPeople],
      }),
    onSuccess: (note) => {
      toast(`Imported “${note.title}”.`);
      onImported(note);
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  useEffect(() => {
    setPreview(null);
    read.reset();
    // Switching between upload and paste starts over.
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (chosen: File | null | undefined) => {
    if (!chosen) return;
    if (chosen.size > fileLimit) {
      toast(`That file is ${(chosen.size / MIB).toFixed(1)} MB. Transcripts up to ${Math.round(fileLimit / MIB)} MB can be imported.`, { tone: "error" });
      return;
    }
    setFile(chosen);
    setPreview(null);
    read.mutate({ file: chosen });
  };

  const tones = preview ? speakerTones(preview.sample) : new Map<string, string>();
  const heading = target.event ? `Transcript for “${target.event.title}”` : mode === "upload" ? "Upload a transcript" : "Paste a transcript";

  return (
    <Dialog open onClose={onClose} title={heading} width={620} bodyClassName="import-dialog">
      {target.event ? (
        <p className="import-event"><CalendarDays size={14} aria-hidden />Linked to {target.event.title} · {meetingWhen(target.event.start)}</p>
      ) : null}
      {!preview ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented label="How to add it" value={mode} onChange={setMode} options={[{ id: "upload", label: "Upload a file" }, { id: "paste", label: "Paste text" }]} />
            <InfoTip
              label="Which transcripts work"
              text={
                <>
                  Teams (.vtt, .docx, or copied from the transcript panel), Zoom (.vtt, saved .txt), Google Meet (the transcript Doc as .docx or .txt), Otter (.txt, .srt, .docx), Fireflies and tl;dv JSON exports, and any .vtt, .srt or “Name: words” text. Ensemble reads them as they are; nothing is sent to a model.
                </>
              }
            />
          </div>
          {mode === "upload" ? (
            <div
              className="import-drop"
              data-dragging={dragging || undefined}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); pick(event.dataTransfer.files[0]); }}
            >
              <Upload size={20} aria-hidden />
              <p className="font-medium">{file ? file.name : "Drop a transcript file here"}</p>
              <p className="text-[12.5px] text-muted">.vtt · .srt · .docx · .txt · .json, up to {Math.round(fileLimit / MIB)} MB</p>
              <button type="button" className="btn mt-1" onClick={() => input.current?.click()}>{file ? "Choose another file" : "Choose a file"}</button>
              <input ref={input} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ""; }} />
            </div>
          ) : (
            <>
              {target.guide === "teams" ? <TeamsCopySteps /> : (
                <details className="import-guide">
                  <summary>How to copy a transcript from Teams</summary>
                  <TeamsCopySteps />
                </details>
              )}
              <label className="sr-only" htmlFor={`${titleId}-paste`}>Transcript text</label>
              <textarea
                id={`${titleId}-paste`}
                className="field import-paste"
                rows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"Mira Chen  0:03\nOkay, let's get started.\n\nArjun Rao  0:10\nThe import fix is on staging."}
                autoFocus
              />
            </>
          )}
          {read.isError ? <p className="import-error" role="alert">{(read.error as Error).message}</p> : null}
          <div className="import-footer">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            {mode === "paste" ? (
              <button type="button" className="btn-primary" disabled={!source || read.isPending} onClick={() => source && read.mutate(source)}>
                {read.isPending ? <><Spinner size={13} />Reading…</> : "Read transcript"}
              </button>
            ) : read.isPending ? (
              <span className="inline-flex items-center gap-2 text-[13px] text-muted"><Spinner size={13} />Reading…</span>
            ) : null}
          </div>
        </>
      ) : (
        <div className="import-review">
          <div className="import-found">
            <FileText size={16} aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">{preview.formatLabel}</p>
              <p className="text-[12.5px] text-muted">
                {preview.lineCount.toLocaleString()} turns · {preview.speakers.length} {preview.speakers.length === 1 ? "speaker" : "speakers"}
                {preview.durationMinutes ? ` · ${preview.durationMinutes} min` : ""}
                {preview.actionItems ? ` · ${preview.actionItems} action ${preview.actionItems === 1 ? "item" : "items"}` : ""}
                {preview.decisions ? ` · ${preview.decisions} ${preview.decisions === 1 ? "decision" : "decisions"}` : ""}
              </p>
            </div>
          </div>
          <div className="import-fields">
            <label className="block" htmlFor={titleId}>
              <span className="import-label">Title</span>
              <input id={titleId} className="field w-full" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
            </label>
            <label className="block" htmlFor={whenId}>
              <span className="import-label">When{preview.startedAt || target.event ? "" : " (not in the file)"}</span>
              <input id={whenId} type="datetime-local" className="field w-full" value={when} onChange={(event) => setWhen(event.target.value)} />
            </label>
          </div>
          {preview.speakers.length ? (
            <fieldset className="import-speakers">
              <legend className="import-label">Speakers</legend>
              <ul>
                {preview.speakers.map((speaker) => (
                  <li key={speaker.name}>
                    <span className="truncate">{speaker.name}</span>
                    <span className="text-[12px] text-muted">{speaker.turns} {speaker.turns === 1 ? "turn" : "turns"}</span>
                    {speaker.me ? (
                      <span className="import-speaker-state">You</span>
                    ) : speaker.person ? (
                      <span className="import-speaker-state" data-matched>In People</span>
                    ) : (
                      <label className="import-speaker-add">
                        <input
                          type="checkbox"
                          checked={addPeople.has(speaker.name)}
                          onChange={(event) => setAddPeople((current) => { const next = new Set(current); if (event.target.checked) next.add(speaker.name); else next.delete(speaker.name); return next; })}
                        />
                        Add to People
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
          <div className="import-sample" aria-label="First lines">
            {preview.sample.slice(0, 3).map((line, index) => (
              <p key={index}>
                {line.at ? <time>{line.at}</time> : null}
                {line.speaker ? <b style={{ color: tones.get(line.speaker) }}>{line.speaker}</b> : null}
                <span>{line.text.length > 180 ? `${line.text.slice(0, 180)}…` : line.text}</span>
              </p>
            ))}
          </div>
          {preview.warnings.map((warning) => <p key={warning} className="import-warning">{warning}</p>)}
          <div className="import-footer">
            <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>Back</button>
            <button type="button" className="btn-primary" disabled={save.isPending || !source} onClick={() => save.mutate()}>
              {save.isPending ? <><Spinner size={13} />Importing…</> : "Import meeting"}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
